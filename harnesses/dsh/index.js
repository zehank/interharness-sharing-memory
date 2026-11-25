/**
 * DSH host plugin: exposes `sharing_memory_sync` and `sharing_memory_status`.
 *
 * The bridge itself runs in a child process under the user's Node (node:sqlite),
 * so git/network work never blocks the Host. dsh-mnemon's own idleReview and
 * runtime projection remain untouched; the bridge only reads/writes the same
 * files through dsh-mnemon's documented lock and content rules.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { childPathEnv, expandHome, resolveNodePath } from './lib/util.mjs'

const name = 'sharing-memory-sync'
const inject = ['tools']

const HERE = path.dirname(fileURLToPath(import.meta.url))

function resolveConfig(config = {}) {
  return {
    nodePath: resolveNodePath(config.nodePath || process.env.SHARING_SYNC_NODE || ''),
    runner: path.join(HERE, 'scripts', 'sync-runner.mjs'),
    sharingDir: expandHome(config.sharingDir || process.env.SHARING_MEMORY_DIR || '~/.gemini/memory'),
    mnemonHome: expandHome(config.mnemonHome || process.env.MNEMON_HOME || '~/.mnemon'),
    stateDir: expandHome(config.stateDir || process.env.SHARING_SYNC_STATE_DIR || '~/.dsh/sharing-memory-sync'),
    serverPath: expandHome(
      config.localMemoryServerPath || process.env.SHARING_MEMORY_SERVER
        || '~/.gemini/config/plugins/local-memory/server/memory-mcp.mjs',
    ),
    autoSync: ['off', 'startup', 'idle', 'both'].includes(config.autoSync) ? config.autoSync : 'off',
    autoSyncMinIntervalMs: Number(config.autoSyncMinIntervalMs) > 0
      ? Number(config.autoSyncMinIntervalMs)
      : 30 * 60 * 1000,
    mirrorPinned: config.mirrorPinned === true,
    timeoutMs: Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : 300000,
  }
}

function childEnv(cfg) {
  return {
    ...process.env,
    SHARING_MEMORY_DIR: cfg.sharingDir,
    MNEMON_HOME: cfg.mnemonHome,
    SHARING_SYNC_STATE_DIR: cfg.stateDir,
    SHARING_MEMORY_SERVER: cfg.serverPath,
    SHARING_SYNC_NODE: cfg.nodePath,
    PATH: childPathEnv(),
  }
}

function spawnRunner(cfg, args) {
  return new Promise((resolve, reject) => {
    if (path.isAbsolute(cfg.nodePath) && !fs.existsSync(cfg.nodePath)) {
      reject(new Error(`找不到 Node：${cfg.nodePath}（node:sqlite 需要 Node ≥ 22.5，可在插件配置 nodePath 改）`))
      return
    }
    let child
    try {
      child = spawn(cfg.nodePath, ['--no-warnings', cfg.runner, ...args], {
        env: childEnv(cfg),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(error)
      return
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      reject(new Error(`同步超时（${cfg.timeoutMs}ms）`))
    }, cfg.timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`无法启动同步进程：${error.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const line = stdout.trim().split('\n').filter(Boolean).pop()
      if (!line) {
        reject(new Error(`同步进程没有输出（exit ${code}）${stderr ? `：${stderr.slice(0, 500)}` : ''}`))
        return
      }
      try {
        resolve(JSON.parse(line))
      } catch {
        reject(new Error(`无法解析同步输出：${line.slice(0, 400)}`))
      }
    })
  })
}

function syncMessage(result) {
  if (!result || result.ok === false) return `同步失败：${result?.error || '未知错误'}`
  const sharing = result.sharing || {}
  const dsh = result.dsh || {}
  const lines = [
    `同步完成（${result.direction}${result.dryRun ? '，dry-run 未写入' : ''}，${result.ms}ms，设备 ${result.deviceId}）`,
    `sharing-memory：${sharing.before ?? '?'} → ${sharing.after ?? '?'} 条（活跃 ${sharing.active ?? '?'}，墓碑 ${sharing.tombstones ?? '?'}）`,
  ]
  if (sharing.writes) {
    lines.push(`推送：新增 ${sharing.writes.inserted}，更新 ${sharing.writes.updated}，墓碑 ${sharing.writes.tombstoned}${sharing.writes.skipped ? `，跳过 ${sharing.writes.skipped}` : ''}`)
  }
  lines.push(`dsh-mnemon：洞察 ${dsh.before ?? '?'} → ${dsh.after ?? '?'}，热记忆 ${dsh.runtimeBefore ?? '?'} → ${dsh.runtimeAfter ?? '?'}`)
  if (dsh.insightWrites) {
    lines.push(`拉取：新增 ${dsh.insightWrites.inserted}，更新 ${dsh.insightWrites.updated}${dsh.insightWrites.skipped ? `，跳过 ${dsh.insightWrites.skipped}` : ''}`)
  }
  if (result.runtime) {
    lines.push(`热记忆变更：新增 ${result.runtime.added}，更新 ${result.runtime.updated}，移除 ${result.runtime.removed}`)
  }
  if (result.git && !result.git.error) {
    const git = result.git
    lines.push(`git：${git.branch || '?'}，工作区改动 ${git.dirtyFiles ?? '?'} 个文件${(git.ahead || git.behind) ? `，领先 ${git.ahead || 0} / 落后 ${git.behind || 0}` : '，已与远端同步'}`)
  }
  if (result.sync && !result.sync.skipped) {
    lines.push(result.sync.ok
      ? `local-memory memory_sync：成功${result.sync.merge?.memories_merged ? `（合并 ${result.sync.merge.memories_merged} 条）` : ''}`
      : `local-memory memory_sync：失败 ${result.sync.error || ''}`)
  }
  if (result.warnings?.length) lines.push(`警告：${result.warnings.slice(0, 5).join('；')}`)
  return lines.join('\n')
}

function statusMessage(status) {
  const compact = {
    deviceId: status.deviceId,
    sharing: status.sharing,
    dsh: status.dsh,
    mappings: status.mappings,
    git: status.git,
    lastRun: status.lastRun,
    paths: status.paths,
  }
  return JSON.stringify(compact, null, 2)
}

export function apply(ctx, config = {}) {
  const cfg = resolveConfig(config)
  const lastAutoPath = path.join(cfg.stateDir, 'last-auto.json')
  const timers = new Set()

  function log(message) {
    try { ctx.logger?.info?.(`[sharing-memory-sync] ${message}`) } catch {}
  }

  function shouldAutoRun() {
    try {
      const last = JSON.parse(fs.readFileSync(lastAutoPath, 'utf8'))
      return Date.now() - Date.parse(last.at) > cfg.autoSyncMinIntervalMs
    } catch {
      return true
    }
  }

  function markAutoRun() {
    try {
      fs.mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 })
      fs.writeFileSync(lastAutoPath, `${JSON.stringify({ at: new Date().toISOString() })}\n`, { mode: 0o600 })
    } catch {}
  }

  /** Non-blocking, debounced, silent: never delays session start and never touches idleReview. */
  function triggerAuto(kind) {
    if (cfg.autoSync === 'off') return
    if (kind === 'idle' && !['idle', 'both'].includes(cfg.autoSync)) return
    if (kind === 'startup' && !['startup', 'both'].includes(cfg.autoSync)) return
    if (!shouldAutoRun()) return
    markAutoRun()
    try {
      const child = spawn(cfg.nodePath, ['--no-warnings', cfg.runner, '--action', 'sync', '--direction', 'both', '--auto'], {
        detached: true,
        stdio: 'ignore',
        env: childEnv(cfg),
      })
      child.unref()
      log(`auto sync (${kind}) started`)
    } catch (error) {
      log(`auto sync skipped: ${error.message}`)
    }
  }

  ctx.effect(() => () => {
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
  })

  if (cfg.autoSync !== 'off') {
    ctx.on('agent/created', () => {
      const timer = setTimeout(() => { timers.delete(timer); triggerAuto('startup') }, 1500)
      timers.add(timer)
    })
    if (cfg.autoSync === 'idle' || cfg.autoSync === 'both') {
      ctx.on('agent/status', ({ status }) => {
        if (status !== 'idle') return
        const timer = setTimeout(() => { timers.delete(timer); triggerAuto('idle') }, 5000)
        timers.add(timer)
      })
    }
  }

  ctx.tools.register({
    name: 'sharing_memory_sync',
    description:
      '把 dsh-mnemon（持久层 insights + 热记忆 USER.md/MEMORY.md）与统一总记忆库 zehank/sharing-memory（~/.gemini/memory）双向同步。'
      + '严格沿用原 UID 映射（mnemon_<uuid> / mnemon_rt_<hash>），幂等，重复执行不会产生重复条目；删除走 deleted_at 墓碑。'
      + '默认先跑 local-memory 的 memory_sync（git pull --rebase --autostash + LWW 合并 + push），再按 updated_at 双向合并。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        direction: {
          type: 'string',
          enum: ['both', 'push', 'pull'],
          description: 'both=双向（默认）；push=只把 DSH 新/改的条目推出去；pull=只把其他 AI 新/改的条目拉进 DSH。',
        },
        dry_run: {
          type: 'boolean',
          description: '只计算差异并报告，不写 memory.db / mnemon.db / runtime，也不跑 git。',
        },
        mirror_pinned: {
          type: 'boolean',
          description: '拉取时把其他 AI 的置顶/重要度 ≥4 条目额外镜像进 DSH 热记忆（默认关闭，按需开启）。',
        },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value?.message || '完成' }],
    },
    async execute(args = {}) {
      const direction = ['both', 'push', 'pull'].includes(args.direction) ? args.direction : 'both'
      const argv = ['--action', 'sync', '--direction', direction]
      if (args.dry_run) argv.push('--dry-run')
      if (args.mirror_pinned === true) argv.push('--mirror-pinned')
      try {
        const result = await spawnRunner(cfg, argv)
        return { ok: result.ok !== false, message: syncMessage(result), result }
      } catch (error) {
        return { ok: false, message: `同步失败：${error.message}` }
      }
    },
  })

  ctx.tools.register({
    name: 'sharing_memory_status',
    description:
      '查看 sharing-memory 双向同步状态：各库条数、UID 映射数、git 工作区/领先落后、上次同步结果。只读，不联网、不写任何文件。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value?.message || '完成' }],
    },
    async execute() {
      try {
        const status = await spawnRunner(cfg, ['--action', 'status'])
        return { ok: status.ok !== false, message: statusMessage(status), status }
      } catch (error) {
        return { ok: false, message: `读取状态失败：${error.message}` }
      }
    },
  })

  log(`ready (node=${cfg.nodePath}, autoSync=${cfg.autoSync})`)
}

export { name, inject }
