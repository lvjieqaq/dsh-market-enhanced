/**
 * HTTP routes bridging the browser market UI to the host: registry fallback,
 * installed-plugin listing, and the install executor.
 *
 * Security: the install route executes a shell command, so it accepts only
 * same-origin POSTs and only sources present in the curated registry.
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { loadRegistry } from './registry.ts'
import {
  cleanHotDir, hotMount, hotUnmount, listHotMounts,
  mountClientOnlyDeps, readDisabledThemes, writeDisabledThemes,
} from './hot.ts'
import { exportLogs, logEvent } from './log.ts'

export interface WebServerService {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  }): () => void
}

/** The slice of a cordis loader entry the market needs for live enable/disable. */
export interface LoaderEntry {
  id?: string
  disabled?: boolean
  options: { id?: string; name?: string; disabled?: boolean | null; group?: boolean }
  fiber?: unknown
  update(options: { disabled: boolean | null }, create?: boolean, force?: boolean): Promise<void>
}

export interface MarketHost {
  webServer: WebServerService
  loader: { entries(): Iterable<LoaderEntry> }
  plugin(plugin: unknown, config: unknown): { await(): Promise<unknown>; dispose(): Promise<unknown> | void }
  on?(event: string, callback: (fiber: { entry?: { options?: { name?: string } } }) => void): () => void
  logger?: { info?(message: string): void; warn(message: string): void }
}

export interface MarketConfig {
  /** Profile the market installs into; matches the profile serving this UI. */
  profile: string
}

const PROFILE_RE = /^[A-Za-z0-9_-]+$/
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Argv re-invoking the CLI that launched this host process, so installs work
 * whether dsh runs from a global bin, a local install, or repo source
 * (`node --import tsx/esm .../bin.ts`). Falls back to a PATH `dsh`.
 *
 * Installs run through node:child_process, not ctx.shell: the shell service is
 * the agent's sandboxed executor and denies writes to the profile directory.
 */
function dshArgv(): { file: string; args: string[]; cwd: string | undefined; viaShell: boolean } {
  const entry = process.argv[1]
  if (entry !== undefined && /[\\/](?:bin\.(?:js|ts)|dsh)$/.test(entry)) {
    // Absolute paths are required: source launches (`pnpm dsh`) pass a
    // relative entry, which the child resolves against its OWN cwd and dies
    // with MODULE_NOT_FOUND (#13). cwd near the entry keeps execArgv imports
    // (tsx/esm) resolvable on source launches.
    const abs = resolve(entry)
    return { file: process.execPath, args: [...process.execArgv, abs], cwd: dirname(abs), viaShell: false }
  }
  // Bare `dsh` is a .cmd shim on Windows that only a shell can start (#13).
  return { file: 'dsh', args: [], cwd: undefined, viaShell: winCmdShim }
}

interface InstallResult {
  exitCode: number | null
  timedOut: boolean
  stdout: string
  stderr: string
}

/** Whether `pnpm` resolves on PATH; success is cached, absence is re-probed. */
let pnpmReady = false

/**
 * Windows npm/corepack/pnpm are `.cmd` shims. Node's `spawn` without a shell
 * cannot start them (ENOENT / EINVAL). Same pattern as dsh's `plugin` forwarder.
 */
const winCmdShim = process.platform === 'win32'

/**
 * Kill a spawned child and, on Windows, its whole process tree — `kill()`
 * there only terminates the wrapper, leaving pnpm children running.
 * (Contributed in #7 by @mraing.)
 */
function killChild(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
      return
    } catch { /* fall through */ }
  }
  child.kill('SIGKILL')
}

function probePnpm(): Promise<boolean> {
  if (pnpmReady) return Promise.resolve(true)
  return new Promise((resolvePromise) => {
    const child = spawn('pnpm', ['--version'], { stdio: 'ignore', shell: winCmdShim })
    child.on('error', () => resolvePromise(false))
    child.on('close', (code) => {
      pnpmReady = code === 0
      resolvePromise(pnpmReady)
    })
  })
}

function runQuiet(file: string, args: string[], timeoutMs: number): Promise<{ code: number | null; output: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(file, args, {
      env: { ...process.env, CI: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: winCmdShim,
    })
    let output = ''
    const timer = setTimeout(() => killChild(child), timeoutMs)
    const collect = (chunk: Buffer): void => { output = (output + chunk.toString()).slice(-8 * 1024) }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.on('error', (error) => { clearTimeout(timer); resolvePromise({ code: 127, output: error.message }) })
    child.on('close', (code) => { clearTimeout(timer); resolvePromise({ code, output }) })
  })
}

/**
 * Provision pnpm without user involvement: corepack (ships with Node) first,
 * a global npm install as fallback.
 * @returns true when `pnpm --version` succeeds afterwards.
 */
async function provisionPnpm(): Promise<boolean> {
  const corepack = await runQuiet('corepack', ['enable', 'pnpm'], 60 * 1000)
  logEvent(corepack.code === 0 ? 'info' : 'warn', 'setup-pnpm', `corepack enable: exit=${String(corepack.code)} ${corepack.output.slice(-200)}`)
  if (await probePnpm()) return true
  const npm = await runQuiet('npm', ['install', '-g', 'pnpm'], 3 * 60 * 1000)
  logEvent(npm.code === 0 ? 'info' : 'error', 'setup-pnpm', `npm -g: exit=${String(npm.code)} ${npm.output.slice(-200)}`)
  return probePnpm()
}

/** Live progress of the running plugin command, for the status route. */
interface InstallProgress {
  active: boolean
  target: string
  startedAt: number
  lastLine: string
}

const progress: InstallProgress = { active: false, target: '', startedAt: 0, lastLine: '' }

/** Identifies this host process; the client scopes its pending-restart flags to it. */
const BOOT_ID = `${String(process.pid)}-${String(Date.now())}`

function trackProgress(chunk: string): void {
  const lines = chunk.split('\n').map(l => l.trim()).filter(l => l !== '')
  if (lines.length > 0) progress.lastLine = lines[lines.length - 1].slice(0, 200)
}

/**
 * Central allowlist for every spawn target, regardless of which route built
 * it (defense in depth on top of per-route validation — the win32 bare-dsh
 * fallback runs through a shell). Suggested in #16 by @anupamme.
 */
const TARGET_RE = /^[A-Za-z0-9@:./_#+-]+$/

function runDshPluginOnce(profile: string, pluginArgs: string[]): Promise<InstallResult> {
  const { file, args, cwd, viaShell } = dshArgv()
  const target = pluginArgs[pluginArgs.length - 1] ?? ''
  if (!TARGET_RE.test(target)) {
    logEvent('error', 'install', `unsafe plugin target rejected: ${JSON.stringify(target)}`)
    return Promise.resolve({ exitCode: 1, timedOut: false, stdout: '', stderr: `unsafe plugin target rejected: ${JSON.stringify(target)}` })
  }
  progress.active = true
  progress.target = target
  progress.startedAt = Date.now()
  progress.lastLine = ''
  return new Promise((resolvePromise) => {
    const child = spawn(file, [...args, 'plugin', '--profile', profile, ...pluginArgs], {
      cwd,
      // pnpm v10 blocks forever on a silent interactive prompt without a TTY
      // (observed on re-add over a pinned git spec); CI mode forces it to act
      // or fail instead of asking.
      env: {
        ...process.env,
        CI: 'true',
        // Fast-fail network tuning (belt and suspenders alongside the
        // profile's pnpm-workspace.yaml): GitHub-hosted installs used to
        // hang for minutes on ETIMEDOUT HEAD requests.
        npm_config_fetch_timeout: '15000',
        npm_config_fetch_retries: '1',
        npm_config_fetch_retry_maxtimeout: '20000',
        npm_config_fetch_retry_mintimeout: '5000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: viaShell,
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killChild(child)
    }, INSTALL_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stdout = (stdout + text).slice(-256 * 1024)
      trackProgress(text)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderr = (stderr + text).slice(-64 * 1024)
      trackProgress(text)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      progress.active = false
      resolvePromise({ exitCode: 127, timedOut: false, stdout, stderr: `${stderr}\n${error.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      progress.active = false
      resolvePromise({ exitCode: code, timedOut, stdout, stderr })
    })
  })
}

/**
 * Append missing `allowBuilds` keys to the profile's pnpm-workspace.yaml.
 * Line-based edit keeps the file's comments and layout intact; the
 * `allowBuilds:` block is created at the end when absent.
 * @param profile - profile name.
 * @param keys - allowlist keys (package names or name@version dep paths).
 * @returns true when the file changed.
 */
function appendAllowBuilds(profile: string, keys: string[]): boolean {
  const file = join(profileDir(profile), 'pnpm-workspace.yaml')
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch { /* workspace file missing — build from scratch */ }
  const missing = keys.filter(key => {
    const re = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*true\\s*$`, 'mu')
    return !re.test(text)
  })
  if (missing.length === 0) return false
  const lines = text.length === 0 ? [] : text.split('\n')
  const section = lines.findIndex(line => /^allowBuilds:\s*$/u.test(line))
  const block = missing.map(key => `  ${key}: true`).join('\n')
  if (section >= 0) {
    // Insert after the last `key: value` line of the section (stop at list
    // items or top-level keys so entries never leak into another block).
    let cursor = section + 1
    while (cursor < lines.length && /^ {2}[A-Za-z0-9@_./~-][^:]*:\s/u.test(lines[cursor] ?? '')) cursor += 1
    lines.splice(cursor, 0, block)
    writeFileSync(file, lines.join('\n'), 'utf8')
    return true
  }
  const tail = text.length === 0 || text.endsWith('\n') ? text : `${text}\n`
  writeFileSync(file, `${tail}allowBuilds:\n${block}\n`, 'utf8')
  return true
}

/**
 * Append missing `minimumReleaseAgeExclude` entries to the profile's
 * pnpm-workspace.yaml. Line-based edit keeps comments and layout intact; the
 * block is created at the end when absent.
 * @param profile - profile name.
 * @param keys - `name@version` entries to exclude from the age gate.
 * @returns true when the file changed.
 */
function appendMinimumReleaseAgeExclude(profile: string, keys: string[]): boolean {
  const file = join(profileDir(profile), 'pnpm-workspace.yaml')
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch { /* workspace file missing — build from scratch */ }
  const missing = keys.filter(key => {
    const re = new RegExp(`^\\s*-\\s*['"]?${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?\\s*$`, 'mu')
    return !re.test(text)
  })
  if (missing.length === 0) return false
  const lines = text.length === 0 ? [] : text.split('\n')
  const section = lines.findIndex(line => /^minimumReleaseAgeExclude:\s*$/u.test(line))
  const block = missing.map(key => `  - '${key}'`).join('\n')
  if (section >= 0) {
    // Insert after the last list item of the section.
    let cursor = section + 1
    while (cursor < lines.length && /^ {2}- /u.test(lines[cursor] ?? '')) cursor += 1
    lines.splice(cursor, 0, block)
    writeFileSync(file, lines.join('\n'), 'utf8')
    return true
  }
  const tail = text.length === 0 || text.endsWith('\n') ? text : `${text}\n`
  writeFileSync(file, `${tail}minimumReleaseAgeExclude:\n${block}\n`, 'utf8')
  return true
}

/**
 * Run one `dsh plugin` invocation with two automatic one-shot retries:
 *  - a git-hosted dependency rejected because its prepare script is not
 *    allowlisted (pnpm v10+) gets the exact key pnpm suggests appended to
 *    `allowBuilds`;
 *  - a version rejected by pnpm's minimumReleaseAge gate (24h default) gets
 *    the `name@version` appended to `minimumReleaseAgeExclude`.
 * @param profile - profile name.
 * @param pluginArgs - pnpm arguments for `dsh plugin`.
 * @param ageExclude - `name@version` entry to exclude from the age gate when
 *   the run fails with a minimumReleaseAge error.
 * @returns the (possibly retried) run result.
 */
function runDshPlugin(profile: string, pluginArgs: string[], ageExclude?: string): Promise<InstallResult> {
  return runDshPluginOnce(profile, pluginArgs).then(result => {
    if (result.exitCode === 0 || result.timedOut) return result
    const text = `${result.stderr ?? ''}\n${result.stdout ?? ''}`
    const hint = /allowBuilds:\s*\n\s+([^\s:]+):\s*true/u.exec(text)
    if (hint !== null) {
      const key = hint[1]
      if (/^[A-Za-z0-9@./_~-]{1,128}$/u.test(key)) {
        const allowed = appendAllowBuilds(profile, [key])
        logEvent('info', 'allow-builds', `${key}: ${allowed ? 'appended to allowBuilds, retrying' : 'already allowlisted, retrying'}`)
        return runDshPluginOnce(profile, pluginArgs)
      }
    }
    if (ageExclude !== undefined && /minimum.?release.?age|NO_MATURE_MATCHING|too fresh|immature/i.test(text)) {
      const excluded = appendMinimumReleaseAgeExclude(profile, [ageExclude])
      logEvent('info', 'min-release-age', `${ageExclude}: ${excluded ? 'appended to minimumReleaseAgeExclude, retrying' : 'already excluded, retrying'}`)
      return runDshPluginOnce(profile, pluginArgs)
    }
    return result
  })
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  const host = request.headers.host
  if (origin === undefined || host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 4096) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function profileDir(profile: string): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'profiles', profile)
}

/** Community dependencies of the profile (official in-box scope filtered out). */
function readInstalled(profile: string): Record<string, string> {
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir(profile), 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const installed: Record<string, string> = {}
    for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
      if (!name.startsWith('@deepseek-ai/')) installed[name] = spec
    }
    return installed
  } catch {
    return {}
  }
}

/** GitHub `owner/repo` for a registry URL, or null when it is not a GitHub repo URL. */
function repoOf(url: string): string | null {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+?)\/?$/.exec(url)
  if (m === null || !REPO_RE.test(m[1])) return null
  return m[1]
}

/** Pinned commit per `owner/repo` from the profile lockfile's codeload tarball URLs. */
function readLockCommits(profile: string): Map<string, string> {
  const commits = new Map<string, string>()
  try {
    const lock = readFileSync(join(profileDir(profile), 'pnpm-lock.yaml'), 'utf8')
    for (const m of lock.matchAll(/codeload\.github\.com\/([^/\s]+\/[^/\s]+)\/tar\.gz\/([0-9a-f]{40})/g)) {
      commits.set(m[1].toLowerCase(), m[2])
    }
  } catch { /* no lockfile — no git installs to report */ }
  return commits
}

/**
 * Some registry entries point at collection repos whose actual plugin lives
 * in a subdirectory — the root has no package.json, and pnpm installs the
 * bare fileset with exit 0. Detect that junk install, drop it, and re-add
 * each plugin subdirectory through pnpm's `#path:` selector.
 * @returns overall success (true when nothing needed retargeting).
 */
async function retargetCollections(profile: string, before: Set<string>, target: string): Promise<boolean> {
  if (!target.startsWith('github:')) return true
  const junk = Object.keys(readInstalled(profile)).filter(name => !before.has(name)
    && !existsSync(join(profileDir(profile), 'node_modules', name, 'package.json')))
  let allOk = true
  for (const name of junk) {
    const root = join(profileDir(profile), 'node_modules', name)
    let candidates: string[] = []
    try {
      candidates = readdirSync(root, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory() && /^[A-Za-z0-9_.-]+$/.test(dirent.name))
        .filter((dirent) => {
          try {
            const manifest = JSON.parse(readFileSync(join(root, dirent.name, 'package.json'), 'utf8')) as { dsh?: unknown }
            return manifest.dsh !== undefined
          } catch {
            return false
          }
        })
        .map(dirent => dirent.name)
        .slice(0, 5)
    } catch {
      candidates = []
    }
    logEvent('info', 'install', `${name}: collection repo (no root package.json); plugins inside: ${candidates.join(', ') || 'none'}`)
    await runDshPlugin(profile, ['remove', name])
    if (candidates.length === 0) {
      allOk = false
      continue
    }
    for (const sub of candidates) {
      const result = await runDshPlugin(profile, ['add', `${target}#path:${sub}`])
      if (result.exitCode !== 0 || result.timedOut) allOk = false
    }
  }
  return allOk
}

function readInstalledVersion(profile: string, name: string): string | null {
  try {
    const manifest = JSON.parse(
      readFileSync(join(profileDir(profile), 'node_modules', name, 'package.json'), 'utf8'),
    ) as { version?: string }
    return manifest.version ?? null
  } catch {
    return null
  }
}

export interface UpdateStatus {
  kind: 'github' | 'npm' | 'linked'
  version: string | null
  current: string | null
  latest: string | null
  updateAvailable: boolean
}

const UPDATES_TTL_MS = 30 * 60 * 1000
let updatesCache: { at: number; data: Record<string, UpdateStatus> } | null = null

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'dsh-market' },
    signal: AbortSignal.timeout(4000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as unknown
}

/** Per-plugin update checks; a failed check reports no update rather than failing the listing. */
async function checkUpdates(profile: string, force = false): Promise<Record<string, UpdateStatus>> {
  if (!force && updatesCache && Date.now() - updatesCache.at < UPDATES_TTL_MS) return updatesCache.data
  const installed = readInstalled(profile)
  const lockCommits = readLockCommits(profile)
  const result: Record<string, UpdateStatus> = {}
  await Promise.all(Object.entries(installed).map(async ([name, spec]) => {
    const version = readInstalledVersion(profile, name)
    if (spec.startsWith('link:') || spec.startsWith('file:')) {
      result[name] = { kind: 'linked', version, current: null, latest: null, updateAvailable: false }
      return
    }
    const gh = /^(?:github:)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:#.*)?$/.exec(spec)
    try {
      if (spec.startsWith('github:') && gh !== null) {
        const current = lockCommits.get(gh[1].toLowerCase()) ?? null
        const head = (await fetchJson(`https://api.github.com/repos/${gh[1]}/commits/HEAD`)) as { sha?: string }
        const latest = typeof head.sha === 'string' ? head.sha : null
        result[name] = {
          kind: 'github', version, current, latest,
          updateAvailable: current !== null && latest !== null && current !== latest,
        }
      } else {
        const meta = (await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`)) as { version?: string }
        const latest = typeof meta.version === 'string' ? meta.version : null
        result[name] = {
          kind: 'npm', version, current: version, latest,
          updateAvailable: version !== null && latest !== null && version !== latest,
        }
      }
    } catch {
      result[name] = { kind: spec.startsWith('github:') ? 'github' : 'npm', version, current: null, latest: null, updateAvailable: false }
    }
  }))
  updatesCache = { at: Date.now(), data: result }
  return result
}

/** Serialize patch-layer writes (read-modify-write races between toggle calls). */
let patchWriteQueue: Promise<void> = Promise.resolve()
function queuedPatchWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = patchWriteQueue.then(fn, fn)
  patchWriteQueue = run.then(() => undefined, () => undefined)
  return run
}

/** User patch layer for a profile: `<profile>/cordis.patch.yml`. */
function patchPathOf(profile: string): string {
  return join(profileDir(profile), 'cordis.patch.yml')
}

function readPatchText(profile: string): string {
  try {
    return readFileSync(patchPathOf(profile), 'utf8')
  } catch {
    return ''
  }
}

/** Ids currently disabled (`disabled: true`) in the user patch layer. */
function readPatchDisables(profile: string): string[] {
  const lines = readPatchText(profile).split(/\r?\n/u)
  const disables: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^- id: ([A-Za-z0-9_.-]+)\s*$/u)
    if (match !== null && /^ {2}disabled: true\s*$/u.test(lines[index + 1] ?? '')) disables.push(match[1])
  }
  return disables
}

function escapeRegExpText(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * Append `- id: X\n  disabled: true` blocks for ids not already disabled in
 * the user patch layer. The HMR watcher recomposes the live tree, so the
 * plugin stops without a restart, and — crucially — the next boot skips the
 * broken plugin instead of failing hard.
 * @returns the ids actually written.
 */
async function appendDisableBlocks(profile: string, ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids)].filter(id => typeof id === 'string' && /^[A-Za-z0-9_.-]{1,80}$/u.test(id))
  if (unique.length === 0) return []
  return queuedPatchWrite(async () => {
    const disables = readPatchDisables(profile)
    const missing = unique.filter(id => !disables.includes(id))
    if (missing.length === 0) return []
    let text = readPatchText(profile)
    if (text.length !== 0 && !text.endsWith('\n')) text += '\n'
    text += missing.map(id => `- id: ${id}\n  disabled: true\n`).join('')
    writeFileSync(patchPathOf(profile), text, 'utf8')
    return missing
  })
}

/** Remove the `disabled: true` block for `rowId`; returns true when removed. */
async function removeDisableBlock(profile: string, rowId: string): Promise<boolean> {
  return queuedPatchWrite(async () => {
    const text = readPatchText(profile)
    const re = new RegExp(`^- id: ${escapeRegExpText(rowId)}\\r?\\n {2}disabled: true\\r?\\n`, 'mu')
    if (!re.test(text)) return false
    writeFileSync(patchPathOf(profile), text.replace(re, ''), 'utf8')
    return true
  })
}

/** Append a `disabled: false` force-enable block (overrides bundle-layer disables). */
async function appendForceEnable(profile: string, rowId: string): Promise<boolean> {
  return queuedPatchWrite(async () => {
    const text = readPatchText(profile)
    if (new RegExp(`^- id: ${escapeRegExpText(rowId)}\\r?\\n {2}disabled: false\\r?\\n`, 'mu').test(text)) return false
    const tail = text.length === 0 || text.endsWith('\n') ? text : `${text}\n`
    writeFileSync(patchPathOf(profile), `${tail}- id: ${rowId}\n  disabled: false\n`, 'utf8')
    return true
  })
}

/** Rows that keep the harness itself alive; never offer a toggle for them. */
const INFRA_PATTERNS: RegExp[] = [
  /^cordis:/u,
  /^@deepseek-ai\/cordis-plugin-/u,
  /^@deepseek-ai\/dsh-host-/u,
  /^@deepseek-ai\/dsh-client-modules$/u,
  /^@deepseek-ai\/dsh-client-connection$/u,
  /^@deepseek-ai\/dsh-client-hmr$/u,
  /^@deepseek-ai\/dsh-client-runtime$/u,
  /^@deepseek-ai\/dsh-client-locale$/u,
  /^@deepseek-ai\/dsh-client-web/u,
  /^@deepseek-ai\/dsh-web-frontend$/u,
  /^@deepseek-ai\/dsh-web-app$/u,
  /^@deepseek-ai\/dsh-base$/u,
]

function isInfraName(moduleName: string | undefined): boolean {
  return typeof moduleName === 'string' && INFRA_PATTERNS.some(pattern => pattern.test(moduleName))
}

/** The include entry's id prefix (`include:<row>` → `include:`). */
function includePrefix(ctx: MarketHost): string {
  for (const entry of ctx.loader.entries()) {
    if (entry.options?.name === 'cordis:include') return `${entry.id ?? ''}:`
  }
  return ''
}

/** Loader entry id → patch row id (bundle insert rows live under the include). */
function rowIdOf(ctx: MarketHost, entryId: string): string {
  const prefix = includePrefix(ctx)
  if (prefix.length > 0 && entryId.startsWith(prefix)) return entryId.slice(prefix.length)
  return entryId
}

/**
 * Register the market's HTTP routes.
 * @param host - Acquired webServer + shell services.
 * @param config - Validated market configuration.
 * @returns Disposer removing every registered route.
 */
export function mountMarketRoutes(host: MarketHost, config: MarketConfig): () => void {
  if (!PROFILE_RE.test(config.profile)) {
    throw new Error(`dsh-market: invalid profile name: ${config.profile}`)
  }
  // Boot-time wipe: stale hot-mount inputs from a previous session must never
  // survive into a composition where the bundle layer already covers them.
  cleanHotDir(profileDir(config.profile))
  // Client-only packages (dsh.client without dsh.bundle) are invisible to the
  // bundle layer in every boot; the market shim-mounts them so their client
  // bundles are actually served.
  // The user's persisted theme choice; activateTheme mutates and writes it.
  const disabledThemes = readDisabledThemes(profileDir(config.profile))

  void mountClientOnlyDeps(host, profileDir(config.profile)).then(async (mounted) => {
    if (mounted.length > 0) logEvent('info', 'boot', `client-only shims mounted: ${mounted.join(', ')}`)
    // Replay the user's theme choice: bundle-layer themes they switched away
    // from get live-disabled again (bundle trees are in-memory, so the
    // disable never persists on its own).
    for (const name of disabledThemes) {
      if (await setEntryDisabled(name, true)) logEvent('info', 'boot', `theme kept off: ${name}`)
    }
  })

  // Self-healing guard: dsh's own patch overlay can re-update entries during
  // activation and wipe the runtime disabled flag — whenever a fiber comes up
  // for a theme the user switched off, put it back down.
  host.on?.('internal/plugin', (fiber) => {
    const name = fiber.entry?.options?.name
    if (name !== undefined && disabledThemes.has(name)) void setEntryDisabled(name, true)
  })
  let installing = false

  /** Installed package names classified as themes by the registry's theme category. */
  async function installedThemeNames(profile: string): Promise<Set<string>> {
    const names = new Set<string>()
    try {
      const { registry } = await loadRegistry()
      const themeEntries = registry.plugins.filter(p => p.category === 'theme')
      const themeNames = new Set(themeEntries.map(p => p.name))
      const themeRepos = new Set(
        themeEntries.map(p => repoOf(p.url)).filter((r): r is string => r !== null).map(r => r.toLowerCase()),
      )
      for (const [name, spec] of Object.entries(readInstalled(profile))) {
        if (themeNames.has(name)) {
          names.add(name)
          continue
        }
        const match = /github:([^#\s]+)/.exec(String(spec).toLowerCase())
        if (match !== null && themeRepos.has(match[1])) names.add(name)
      }
    } catch { /* registry unavailable — nothing classifies as a theme */ }
    return names
  }

  /**
   * Live-toggle a bundle-layer plugin through its loader entry. Bundle trees
   * are in-memory (write is a no-op), so this never touches any file — the
   * market persists the choice itself and replays it at boot.
   * @returns true when a matching live entry was found and updated.
   */
  async function setEntryDisabled(name: string, disabledFlag: boolean): Promise<boolean> {
    let found = false
    for (const entry of host.loader.entries()) {
      if (entry.options.name !== name) continue
      // A disable can land while the entry's init is still in flight: the
      // options flip but the finishing init brings the fiber up anyway, and a
      // plain re-update no-ops on the empty diff. Force the update and verify
      // the live state, retrying until reality matches the flag.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await entry.update({ disabled: disabledFlag ? true : null }, false, true)
          found = true
        } catch (error) {
          logEvent('warn', 'toggle', `${name}: entry update failed — ${error instanceof Error ? error.message : String(error)}`)
          break
        }
        const live = entry.fiber !== undefined
        if (live !== disabledFlag) break
        await new Promise(resolvePromise => setTimeout(resolvePromise, 200))
      }
      logEvent('info', 'toggle',
        `${name} -> ${disabledFlag ? 'off' : 'on'}: fiber=${String(entry.fiber !== undefined)}`)
    }
    if (!found) logEvent('info', 'toggle', `${name}: no loader entry matched`)
    return found
  }

  /**
   * Make `name` the one active theme: deactivate every other installed theme
   * (market hot mounts unmount; bundle-layer entries live-disable) and bring
   * it up. The choice persists in state.json and is replayed at boot.
   */
  async function activateTheme(name: string): Promise<boolean> {
    const dir = profileDir(config.profile)
    const themes = await installedThemeNames(config.profile)
    for (const other of themes) {
      if (other === name) continue
      if (listHotMounts().includes(other)) {
        await hotUnmount(other)
        disabledThemes.add(other)
      } else if (await setEntryDisabled(other, true)) {
        disabledThemes.add(other)
      }
    }
    disabledThemes.delete(name)
    writeDisabledThemes(dir, disabledThemes)
    if (listHotMounts().includes(name)) return true
    if (await setEntryDisabled(name, false)) return true
    return (await hotMount(host, dir, name)).status === 'live'
  }

  const disposers = [
    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/registry',
      handler: async (request, response) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        try {
          const force = (request.url ?? '').includes('force=1')
          const { registry, source } = await loadRegistry({ force })
          sendJson(response, 200, { source, registry })
        } catch (error) {
          sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/entries',
      handler: (request, response) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        try {
          const installed = readInstalled(config.profile)
          const entries: Array<{
            name: string
            entryId: string
            rowId: string
            disabled: boolean
            phase: string | null
            toggleable: boolean
          }> = []
          for (const entry of host.loader.entries()) {
            if (entry.options.group) continue
            const moduleName = entry.options.name
            if (typeof moduleName !== 'string' || installed[moduleName] === undefined) continue
            const entryId = entry.id ?? ''
            const rowId = rowIdOf(host, entryId)
            const isSelf = moduleName === 'dsh-market' || moduleName === 'dshmarket' || rowId === 'dsh-market'
            const toggleable = !isSelf && !isInfraName(moduleName) && !moduleName.startsWith('cordis:')
            const fiber = entry.fiber as { state?: number } | undefined
            entries.push({
              name: moduleName,
              entryId,
              rowId,
              disabled: entry.disabled === true,
              phase: fiber === undefined || fiber === null || fiber.state === undefined ? null : ['pending', 'loading', 'active', 'failed', 'disposed', 'unloading'][fiber.state] ?? null,
              toggleable,
            })
          }
          sendJson(response, 200, { profile: config.profile, entries })
        } catch (error) {
          sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/installed',
      handler: (request, response) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        sendJson(response, 200, {
          profile: config.profile,
          installed: readInstalled(config.profile),
          live: listHotMounts(),
        })
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/use-skin',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' })
          return
        }
        try {
          const body = (await readJsonBody(request)) as { name?: unknown }
          const name = typeof body.name === 'string' ? body.name : ''
          const installed = readInstalled(config.profile)
          const themes = await installedThemeNames(config.profile)
          if (installed[name] === undefined || !themes.has(name)) {
            sendJson(response, 400, { error: 'not an installed theme' })
            return
          }
          const activated = await activateTheme(name)
          logEvent(activated ? 'info' : 'error', 'use-skin', `${name}: ${activated ? 'active' : 'failed'}`)
          sendJson(response, activated ? 200 : 502, { ok: activated, live: listHotMounts() })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          logEvent('error', 'use-skin', `route error: ${message}`)
          sendJson(response, 500, { error: message })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/status',
      handler: async (request, response) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        sendJson(response, 200, {
          active: progress.active,
          target: progress.target,
          seconds: progress.active ? Math.round((Date.now() - progress.startedAt) / 1000) : 0,
          lastLine: progress.lastLine,
          pnpm: await probePnpm(),
          boot: BOOT_ID,
          installed: readInstalled(config.profile),
        })
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/logs',
      handler: (request, response) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        let version = 'unknown'
        try {
          version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? version
        } catch { /* export still works without the version line */ }
        response.writeHead(200, {
          'cache-control': 'no-store',
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': 'attachment; filename="dsh-market-log.txt"',
        })
        response.end(exportLogs({
          'dsh-market': version,
          platform: `${process.platform} ${process.arch}`,
          node: process.version,
          profile: config.profile,
        }))
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/updates',
      handler: async (request, response) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        try {
          const force = (request.url ?? '').includes('force=1')
          sendJson(response, 200, { updates: await checkUpdates(config.profile, force) })
        } catch (error) {
          sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/update',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' })
          return
        }
        if (installing) {
          sendJson(response, 409, { error: 'another install is already running' })
          return
        }
        try {
          const body = (await readJsonBody(request)) as { name?: unknown }
          const name = typeof body.name === 'string' ? body.name : ''
          const spec = readInstalled(config.profile)[name]
          if (spec === undefined) {
            sendJson(response, 400, { error: 'plugin is not installed' })
            return
          }
          if (spec.startsWith('link:') || spec.startsWith('file:')) {
            sendJson(response, 400, { error: 'locally linked plugins update from their checkout' })
            return
          }
          // Pin the EXACT latest npm version instead of `pkg@latest`:
          // pnpm's default minimumReleaseAge (24h) silently re-points tags
          // and ranges to the newest "mature" version, so `add pkg@latest`
          // on a fresh release exits 0 without changing anything — the
          // endless "update available" loop. An explicit version installs
          // exactly what was asked; a minimumReleaseAge rejection is then
          // auto-excluded and retried once by runDshPlugin.
          // Git specs keep re-resolving HEAD and are verified by commit.
          const isGit = spec.startsWith('github:')
          let latest: string | null = null
          let target: string
          if (isGit) {
            target = spec.replace(/#.*$/, '')
          } else {
            const meta = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`) as { version?: unknown }
            latest = typeof meta.version === 'string' ? meta.version : null
            target = latest !== null ? `${name}@${latest}` : `${name}@latest`
          }
          const ageExclude = latest !== null ? `${name}@${latest}` : undefined
          const repoKey = isGit ? spec.slice('github:'.length).replace(/#.*$/, '').toLowerCase() : null
          const beforeVersion = readInstalledVersion(config.profile, name)
          const beforeCommit = repoKey !== null ? readLockCommits(config.profile).get(repoKey) ?? null : null
          installing = true
          try {
            const result = await runDshPlugin(config.profile, ['add', target], ageExclude)
            const exitedOk = result.exitCode === 0 && !result.timedOut
            const afterVersion = readInstalledVersion(config.profile, name)
            const afterCommit = repoKey !== null ? readLockCommits(config.profile).get(repoKey) ?? null : null
            // The update only counts when the installed version actually
            // moved; a silent no-op must not be reported as success
            // ("restart to apply" would loop forever).
            const applied = exitedOk && (isGit
              ? afterCommit !== null && (beforeCommit === null || afterCommit !== beforeCommit)
              : latest !== null && afterVersion === latest)
            const ok = applied
            if (ok) updatesCache = null
            const staleError = exitedOk && !applied
              ? `still v${beforeVersion ?? beforeCommit?.slice(0, 7) ?? '?'} after the update — 更新未生效：版本没变（pnpm 可能因 minimumReleaseAge 或其它限制未升级）`
              : null
            logEvent(ok ? 'info' : 'error', 'update',
              `${name} -> ${target} exit=${String(result.exitCode)}${result.timedOut ? ' TIMEOUT' : ''}${ok ? ` installed=${String(afterVersion ?? afterCommit?.slice(0, 7))}` : ` stderr=${result.stderr.slice(-300)}`}`)
            sendJson(response, ok ? 200 : 502, {
              ok,
              error: staleError ?? undefined,
              expected: latest,
              installedVersion: afterVersion,
              exitCode: result.exitCode,
              timedOut: result.timedOut,
              stdout: result.stdout,
              stderr: result.stderr,
              installed: readInstalled(config.profile),
            })
          } finally {
            installing = false
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          host.logger?.warn(`[dsh-market] update failed: ${message}`)
          logEvent('error', 'update', `route error: ${message}`)
          sendJson(response, 500, { error: message })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/setup-pnpm',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' })
          return
        }
        try {
          sendJson(response, 200, { ok: await provisionPnpm() })
        } catch (error) {
          sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/uninstall',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' })
          return
        }
        if (installing) {
          sendJson(response, 409, { error: 'another install is already running' })
          return
        }
        try {
          const body = (await readJsonBody(request)) as { name?: unknown }
          const name = typeof body.name === 'string' ? body.name : ''
          if (name === 'dsh-market' || name === 'dshmarket') {
            sendJson(response, 400, { error: 'the market cannot uninstall itself; use the dsh CLI' })
            return
          }
          if (readInstalled(config.profile)[name] === undefined) {
            sendJson(response, 400, { error: 'plugin is not installed' })
            return
          }
          installing = true
          try {
            const result = await runDshPlugin(config.profile, ['remove', name])
            const ok = result.exitCode === 0 && !result.timedOut
            let hot = false
            if (ok) {
              updatesCache = null
              hot = await hotUnmount(name)
            }
            logEvent(ok ? 'info' : 'error', 'uninstall',
              `${name} exit=${String(result.exitCode)}${ok ? ` live-removed=${String(hot)}` : ` stderr=${result.stderr.slice(-300)}`}`)
            sendJson(response, ok ? 200 : 502, {
              ok,
              hot,
              exitCode: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr,
              installed: readInstalled(config.profile),
            })
          } finally {
            installing = false
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          host.logger?.warn(`[dsh-market] uninstall failed: ${message}`)
          logEvent('error', 'uninstall', `route error: ${message}`)
          sendJson(response, 500, { error: message })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/install',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' })
          return
        }
        if (installing) {
          sendJson(response, 409, { error: 'another install is already running' })
          return
        }
        try {
          const body = (await readJsonBody(request)) as { url?: unknown }
          const url = typeof body.url === 'string' ? body.url : ''
          // Install decisions need a current npm mapping; wait for one
          // live attempt instead of resolving against a stale snapshot.
          const { registry } = await loadRegistry({ requireLive: true })
          const entry = registry.plugins.find(p => p.url.toLowerCase() === url.toLowerCase())
          if (entry === undefined) {
            logEvent('warn', 'install-rejected', `not in curated registry: ${url.slice(0, 120)}`)
            sendJson(response, 400, { error: 'plugin is not in the curated registry' })
            return
          }
          const repo = repoOf(entry.url)
          if (repo === null) {
            sendJson(response, 400, { error: 'unsupported source url' })
            return
          }
          // Registry tarballs beat full-repo GitHub downloads: smaller,
          // prebuilt, and CDN/mirror served. The npm name comes from our
          // curated registry, which only maps repo-verified packages.
          const NPM_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/
          const target = typeof entry.npm === 'string' && NPM_NAME_RE.test(entry.npm)
            ? entry.npm
            : `github:${repo}`
          installing = true
          try {
            const before = new Set(Object.keys(readInstalled(config.profile)))
            const result = await runDshPlugin(config.profile, ['add', target])
            let ok = result.exitCode === 0 && !result.timedOut
            if (ok) updatesCache = null
            if (ok) {
              // Collection repos (e.g. skin monorepos) install as a junk
              // fileset with no root package.json; retarget to the real
              // plugin subdirectories via pnpm's #path: selector.
              ok = await retargetCollections(config.profile, before, target)
            }
            const installed = readInstalled(config.profile)
            let hot: 'none' | 'live' | 'restart' | 'failed' = 'none'
            const autoDisabled: string[] = []
            if (ok) {
              const added = Object.keys(installed).filter(name => !before.has(name))
              for (const name of added) {
                if (entry.category === 'theme') {
                  // Theme installs auto-activate (and deactivate the previous
                  // theme) so the result is visible right after the refresh.
                  if (await activateTheme(name)) {
                    hot = 'live'
                  } else if (hot === 'none') {
                    hot = 'restart'
                  }
                } else {
                  const mount = await hotMount(host, profileDir(config.profile), name)
                  if (mount.status === 'live') {
                    hot = 'live'
                  } else if (mount.status === 'failed') {
                    // The plugin is broken: stop it live AND shield the next
                    // boot by disabling its rows in the user patch layer,
                    // breaking the boot-failure loop.
                    hot = 'failed'
                    const ids = mount.rows.map(row => row.id).filter(id => typeof id === 'string' && id !== '')
                    const written = await appendDisableBlocks(config.profile, ids)
                    autoDisabled.push(...written)
                  } else if (hot !== 'live' && hot !== 'failed') {
                    hot = 'restart'
                  }
                }
              }
              if (added.length === 0) hot = 'restart'
            }
            logEvent(ok ? 'info' : 'error', 'install',
              `${target} exit=${String(result.exitCode)}${result.timedOut ? ' TIMEOUT' : ''}${ok ? ` hot=${String(hot)}${autoDisabled.length > 0 ? ` auto-disabled=${autoDisabled.join(',')}` : ''}` : ` stderr=${result.stderr.slice(-300)}`}`)
            sendJson(response, ok ? 200 : 502, {
              ok,
              hot,
              autoDisabled,
              exitCode: result.exitCode,
              timedOut: result.timedOut,
              stdout: result.stdout,
              stderr: result.stderr,
              installed,
            })
          } finally {
            installing = false
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          host.logger?.warn(`[dsh-market] install failed: ${message}`)
          logEvent('error', 'install', `route error: ${message}`)
          sendJson(response, 500, { error: message })
        }
      },
    }),

    host.webServer.register({
      kind: 'exact',
      path: '/dsh-market/toggle',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!sameOrigin(request)) {
          sendJson(response, 403, { error: 'untrusted origin' })
          return
        }
        try {
          const body = (await readJsonBody(request)) as { entryId?: unknown; enabled?: unknown }
          const entryId = typeof body.entryId === 'string' ? body.entryId : ''
          const enabled = body.enabled === true
          if (entryId === '' || !/^[A-Za-z0-9_:.-]{1,80}$/u.test(entryId)) {
            sendJson(response, 400, { error: 'entryId is invalid' })
            return
          }
          const found: LoaderEntry | undefined = [...host.loader.entries()].find(entry => entry.id === entryId)
          if (found === undefined) {
            sendJson(response, 404, { error: `no plugin entry named ${entryId}` })
            return
          }
          const moduleName = found.options.name
          const rowId = rowIdOf(host, entryId)
          if (rowId === 'dsh-market' || moduleName === 'dsh-market' || moduleName === 'dshmarket') {
            sendJson(response, 400, { error: 'the market cannot toggle itself; use the dsh CLI' })
            return
          }
          if (typeof moduleName !== 'string' || moduleName.startsWith('cordis:') || isInfraName(moduleName)) {
            sendJson(response, 403, { error: `${String(moduleName)} is harness infrastructure and cannot be toggled` })
            return
          }
          const changed = enabled
            ? (await removeDisableBlock(config.profile, rowId)) || (await appendForceEnable(config.profile, rowId))
            : (await appendDisableBlocks(config.profile, [rowId])).length > 0
          logEvent('info', 'toggle', `${rowId} -> ${enabled ? 'enabled' : 'disabled'} changed=${String(changed)}`)
          sendJson(response, 200, { ok: true, entryId, rowId, enabled, changed })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          host.logger?.warn(`[dsh-market] toggle failed: ${message}`)
          logEvent('error', 'toggle', `route error: ${message}`)
          sendJson(response, 500, { error: message })
        }
      },
    }),
  ]

  return () => {
    for (const dispose of disposers) dispose()
  }
}
