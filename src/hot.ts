/**
 * Restart-free installs: mount a freshly installed plugin into the running
 * composition through a market-owned Include subtree.
 *
 * Durable state stays with the profile's `dsh.profile.bundles` (reconciled by
 * the dsh CLI at install time), so the next boot loads the plugin through the
 * normal bundle layer. The subtree here exists only for the current process:
 * its input files live under `<profile>/.dsh-market/` and are wiped on every
 * boot, so a crash can never leave a file that collides with the bundle layer
 * (inserting an id the bundle layer also inserts is a hard boot failure).
 *
 * The Include subclass suppresses `write()` — the loader otherwise persists
 * tree changes back to the file it read (see dsh's agent-presets PresetTree
 * for the in-tree precedent).
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { logEvent } from './log.ts'

interface HotRow {
  id: string
  name: string
}

interface PluginHandle {
  await(): Promise<unknown>
  dispose(): Promise<unknown> | void
}

interface HotContext {
  plugin(plugin: unknown, config: unknown): PluginHandle
  logger?: { info?(message: string): void; warn(message: string): void }
}

const HOT_DIR = '.dsh-market'

let hotTreeClass: unknown | null | undefined

/**
 * The Include subclass, built once per process; null when the loader's include
 * plugin is not importable (older harness) — callers fall back to restart.
 */
/**
 * Packages whose host import is replaced by a no-op shim. Client-only plugins
 * (`dsh.client` without `dsh.bundle`) have no importable host half, but
 * client-modules only serves bundles for packages with a live loader entry —
 * the shim fiber exists purely to satisfy that registration.
 */
const shimNames = new Set<string>()

async function loadHotTreeClass(): Promise<unknown | null> {
  if (hotTreeClass !== undefined) return hotTreeClass
  try {
    // Computed specifier: the include plugin ships with the harness (vendored,
    // unpublished), so it resolves at runtime through the profile fallback but
    // is not typecheckable as a dependency.
    const specifier = '@deepseek-ai/cordis-plugin-include'
    const mod = (await import(specifier)) as {
      Include?: new (...args: never[]) => {
        write(): void
        import(name: string, getOuterStack?: () => string[]): unknown
      }
    }
    const Include = mod.Include
    if (Include === undefined) throw new Error('no Include export')
    class MarketHotTree extends Include {
      /** Runtime-only mount list; the bundle layer owns persistence. */
      override write(): void {}
      override import(name: string, getOuterStack?: () => string[]): unknown {
        if (shimNames.has(name)) return { name, apply: () => {} }
        return super.import(name, getOuterStack)
      }
    }
    hotTreeClass = MarketHotTree
  } catch {
    hotTreeClass = null
  }
  return hotTreeClass
}

/** The `dsh` declaration block of an installed package, or null when unreadable. */
function readPkgDsh(profileDir: string, packageName: string): { client?: unknown; bundle?: unknown } | null {
  try {
    const manifest = JSON.parse(
      readFileSync(join(profileDir, 'node_modules', packageName, 'package.json'), 'utf8'),
    ) as { dsh?: { client?: unknown; bundle?: unknown } }
    return manifest.dsh ?? {}
  } catch {
    return null
  }
}

/**
 * Insert rows of a plugin's bundle patch, or null when the patch contains
 * anything beyond plain `id`/`name` insert rows (config blocks, disables,
 * expressions) — those compositions fall back to restart activation.
 */
export function parseSimplePatch(patchText: string): HotRow[] | null {
  const rows: HotRow[] = []
  let pending: string | null = null
  for (const raw of patchText.split('\n')) {
    const line = raw.replace(/#.*$/, '').trimEnd()
    if (line.trim() === '') continue
    if (/^-\s+insert:\s*$/.test(line)) continue
    const id = /^\s+-\s+id:\s*(\S+)\s*$/.exec(line)
    if (id !== null) {
      if (pending !== null) return null
      pending = id[1]
      continue
    }
    const name = /^\s+name:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line)
    if (name !== null && pending !== null) {
      rows.push({ id: pending, name: name[1] })
      pending = null
      continue
    }
    return null
  }
  if (pending !== null || rows.length === 0) return null
  return rows
}

/**
 * Wipe leftover hot-mount inputs; call once when the market host starts.
 * `state.json` (skin enable/disable choices) deliberately survives.
 */
export function cleanHotDir(profileDir: string): void {
  const dir = join(profileDir, HOT_DIR)
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (/^hot-\d+\.yml$/.test(name)) rmSync(join(dir, name), { force: true })
  }
}

function stateFile(profileDir: string): string {
  return join(profileDir, HOT_DIR, 'state.json')
}

/** Themes the user switched away from; skipped by the boot re-mount. */
export function readDisabledThemes(profileDir: string): Set<string> {
  try {
    const state = JSON.parse(readFileSync(stateFile(profileDir), 'utf8')) as { disabledSkins?: string[] }
    return new Set(Array.isArray(state.disabledSkins) ? state.disabledSkins : [])
  } catch {
    return new Set()
  }
}

export function writeDisabledThemes(profileDir: string, disabled: Set<string>): void {
  mkdirSync(join(profileDir, HOT_DIR), { recursive: true, mode: 0o700 })
  writeFileSync(stateFile(profileDir), JSON.stringify({ disabledSkins: [...disabled] }))
}

/** Package names currently live through a market hot mount (patch or shim). */
export function listHotMounts(): string[] {
  return [...hotHandles.keys()]
}

let hotSequence = 0

const hotHandles = new Map<string, PluginHandle>()

/**
 * Dispose a plugin hot-mounted earlier in this session, removing it from the
 * running composition immediately.
 * @param packageName - package to unmount.
 * @returns true when a live hot mount was found and disposed.
 */
export async function hotUnmount(packageName: string): Promise<boolean> {
  const handle = hotHandles.get(packageName)
  if (handle === undefined) return false
  hotHandles.delete(packageName)
  shimNames.delete(packageName)
  try {
    await handle.dispose()
    logEvent('info', 'hot-unmount', `${packageName}: removed live`)
    return true
  } catch (error) {
    logEvent('warn', 'hot-unmount', `${packageName}: dispose failed — ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

export interface HotMountResult {
  status: 'live' | 'restart' | 'failed'
  rows: HotRow[]
  error?: string
}

/**
 * Mount `packageName` (just installed into the profile) into the running
 * composition.
 * @param ctx - market host context; the subtree unwinds with the market's fiber.
 * @param profileDir - profile the package was installed into.
 * @param packageName - installed package to activate.
 * @returns
 *   - `live`:    active in the running composition, no restart needed
 *   - `restart`: could not hot-mount (complex patch, no include plugin, …) —
 *                the plugin itself was not judged broken, restart to activate
 *   - `failed`:  the hot mount was attempted and the plugin fiber rejected —
 *                the plugin is broken; callers should disable its rows in the
 *                user patch layer so the next boot does not fail hard
 */
export async function hotMount(ctx: HotContext, profileDir: string, packageName: string): Promise<HotMountResult> {
  try {
    const HotTree = await loadHotTreeClass()
    if (HotTree === null) return { status: 'restart', rows: [] }
    let patchText: string | null
    try {
      patchText = readFileSync(
        join(profileDir, 'node_modules', packageName, 'cordis.patch.yml'),
        'utf8',
      )
    } catch {
      patchText = null
    }
    let rows: HotRow[] | null
    if (patchText !== null) {
      rows = parseSimplePatch(patchText)
      if (rows === null) return { status: 'restart', rows: [] }
    } else {
      // No host patch. Client-only packages (dsh.client, no dsh.bundle) never
      // get a loader entry — not even after a restart — so client-modules
      // would never serve their bundle. A shim entry under the package's name
      // is the whole activation.
      const dsh = readPkgDsh(profileDir, packageName)
      if (dsh === null || dsh.client === undefined || dsh.bundle !== undefined) return { status: 'restart', rows: [] }
      shimNames.add(packageName)
      rows = [{ id: `client-${packageName.replace(/[^A-Za-z0-9_.-]/g, '-')}`, name: packageName }]
    }
    const dir = join(profileDir, HOT_DIR)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    hotSequence += 1
    const file = join(dir, `hot-${String(hotSequence)}.yml`)
    const yml = rows
      .map(row => `- id: 'mkt-${row.id}'\n  name: '${row.name}'\n`)
      .join('')
    writeFileSync(file, yml)
    const handle = ctx.plugin(HotTree, { path: pathToFileURL(file).href })
    try {
      await handle.await()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      try {
        await handle.dispose()
      } catch { /* cleanup is best-effort; the failure verdict already owns the outcome */ }
      shimNames.delete(packageName)
      ctx.logger?.warn(`[dsh-market] hot mount of ${packageName} failed to activate: ${message}`)
      logEvent('warn', 'hot-mount', `${packageName}: activate failed — ${message}`)
      return { status: 'failed', rows, error: message }
    }
    hotHandles.set(packageName, handle)
    ctx.logger?.info?.(`[dsh-market] hot-mounted ${packageName}`)
    logEvent('info', 'hot-mount', `${packageName}: live${shimNames.has(packageName) ? ' (client-only shim)' : ''}`)
    return { status: 'live', rows }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    shimNames.delete(packageName)
    ctx.logger?.warn(`[dsh-market] hot mount of ${packageName} unavailable, restart required: ${message}`)
    logEvent('warn', 'hot-mount', `${packageName}: fell back to restart — ${message}`)
    return { status: 'restart', rows: [], error: message }
  }
}

/**
 * Mount every installed client-only package (`dsh.client` without
 * `dsh.bundle`) at market startup. The bundle reconcile skips these packages
 * entirely, so without the market's shim their client bundles are unreachable
 * in every boot — this is what makes them behave like normal plugins.
 * @returns names that were mounted.
 */
export async function mountClientOnlyDeps(ctx: HotContext, profileDir: string): Promise<string[]> {
  let deps: string[]
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      dsh?: { profile?: { bundles?: string[] } }
    }
    const bundles = new Set(manifest.dsh?.profile?.bundles ?? [])
    deps = Object.keys(manifest.dependencies ?? {}).filter(name => !bundles.has(name))
  } catch {
    return []
  }
  const disabled = readDisabledThemes(profileDir)
  const mounted: string[] = []
  for (const name of deps) {
    if (hotHandles.has(name) || disabled.has(name)) continue
    const dsh = readPkgDsh(profileDir, name)
    if (dsh === null || dsh.client === undefined || dsh.bundle !== undefined) continue
    if (await hotMount(ctx, profileDir, name)) mounted.push(name)
  }
  return mounted
}

