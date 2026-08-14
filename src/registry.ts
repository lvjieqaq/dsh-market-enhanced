/**
 * Registry access: fetch the curated list from awesome-dsh-plugin.com with a
 * disk-backed cache that survives restarts and a stale-while-revalidate read
 * path, falling back to the bundled snapshot only when nothing fresher exists.
 *
 * Read policy (instant page loads, never block on the network):
 *   - memory cache younger than FRESH_MS  -> served as-is
 *   - otherwise serve memory/disk/snapshot immediately and refresh live in
 *     the background (single-flight)
 *   - `force: true` awaits a live fetch (refresh button)
 *   - `requireLive: true` awaits a live fetch when the only available data is
 *     the bundled snapshot (install paths need a current npm mapping)
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface RegistryPlugin {
  name: string
  owner: string
  url: string
  category: string
  description: Record<string, string>
  npm?: string | null
  stars?: number | null
  install: string
  added: string
}

export interface Registry {
  updated: string
  count: number
  categories: Record<string, Record<string, string>>
  plugins: RegistryPlugin[]
}

export interface LoadRegistryOptions {
  force?: boolean
  requireLive?: boolean
}

const REGISTRY_URL = 'https://awesome-dsh-plugin.com/plugins.json'
const FRESH_MS = 30 * 60 * 1000 // younger than this: no refresh at all
const FETCH_TIMEOUT_MS = 8000 // generous for slow links

let memory: { at: number; registry: Registry } | null = null
let inflight: Promise<{ at: number; registry: Registry } | null> | null = null

function dshHome(): string {
  return process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
}

function cacheFile(): string {
  return join(dshHome(), 'storages', 'dsh-market', 'registry-cache.json')
}

function readDiskCache(): { at: number; registry: Registry } | null {
  try {
    const raw = JSON.parse(readFileSync(cacheFile(), 'utf8')) as { at?: unknown; registry?: unknown }
    if (typeof raw?.at === 'number' && raw.registry
      && Array.isArray((raw.registry as Registry).plugins) && (raw.registry as Registry).plugins.length > 0) {
      return { at: raw.at, registry: raw.registry as Registry }
    }
  } catch { /* no cache yet, or corrupt — treat as absent */ }
  return null
}

function writeDiskCache(entry: { at: number; registry: Registry }): void {
  try {
    mkdirSync(join(dshHome(), 'storages', 'dsh-market'), { recursive: true })
    writeFileSync(cacheFile(), JSON.stringify(entry))
  } catch { /* cache is best-effort */ }
}

function snapshot(): Registry {
  const path = fileURLToPath(new URL('../data/registry-snapshot.json', import.meta.url))
  return JSON.parse(readFileSync(path, 'utf8')) as Registry
}

async function fetchLive(): Promise<Registry> {
  const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = (await res.json()) as Registry
  if (!Array.isArray(data.plugins) || data.plugins.length === 0) throw new Error('empty registry')
  return data
}

/** Single-flight live refresh: resolves to the fresh entry, or null on failure. */
function refresh(): Promise<{ at: number; registry: Registry } | null> {
  if (inflight !== null) return inflight
  inflight = (async () => {
    try {
      const entry = { at: Date.now(), registry: await fetchLive() }
      memory = entry
      writeDiskCache(entry)
      return entry
    } catch {
      return null
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/**
 * Load the registry per the policy above.
 */
export async function loadRegistry(options: LoadRegistryOptions = {}): Promise<{ registry: Registry; source: 'live' | 'cache' | 'snapshot' }> {
  const force = options.force === true
  const requireLive = options.requireLive === true

  // Fast path: fresh memory cache.
  if (!force && memory !== null && Date.now() - memory.at < FRESH_MS) {
    return { registry: memory.registry, source: 'cache' }
  }

  // Best available fallback, resolved instantly.
  const disk = readDiskCache()
  const fallback = memory ?? disk
  const fallbackSource: 'cache' | 'snapshot' = fallback !== null ? 'cache' : 'snapshot'
  if (disk !== null && memory === null) memory = disk // adopt the disk cache

  if (force) {
    const live = await refresh()
    if (live !== null) return { registry: live.registry, source: 'live' }
    if (fallback !== null) return { registry: fallback.registry, source: fallbackSource }
    return { registry: snapshot(), source: 'snapshot' }
  }

  // Install paths must not resolve npm mappings from the bundled snapshot when
  // a live fetch is possible: wait for one attempt, then fall back.
  if (requireLive && fallback === null) {
    const live = await refresh()
    if (live !== null) return { registry: live.registry, source: 'live' }
    return { registry: snapshot(), source: 'snapshot' }
  }

  // Serve instantly, refresh in the background when stale.
  if (fallback === null) {
    // Nothing cached yet: serve the snapshot now, refresh in background.
    void refresh()
    return { registry: snapshot(), source: 'snapshot' }
  }
  if (Date.now() - fallback.at >= FRESH_MS) void refresh()
  return { registry: fallback.registry, source: fallbackSource }
}
