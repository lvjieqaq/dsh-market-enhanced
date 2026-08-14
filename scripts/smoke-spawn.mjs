#!/usr/bin/env node
/**
 * Cross-platform smoke for the tool-spawning pattern used by routes.ts.
 * On Windows, npm/corepack/pnpm are `.cmd` shims that node:child_process
 * cannot start without a shell (#2/#3/#5) — this guards the `shell` flag
 * from regressing. Runs in CI on windows-latest and ubuntu-latest.
 */
import { spawn } from 'node:child_process'

const winCmdShim = process.platform === 'win32'

function probe(file, args) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: 'ignore', shell: winCmdShim })
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  })
}

const results = await Promise.all([
  probe('npm', ['--version']),
  probe('pnpm', ['--version']),
])

if (!results[0]) {
  console.error(`smoke failed on ${process.platform}: spawn npm --version did not exit 0`)
  process.exit(1)
}
if (!results[1]) {
  console.error(`smoke failed on ${process.platform}: spawn pnpm --version did not exit 0 (is pnpm set up in CI?)`)
  process.exit(1)
}
console.log(`smoke ok on ${process.platform}: npm + pnpm spawn with shell=${String(winCmdShim)}`)
