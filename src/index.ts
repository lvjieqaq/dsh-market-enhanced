/**
 * dsh-market host entry: mounts the market's HTTP routes once the profile
 * composes the webServer and shell services.
 */

import type { Context } from '@deepseek-ai/cordis'
import { mountMarketRoutes, type MarketConfig, type MarketHost } from './routes.ts'

export const name = 'dsh-market'

/** Optional cordis.yml configuration; profile defaults to `web`. */
export type Config = Partial<MarketConfig>

/**
 * Register the market against the host context.
 * @param ctx - Host context that may acquire webServer and shell services.
 * @param config - Optional profile override from the loader.
 */
/**
 * The profile this host process actually booted (`--profile <name>` on the
 * dsh CLI invocation). Without it the market would default to `web` and
 * installs from a test/secondary profile would mutate the real one.
 */
function argvProfile(): string | undefined {
  const argv = process.argv
  const flag = argv.indexOf('--profile')
  if (flag !== -1 && flag + 1 < argv.length && !argv[flag + 1].startsWith('-')) return argv[flag + 1]
  return undefined
}

export function apply(ctx: Context, config?: Config): void {
  const resolved: MarketConfig = { profile: config?.profile ?? argvProfile() ?? 'web' }
  ctx.inject(['webServer', 'loader'], (hostCtx: Context) => {
    const host = hostCtx as unknown as MarketHost & {
      effect(callback: () => () => void, label: string): void
    }
    host.effect(() => mountMarketRoutes(host, resolved), 'dsh-market: http routes')
  })
}
