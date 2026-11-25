#!/usr/bin/env node
/**
 * Subprocess entry point. The DSH host plugin spawns this with the user's Node
 * (node:sqlite needs >= 22.5) so a slow git sync never blocks the Host event loop.
 *
 *   node scripts/sync-runner.mjs --action sync   [--direction both|push|pull] [--dry-run] [--mirror-pinned]
 *   node scripts/sync-runner.mjs --action status
 */
import { runStatus, runSync } from '../lib/sync.mjs'

function parseArgs(argv) {
  const args = { action: 'sync', direction: 'both', dryRun: false, mirrorPinned: false, auto: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--action') args.action = argv[++i]
    else if (arg === '--direction') args.direction = argv[++i]
    else if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--mirror-pinned') args.mirrorPinned = true
    else if (arg === '--auto') args.auto = true
  }
  if (!['sync', 'status'].includes(args.action)) args.action = 'sync'
  if (!['both', 'push', 'pull'].includes(args.direction)) args.direction = 'both'
  return args
}

const args = parseArgs(process.argv.slice(2))
const overrides = {
  direction: args.direction,
  dryRun: args.dryRun,
  mirrorPinned: args.mirrorPinned,
}

let result
try {
  result = args.action === 'status' ? runStatus(overrides) : await runSync(overrides)
} catch (error) {
  result = { ok: false, action: args.action, error: error?.message || String(error) }
}

process.stdout.write(`${JSON.stringify(result)}\n`)
process.exit(result.ok === false ? 1 : 0)
