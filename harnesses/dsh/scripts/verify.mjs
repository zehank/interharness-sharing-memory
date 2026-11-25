#!/usr/bin/env node
/**
 * Live, reproducible verification of the dsh-mnemon ↔ sharing-memory bridge.
 *
 *   node .dsh/plugins/sharing-memory-sync/scripts/verify.mjs
 *
 * Proves the three claims from the delivery request:
 *   (1) repeated syncs are idempotent — no duplicate uids and no new duplicate
 *       content groups; the pre-existing mnemon_rt_* ids are never regenerated;
 *   (2) a new DSH memory reaches GitHub `origin/main` as `mnemon_<uuid>` and a
 *       DSH delete travels back as a `deleted_at` tombstone;
 *   (3) other platforms' active records (e.g. #172) exist in mnemon.db with the
 *       same content as the unified store.
 *
 * The test memory is clearly labelled and soft-deleted at the end; the tombstone
 * remains in the shared repo by design (that is the protocol).
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { contentKey, uuidFromSeed } from '../lib/util.mjs'
import { resolveConfig, runSync } from '../lib/sync.mjs'

const config = resolveConfig({})
const mnemonCli = process.env.MNEMON_CLI || path.join(config.mnemonHome, 'bin', process.platform === 'win32' ? 'mnemon.exe' : 'mnemon')
const result = []
function check(label, condition, detail = '') {
  result.push({ label, ok: Boolean(condition) })
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`)
}
function openDb(file) {
  return new DatabaseSync(file, { readOnly: true })
}
function readState() {
  const sharing = openDb(path.join(config.sharingDir, 'memory.db'))
    .prepare('SELECT * FROM memories').all()
  const insights = new Map(openDb(path.join(config.mnemonHome, 'data/default/mnemon.db'))
    .prepare('SELECT * FROM insights').all().map((row) => [row.id, row]))
  const runtime = JSON.parse(fs.readFileSync(path.join(config.mnemonHome, 'runtime/memories.json'), 'utf8'))
  return { sharing, insights, runtime }
}
function counts() {
  const { sharing, insights, runtime } = readState()
  const active = sharing.filter((row) => !row.deleted_at && !row.archived)
  return {
    sharingTotal: sharing.length,
    sharingActive: active.length,
    tombstones: sharing.filter((row) => row.deleted_at).length,
    insights: insights.size,
    runtime: runtime.entries.length,
    hotUids: sharing.filter((row) => row.uid.startsWith('mnemon_rt_') && !row.deleted_at).map((row) => row.uid).sort(),
    foreignActive: active.filter((row) => !row.uid.startsWith('mnemon_')),
  }
}
function duplicateGroups(rows) {
  const seen = new Map()
  for (const row of rows) {
    const key = `${contentKey(row.title)}\n${contentKey(row.content)}`
    seen.set(key, (seen.get(key) || 0) + 1)
  }
  return new Set([...seen.entries()].filter(([, n]) => n > 1).map(([key]) => key))
}
function sync(options = {}) {
  return runSync(options)
}
function upstreamRef() {
  try {
    return execFileSync('git', ['-C', path.join(config.sharingDir, 'sync'), 'rev-parse', '--abbrev-ref', '@{upstream}'], { encoding: 'utf8' }).trim()
  } catch {
    return 'origin/main'
  }
}
function remoteDeviceSnapshot(deviceId) {
  execFileSync('git', ['-C', path.join(config.sharingDir, 'sync'), 'fetch', '--quiet', 'origin'], { encoding: 'utf8' })
  const text = execFileSync('git', ['-C', path.join(config.sharingDir, 'sync'), 'show', `${upstreamRef()}:devices/${deviceId}.json`], { encoding: 'utf8' })
  return JSON.parse(text)
}
function deviceId() {
  try {
    return JSON.parse(fs.readFileSync(path.join(config.sharingDir, 'config.json'), 'utf8')).deviceId || 'unknown'
  } catch {
    return 'unknown'
  }
}

const baseline = counts()
const baselineDup = duplicateGroups(readState().sharing)
console.log(`设备 ${deviceId()} · dsh-mnemon ${config.mnemonHome} · sharing ${config.sharingDir}`)
console.log(`基线：sharing ${baseline.sharingTotal}（活跃 ${baseline.sharingActive}）· insights ${baseline.insights} · 热记忆 ${baseline.runtime}`)

section('① 幂等：连续两次同步零新增')
const first = await sync()
check('第一次同步成功', first.ok, first.error || `\n${first.planned ? JSON.stringify(first.planned) : ''}`)
const afterFirst = counts()
const second = await sync()
check('第二次同步成功', second.ok, second.error || '')
const afterSecond = counts()
const planned = second.planned || {}
const zero = (kind) => (planned.sharing?.[kind] || 0) === 0 && (planned.dsh?.[kind] || 0) === 0
check('无新增条目', zero('inserted'), JSON.stringify(planned))
check('无更新条目', zero('updated'))
check('无墓碑变化', (planned.sharing?.tombstoned || 0) === 0)
check('条目数不变', afterSecond.sharingTotal === afterFirst.sharingTotal && afterSecond.insights === afterFirst.insights && afterSecond.runtime === afterFirst.runtime,
  `${afterFirst.sharingTotal}/${afterFirst.insights}/${afterFirst.runtime} → ${afterSecond.sharingTotal}/${afterSecond.insights}/${afterSecond.runtime}`)
check('原有 mnemon_rt_* uid 未被重新生成', JSON.stringify(afterSecond.hotUids) === JSON.stringify(afterFirst.hotUids), `${afterSecond.hotUids.length} 条`)
const dupSecond = duplicateGroups(readState().sharing)
const newDup = [...dupSecond].filter((key) => !baselineDup.has(key))
check('没有新增重复内容组', newDup.length === 0, newDup.length ? `${newDup.length} 组` : `既有 ${baselineDup.size} 组未扩大`)

section('② 推送：DSH 新建 → GitHub origin/main → 删除墓碑')
const token = Date.now()
const payload = `【DSH 同步验证 ${token}】由 verify.mjs 写入；用于证明 DSH 新记忆能推送到 zehank/sharing-memory，可安全删除。`
let remembered = null
try {
  remembered = JSON.parse(execFileSync(mnemonCli, [
    '--data-dir', config.mnemonHome,
    'remember', '--no-diff', '--cat', 'fact', '--imp', '3', '--source', 'agent', '--tags', 'sync-selftest,dsh-push',
    payload,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
} catch (error) {
  check('DSH 写入测试记忆', false, error.message)
}
if (remembered) {
  check('DSH 写入测试记忆', remembered.action === 'added', remembered.action)
  const uid = `mnemon_${remembered.id}`
  const pushedSync = await sync()
  check('同步报告推送', pushedSync.ok && (pushedSync.planned?.sharing?.inserted || 0) >= 1, JSON.stringify(pushedSync.planned?.sharing))
  const remote = remoteDeviceSnapshot(deviceId())
  const pushed = remote.memories.find((row) => row.uid === uid)
  check('GitHub origin/main 含该条（uid 稳定）', Boolean(pushed), uid)
  check('内容/类别/重要度正确', Boolean(pushed)
    && pushed.content.includes(String(token)) && pushed.category === 'fact' && pushed.importance === 3,
  pushed ? `${pushed.category}/${pushed.importance}` : 'missing')
  execFileSync(mnemonCli, ['--data-dir', config.mnemonHome, 'forget', remembered.id], { encoding: 'utf8' })
  const deletedSync = await sync()
  check('删除触发墓碑推送', deletedSync.ok && (deletedSync.planned?.sharing?.tombstoned || 0) === 1, JSON.stringify(deletedSync.planned?.sharing))
  const remoteAfter = remoteDeviceSnapshot(deviceId())
  const tomb = remoteAfter.memories.find((row) => row.uid === uid)
  check('GitHub origin/main 上是软删除墓碑', Boolean(tomb?.deleted_at), tomb?.deleted_at || 'missing')
}

section('③ 拉取：其他平台条目进入 dsh-mnemon')
const final = counts()
const { sharing, insights } = readState()
const missing = final.foreignActive.filter((row) => {
  const insight = insights.get(uuidFromSeed(`sharing:${row.uid}`))
  if (!insight || insight.deleted_at) return true
  return contentKey(insight.content) !== contentKey(row.content)
})
check('所有活跃 foreign 条目都在 mnemon.db 且内容一致', missing.length === 0,
  missing.length ? missing.map((row) => row.uid).slice(0, 5).join(', ') : `${final.foreignActive.length} 条`)
const row172 = sharing.find((row) => row.uid === 'm_mwwjtrsv_137fde')
if (row172 && !row172.deleted_at) {
  const insight = insights.get(uuidFromSeed('sharing:m_mwwjtrsv_137fde'))
  check('#172 已拉入 dsh-mnemon', Boolean(insight) && !insight.deleted_at, insight?.id || 'missing')
  check('#172 内容一致', Boolean(insight) && contentKey(insight.content) === contentKey(row172.content))
} else {
  check('#172 样本存在', false, 'm_mwwjtrsv_137fde 缺失或已删除，跳过该项')
}

const failed = result.filter((item) => !item.ok)
console.log(`\n${result.length - failed.length}/${result.length} 项通过`)
if (failed.length) {
  console.log(`失败：${failed.map((item) => item.label).join('；')}`)
  process.exitCode = 1
}
