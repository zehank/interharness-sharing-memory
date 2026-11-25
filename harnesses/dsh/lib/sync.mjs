/**
 * Bidirectional bridge between dsh-mnemon and the Antigravity `local-memory`
 * unified store (GitHub private repo zehank/sharing-memory).
 *
 * UID contract (fixed by the original 171-record import, never regenerated):
 *   persistent insight  <->  "mnemon_<insight uuid>"
 *   hot runtime entry   <->  "mnemon_rt_<8 hex>"  (existing ids are reused verbatim;
 *                             new entries derive a stable id from target+created_at)
 *   document            <->  "mnemon_doc_<document uuid>"  (left untouched)
 *
 * LWW uses `updated_at`; deletions travel as `deleted_at` tombstones. Every write
 * to one side sets that side's updated_at to the source timestamp, so a second
 * run compares equal timestamps and equal content and does nothing.
 */
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  acquireDirLock, contentKey, deriveTitle, expandHome, isNewer, maxTime,
  normalizeContent, nowIso, readJsonFile, resolveNodePath, sameStringSet, sha8, uuidFromSeed, writeJsonFile,
} from './util.mjs'
import {
  applySharingWrites, openSharingDb, readSharingConfig, readSharingMemories, resolveSharingPaths, runMemorySync,
} from './sharing.mjs'
import {
  appendOplog, applyInsightWrites, importanceToRuntime, importanceToSharing, openMnemonDb,
  readInsights, readRuntime, resolveMnemonPaths, runtimeKey, writeRuntime,
} from './mnemon.mjs'

export const CATEGORY_TO_SHARING = {
  preference: 'preference',
  fact: 'fact',
  decision: 'project',
  context: 'project',
  insight: 'pitfall',
  general: 'other',
}

export const CATEGORY_TO_MNEMON = {
  preference: 'preference',
  fact: 'fact',
  project: 'context',
  pitfall: 'insight',
  workflow: 'insight',
  other: 'general',
}

export function resolveConfig(overrides = {}) {
  return {
    sharingDir: expandHome(overrides.sharingDir || process.env.SHARING_MEMORY_DIR || '~/.gemini/memory'),
    mnemonHome: expandHome(overrides.mnemonHome || process.env.MNEMON_HOME || '~/.mnemon'),
    stateDir: expandHome(overrides.stateDir || process.env.SHARING_SYNC_STATE_DIR || '~/.dsh/sharing-memory-sync'),
    nodePath: resolveNodePath(overrides.nodePath || process.env.SHARING_SYNC_NODE || ''),
    serverPath: expandHome(
      overrides.serverPath || process.env.SHARING_MEMORY_SERVER
        || '~/.gemini/config/plugins/local-memory/server/memory-mcp.mjs',
    ),
    deviceId: overrides.deviceId || process.env.SHARING_SYNC_DEVICE_ID || '',
    direction: ['both', 'push', 'pull'].includes(overrides.direction) ? overrides.direction : 'both',
    dryRun: Boolean(overrides.dryRun),
    mirrorPinned: Boolean(overrides.mirrorPinned),
    timeoutMs: overrides.timeoutMs || 300000,
  }
}

function statePath(config) {
  return path.join(config.stateDir, 'state.json')
}

function lastRunPath(config) {
  return path.join(config.stateDir, 'last-run.json')
}

function loadState(config) {
  const raw = readJsonFile(statePath(config), null)
  const state = raw && raw.version === 1 ? raw : { version: 1, createdAt: nowIso() }
  state.rt = state.rt && typeof state.rt === 'object' ? state.rt : {}
  state.insightToSharing = state.insightToSharing && typeof state.insightToSharing === 'object' ? state.insightToSharing : {}
  state.sharingToInsight = state.sharingToInsight && typeof state.sharingToInsight === 'object' ? state.sharingToInsight : {}
  return state
}

function link(state, sharingUid, insightId) {
  state.sharingToInsight[sharingUid] = insightId
  state.insightToSharing[insightId] = sharingUid
}

function resolveDeviceId(config) {
  if (config.deviceId) return config.deviceId
  const fromConfig = readSharingConfig(config.sharingDir)?.deviceId
  if (fromConfig) return String(fromConfig).toLowerCase().replace(/[^a-z0-9._-]+/g, '-')
  return `${process.platform}-${os.hostname()}`.toLowerCase().replace(/[^a-z0-9._-]+/g, '-')
}

function rtTargetForRow(row, runtimeEntries) {
  if (row.tags.includes('user')) return 'user'
  if (row.tags.includes('memory')) return 'memory'
  const match = runtimeEntries.find((entry) => contentKey(entry.content) === contentKey(row.content))
  return match?.target || 'memory'
}

function runtimeEntryForRow(row, runtimeEntries) {
  const target = rtTargetForRow(row, runtimeEntries)
  const key = `${target}|${row.created_at}`
  const byKey = runtimeEntries.find((entry) => runtimeKey(entry) === key)
  if (byKey) return byKey
  return runtimeEntries.find((entry) => contentKey(entry.content) === contentKey(row.content)) || null
}

function findForeignInsight(row, insights, state) {
  const mappedId = state.sharingToInsight[row.uid]
  if (mappedId && insights.has(mappedId)) return insights.get(mappedId)
  const derived = uuidFromSeed(`sharing:${row.uid}`)
  if (insights.has(derived)) {
    link(state, row.uid, derived)
    return insights.get(derived)
  }
  const key = contentKey(row.content)
  for (const insight of insights.values()) {
    if (contentKey(insight.content) === key) {
      link(state, row.uid, insight.id)
      return insight
    }
  }
  return null
}

function recoverMappings(state, rows, insights, runtimeEntries) {
  for (const row of rows) {
    if (!row.uid.startsWith('mnemon_rt_')) continue
    const key = `${rtTargetForRow(row, runtimeEntries)}|${row.created_at}`
    if (!state.rt[key]) state.rt[key] = { uid: row.uid, owned: true, seen: false }
  }
  for (const entry of runtimeEntries) {
    const key = runtimeKey(entry)
    if (!state.rt[key]) state.rt[key] = { uid: `mnemon_rt_${sha8(`rt|${key}`)}`, owned: true, seen: true }
    else state.rt[key].seen = true
  }
  for (const row of rows) {
    if (row.uid.startsWith('mnemon_')) continue
    if (state.sharingToInsight[row.uid]) continue
    findForeignInsight(row, insights, state)
  }
  // Deterministic `mnemon_<uuid>` pairs need no stored mapping.
  for (const [uid, id] of Object.entries(state.sharingToInsight)) {
    if (uid !== `mnemon_${id}`) continue
    delete state.sharingToInsight[uid]
    if (state.insightToSharing[id] === uid) delete state.insightToSharing[id]
  }
}

function sameContent(left, right) {
  return contentKey(left) === contentKey(right)
}

function insightFields(insight) {
  return {
    content: normalizeContent(insight.content),
    category: CATEGORY_TO_SHARING[insight.category] || 'other',
    tags: insight.tags || [],
    importance: Math.max(1, Math.min(5, Number(insight.importance) || 3)),
  }
}

function insightRowFromSharing(row, { id, source }) {
  return {
    id,
    content: normalizeContent(row.content),
    category: CATEGORY_TO_MNEMON[row.category] || 'general',
    importance: Math.max(1, Math.min(5, Number(row.importance) || 3)),
    tags: row.tags || [],
    entities: [],
    source,
    access_count: Number(row.access_count) || 0,
    stored_at: row.created_at || row.updated_at || nowIso(),
    created_at: row.created_at || row.updated_at || nowIso(),
    updated_at: row.updated_at || row.created_at || nowIso(),
    deleted_at: null,
    last_accessed_at: row.last_accessed_at || null,
    effective_importance: Math.min(1, Math.max(0.1, (Number(row.importance) || 3) / 5)),
  }
}

function insightDiffers(insight, row) {
  return !sameContent(insight.content, row.content)
    || (CATEGORY_TO_SHARING[insight.category] || 'other') !== row.category
    || Number(insight.importance) !== Number(row.importance)
    || !sameStringSet(insight.tags, row.tags)
}

function runtimeFields(entry) {
  return {
    title: deriveTitle(entry.content),
    content: normalizeContent(entry.content),
    category: entry.target === 'user' ? 'preference' : 'fact',
    tags: ['mnemon-runtime', entry.target],
    importance: importanceToSharing(entry.importance),
    pinned: true,
  }
}

function runtimeDiffers(entry, row) {
  return !sameContent(entry.content, row.content)
    || importanceToSharing(entry.importance) !== Number(row.importance)
}

function buildOutbound({ rows, insights, runtimeEntries, state, deviceId, now }) {
  const writes = []
  const rowByUid = new Map(rows.map((row) => [row.uid, row]))
  const foreignByContent = new Map()
  for (const row of rows) {
    if (row.uid.startsWith('mnemon_') || row.deleted_at) continue
    foreignByContent.set(contentKey(row.content), row)
  }

  for (const insight of insights.values()) {
    const uid = state.insightToSharing[insight.id] || `mnemon_${insight.id}`
    const row = rowByUid.get(uid)

    if (insight.deleted_at) {
      if (row && (!row.deleted_at || isNewer(insight.deleted_at, row.deleted_at))) {
        writes.push({ type: 'tombstone', uid, at: maxTime(insight.deleted_at, insight.updated_at) || now })
      }
      continue
    }
    if (row) {
      if (row.deleted_at) {
        if (isNewer(insight.updated_at, row.deleted_at)) {
          writes.push({
            type: 'update',
            uid,
            ...insightFields(insight),
            deleted_at: null,
            updated_at: insight.updated_at,
            source_device: deviceId,
          })
        }
        continue
      }
      if (isNewer(insight.updated_at, row.updated_at) && insightDiffers(insight, row)) {
        writes.push({
          type: 'update',
          uid,
          ...insightFields(insight),
          deleted_at: null,
          updated_at: insight.updated_at,
          source_device: deviceId,
        })
      }
      continue
    }

    const alias = foreignByContent.get(contentKey(insight.content))
    if (alias) {
      link(state, alias.uid, insight.id)
      continue
    }
    writes.push({
      type: 'insert',
      uid,
      title: deriveTitle(insight.content),
      ...insightFields(insight),
      created_at: insight.created_at || insight.updated_at || now,
      updated_at: insight.updated_at || insight.created_at || now,
      deleted_at: null,
      source_device: deviceId,
    })
  }

  const runtimeKeys = new Set()
  for (const entry of runtimeEntries) {
    const key = runtimeKey(entry)
    runtimeKeys.add(key)
    if (!state.rt[key]) state.rt[key] = { uid: `mnemon_rt_${sha8(`rt|${key}`)}`, owned: true, seen: true }
    const mapping = state.rt[key]
    mapping.seen = true
    if (mapping.deleted) mapping.deleted = false
    const row = rowByUid.get(mapping.uid)
    if (!row) {
      writes.push({
        type: 'insert',
        uid: mapping.uid,
        ...runtimeFields(entry),
        created_at: entry.created_at,
        updated_at: entry.updated_at,
        deleted_at: null,
        source_device: deviceId,
      })
      continue
    }
    if (row.deleted_at) {
      if (isNewer(entry.updated_at, row.deleted_at)) {
        writes.push({
          type: 'update',
          uid: mapping.uid,
          ...runtimeFields(entry),
          title: row.title,
          category: row.category,
          tags: row.tags,
          pinned: row.pinned,
          deleted_at: null,
          updated_at: entry.updated_at,
          source_device: deviceId,
        })
      }
      continue
    }
    if (isNewer(entry.updated_at, row.updated_at) && runtimeDiffers(entry, row)) {
      writes.push({
        type: 'update',
        uid: mapping.uid,
        ...runtimeFields(entry),
        title: row.title,
        category: row.category,
        tags: row.tags,
        pinned: row.pinned,
        deleted_at: null,
        updated_at: entry.updated_at,
        source_device: deviceId,
      })
    }
  }

  for (const [key, mapping] of Object.entries(state.rt)) {
    if (mapping.deleted) continue
    if (runtimeKeys.has(key)) continue
    // Only an entry this machine actually held can be reported as deleted. A hot row
    // that arrived from another device is "not in runtime yet", not a deletion.
    if (mapping.seen !== true) continue
    if (mapping.owned === false) continue
    const row = rowByUid.get(mapping.uid)
    if (row && !row.deleted_at) writes.push({ type: 'tombstone', uid: mapping.uid, at: now })
    mapping.deleted = true
  }

  return { writes, foreignByContent }
}

function buildInbound({ rows, insights, runtimeEntries, state, mirrorPinned, now }) {
  const insightWrites = []
  const runtimeAdds = []
  const runtimeUpdates = []
  const runtimeRemovals = []
  const oplog = []

  for (const row of rows) {
    if (row.uid.startsWith('mnemon_doc_')) continue
    const isRt = row.uid.startsWith('mnemon_rt_')
    const isInsight = row.uid.startsWith('mnemon_') && !isRt

    if (row.deleted_at) {
      if (isInsight) {
        const insight = insights.get(row.uid.slice(7))
        if (insight && !insight.deleted_at && isNewer(row.deleted_at, insight.updated_at)) {
          insightWrites.push({
            type: 'update',
            id: insight.id,
            deleted_at: row.deleted_at,
            updated_at: maxTime(row.deleted_at, row.updated_at),
          })
        }
      } else if (isRt) {
        const entry = runtimeEntryForRow(row, runtimeEntries)
        if (entry && isNewer(row.deleted_at, entry.updated_at)) runtimeRemovals.push(runtimeKey(entry))
        for (const [key, mapping] of Object.entries(state.rt)) {
          if (mapping.uid === row.uid && mapping.owned !== false) mapping.deleted = true
        }
      } else {
        const insight = findForeignInsight(row, insights, state)
        if (insight && !insight.deleted_at && isNewer(row.deleted_at, insight.updated_at)) {
          insightWrites.push({
            type: 'update',
            id: insight.id,
            deleted_at: row.deleted_at,
            updated_at: maxTime(row.deleted_at, row.updated_at),
          })
        }
      }
      continue
    }
    if (row.archived) continue

    if (isInsight) {
      const id = row.uid.slice(7)
      const insight = insights.get(id)
      if (!insight) {
        insightWrites.push({ type: 'insert', row: insightRowFromSharing(row, { id, source: 'agent' }) })
        insights.set(id, { id, content: row.content, updated_at: row.updated_at, deleted_at: null })
        oplog.push({ insightId: id, detail: `pulled ${row.uid}`, at: now })
      } else if (isNewer(row.updated_at, insight.updated_at)
        && (insight.deleted_at || !sameContent(row.content, insight.content)
          || !sameStringSet(row.tags, insight.tags) || Number(row.importance) !== Number(insight.importance))) {
        insightWrites.push({
          type: 'update',
          id,
          content: normalizeContent(row.content),
          tags: row.tags,
          importance: Number(row.importance) || 3,
          updated_at: row.updated_at,
          deleted_at: null,
        })
      }
      continue
    }

    if (isRt) {
      const target = rtTargetForRow(row, runtimeEntries)
      const key = `${target}|${row.created_at}`
      const entry = runtimeEntries.find((item) => runtimeKey(item) === key)
        || runtimeEntries.find((item) => sameContent(item.content, row.content))
      if (entry) {
        if (isNewer(row.updated_at, entry.updated_at)
          && (!sameContent(row.content, entry.content) || importanceToSharing(entry.importance) !== Number(row.importance))) {
          runtimeUpdates.push({
            key: runtimeKey(entry),
            content: normalizeContent(row.content),
            importance: importanceToRuntime(row.importance),
            updated_at: row.updated_at,
          })
        }
      } else {
        const mapping = state.rt[key]
        if (mapping?.deleted) continue
        runtimeAdds.push({
          key,
          uid: row.uid,
          target,
          content: normalizeContent(row.content),
          importance: importanceToRuntime(row.importance),
          created_at: row.created_at || now,
          updated_at: row.updated_at || now,
        })
      }
      continue
    }

    const insight = findForeignInsight(row, insights, state)
    if (!insight) {
      const id = uuidFromSeed(`sharing:${row.uid}`)
      insightWrites.push({ type: 'insert', row: insightRowFromSharing(row, { id, source: 'external' }) })
      link(state, row.uid, id)
      insights.set(id, { id, content: row.content, updated_at: row.updated_at, deleted_at: null })
      oplog.push({ insightId: id, detail: `pulled ${row.uid} (${row.source_device || 'other device'})`, at: now })
    } else if (isNewer(row.updated_at, insight.updated_at)
      && (insight.deleted_at || !sameContent(row.content, insight.content)
        || !sameStringSet(row.tags, insight.tags) || Number(row.importance) !== Number(insight.importance))) {
      insightWrites.push({
        type: 'update',
        id: insight.id,
        content: normalizeContent(row.content),
        tags: row.tags,
        importance: Number(row.importance) || 3,
        updated_at: row.updated_at,
        deleted_at: null,
      })
    }

    if (mirrorPinned && (row.pinned || Number(row.importance) >= 4)) {
      const target = 'memory'
      const key = `${target}|${row.created_at}`
      const exists = runtimeEntries.some((entry) => sameContent(entry.content, row.content))
      if (!exists && !state.rt[key]) {
        runtimeAdds.push({
          key,
          uid: row.uid,
          target,
          content: normalizeContent(row.content),
          importance: importanceToRuntime(row.importance),
          created_at: row.created_at || now,
          updated_at: row.updated_at || now,
          mirror: true,
        })
      }
    }
  }

  return { insightWrites, runtimeAdds, runtimeUpdates, runtimeRemovals, oplog }
}

function planRuntimeWrite(runtime, inbound) {
  const entries = runtime.entries.map((entry) => ({ ...entry }))
  const byKey = new Map(entries.map((entry) => [runtimeKey(entry), entry]))
  for (const change of inbound.runtimeUpdates) {
    const entry = byKey.get(change.key)
    if (!entry) continue
    entry.content = change.content
    entry.importance = change.importance
    entry.updated_at = change.updated_at
  }
  for (const key of new Set(inbound.runtimeRemovals)) {
    const index = entries.findIndex((entry) => runtimeKey(entry) === key)
    if (index >= 0) entries.splice(index, 1)
  }
  const added = []
  for (const add of inbound.runtimeAdds) {
    if (entries.some((entry) => sameContent(entry.content, add.content))) continue
    entries.push({
      content: add.content,
      target: add.target,
      importance: add.importance,
      created_at: add.created_at,
      updated_at: add.updated_at,
    })
    added.push(add)
  }
  return { entries, added }
}

function gitInfo(syncDir) {
  try {
    const run = (args) => execFileSync('git', ['-C', syncDir, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    const branch = run(['rev-parse', '--abbrev-ref', 'HEAD'])
    const dirty = run(['status', '--porcelain'])
    let ahead = 0
    let behind = 0
    try {
      const counts = run(['rev-list', '--left-right', '--count', '@{upstream}...HEAD']).split(/\s+/)
      behind = Number(counts[0]) || 0
      ahead = Number(counts[1]) || 0
    } catch {}
    let lastCommit = ''
    try { lastCommit = run(['log', '-1', '--format=%h %s']) } catch {}
    return { branch, dirtyFiles: dirty ? dirty.split('\n').length : 0, ahead, behind, lastCommit }
  } catch (error) {
    return { error: error.message }
  }
}

function countWrites(writes) {
  const counts = { inserted: 0, updated: 0, tombstoned: 0, skipped: 0 }
  for (const write of writes) {
    if (write.type === 'insert') counts.inserted += 1
    else if (write.type === 'update') counts.updated += 1
    else if (write.type === 'tombstone') counts.tombstoned += 1
  }
  return counts
}

function summarizeSync(sync) {
  if (!sync) return { skipped: true }
  if (!sync.ok) return { ok: false, error: sync.error, stderr: (sync.stderr || '').slice(0, 800) }
  const result = sync.result || {}
  return {
    ok: true,
    merge: result.merge || null,
    pull: String(result.git?.pull || '').slice(0, 400) || null,
    push: String(result.git?.push || '').slice(0, 400) || null,
    commit: result.git?.commit || null,
    warnings: [result.git?.pull_warning, result.git?.push_warning, result.git?.git_error].filter(Boolean),
  }
}

export async function runSync(overrides = {}) {
  const config = resolveConfig(overrides)
  const started = Date.now()
  const now = nowIso()
  const release = acquireDirLock(path.join(config.stateDir, 'sync.lock'))
  const summary = {
    ok: true,
    at: now,
    deviceId: '',
    direction: config.direction,
    dryRun: config.dryRun,
    sharing: null,
    dsh: null,
    sync: null,
    warnings: [],
    errors: [],
    paths: {
      sharingDir: config.sharingDir,
      mnemonHome: config.mnemonHome,
      state: statePath(config),
      lastRun: lastRunPath(config),
    },
  }

  try {
    const deviceId = resolveDeviceId(config)
    summary.deviceId = deviceId
    const sharingPaths = resolveSharingPaths(config.sharingDir)
    const mnemonPaths = resolveMnemonPaths(config.mnemonHome)
    const state = loadState(config)
    const runtime = readRuntime(config.mnemonHome)
    const sharingDb = openSharingDb(sharingPaths.dbPath)
    const mnemonDb = openMnemonDb(mnemonPaths.dbPath)

    let rows = readSharingMemories(sharingDb)
    let insights = readInsights(mnemonDb)
    recoverMappings(state, rows, insights, runtime.entries)

    const beforeRows = rows.length
    const beforeInsights = insights.size
    const beforeRuntime = runtime.entries.length

    let outbound = { writes: [] }
    if (config.direction !== 'pull') {
      outbound = buildOutbound({
        rows,
        insights,
        runtimeEntries: runtime.entries,
        state,
        deviceId,
        now,
      })
      summary.planned = { ...(summary.planned || {}), sharing: countWrites(outbound.writes) }
      if (!config.dryRun && outbound.writes.length) {
        summary.sharingWrites = applySharingWrites(sharingDb, outbound.writes)
      }
    }

    if (!config.dryRun) {
      summary.sync = summarizeSync(await runMemorySync({
        nodePath: config.nodePath,
        serverPath: config.serverPath,
        timeoutMs: config.timeoutMs,
        dataDir: config.sharingDir,
        syncDir: sharingPaths.syncDir,
        deviceId,
      }))
      if (!summary.sync.ok) summary.warnings.push(`memory_sync: ${summary.sync.error || 'failed'}`)
      if (summary.sync.warnings?.length) summary.warnings.push(...summary.sync.warnings)
    }

    rows = readSharingMemories(sharingDb)
    insights = readInsights(mnemonDb)

    let inbound = { insightWrites: [], runtimeAdds: [], runtimeUpdates: [], runtimeRemovals: [], oplog: [] }
    if (config.direction !== 'push') {
      inbound = buildInbound({
        rows,
        insights,
        runtimeEntries: runtime.entries,
        state,
        mirrorPinned: config.mirrorPinned,
        now,
      })

      summary.planned = {
        ...(summary.planned || {}),
        dsh: countWrites(inbound.insightWrites.map((write) => (write.type === 'insert' ? { type: 'insert' } : write))),
      }
      if (!config.dryRun) {
        summary.mnemonWrites = applyInsightWrites(mnemonDb, inbound.insightWrites)
        if (inbound.oplog.length) appendOplog(mnemonDb, inbound.oplog)
      }

      const planned = planRuntimeWrite(runtime, inbound)
      let writePlan = planned
      let runtimeError = null
      if (!config.dryRun && (inbound.runtimeAdds.length || inbound.runtimeUpdates.length || inbound.runtimeRemovals.length)) {
        try {
          writeRuntime(mnemonPaths, writePlan.entries)
        } catch (error) {
          runtimeError = error.message
          // Retry without the newly added entries; never let the hot layer exceed its cap.
          const retry = planRuntimeWrite(runtime, { ...inbound, runtimeAdds: [] })
          try {
            writeRuntime(mnemonPaths, retry.entries)
            writePlan = retry
            runtimeError = `${runtimeError}; applied updates/removals only`
          } catch (secondError) {
            runtimeError = `${runtimeError}; retry failed: ${secondError.message}`
            writePlan = { entries: runtime.entries, added: [] }
          }
        }
      }
      if (runtimeError) summary.warnings.push(`runtime: ${runtimeError}`)
      for (const add of writePlan.added) {
        state.rt[add.key] = { uid: add.uid, owned: !add.mirror, seen: true }
      }
      for (const key of new Set(inbound.runtimeRemovals)) {
        if (state.rt[key]) state.rt[key].deleted = true
      }
      summary.runtime = {
        added: writePlan.added.length,
        updated: inbound.runtimeUpdates.length,
        removed: new Set(inbound.runtimeRemovals).size,
        applied: !config.dryRun && !runtimeError,
      }
    }

    state.version = 1
    state.deviceId = deviceId
    state.updatedAt = nowIso()
    if (!config.dryRun) writeJsonFile(statePath(config), state)

    const afterRows = readSharingMemories(sharingDb)
    const afterInsights = readInsights(mnemonDb)
    const afterRuntime = readRuntime(config.mnemonHome).entries

    summary.sharing = {
      before: beforeRows,
      after: afterRows.length,
      active: afterRows.filter((row) => !row.deleted_at && !row.archived).length,
      tombstones: afterRows.filter((row) => row.deleted_at).length,
      writes: summary.sharingWrites || null,
    }
    summary.dsh = {
      before: beforeInsights,
      after: afterInsights.size,
      runtimeBefore: beforeRuntime,
      runtimeAfter: afterRuntime.length,
      insightWrites: summary.mnemonWrites || null,
    }
    summary.git = gitInfo(sharingPaths.syncDir)
    summary.ms = Date.now() - started
    if (!config.dryRun) writeJsonFile(lastRunPath(config), summary)
    return summary
  } catch (error) {
    summary.ok = false
    summary.error = error?.message || String(error)
    summary.ms = Date.now() - started
    try { writeJsonFile(lastRunPath(config), summary) } catch {}
    return summary
  } finally {
    release()
  }
}

export function runStatus(overrides = {}) {
  const config = resolveConfig(overrides)
  const sharingPaths = resolveSharingPaths(config.sharingDir)
  const mnemonPaths = resolveMnemonPaths(config.mnemonHome)
  const state = loadState(config)
  const lastRun = readJsonFile(lastRunPath(config), null)
  const result = {
    ok: true,
    deviceId: resolveDeviceId(config),
    at: nowIso(),
    paths: {
      sharingDir: sharingPaths.dir,
      syncDir: sharingPaths.syncDir,
      mnemonHome: mnemonPaths.home,
      state: statePath(config),
    },
    autoSync: null,
  }
  try {
    const sharingDb = openSharingDb(sharingPaths.dbPath, { readOnly: true })
    const rows = readSharingMemories(sharingDb)
    result.sharing = {
      total: rows.length,
      active: rows.filter((row) => !row.deleted_at && !row.archived).length,
      archived: rows.filter((row) => row.archived && !row.deleted_at).length,
      tombstones: rows.filter((row) => row.deleted_at).length,
      foreign: rows.filter((row) => !row.uid.startsWith('mnemon_')).length,
      linkedInsights: rows.filter((row) => /^mnemon_[0-9a-f-]{36}$/i.test(row.uid)).length,
      hot: rows.filter((row) => row.uid.startsWith('mnemon_rt_')).length,
      docs: rows.filter((row) => row.uid.startsWith('mnemon_doc_')).length,
    }
  } catch (error) {
    result.sharing = { error: error.message }
  }
  try {
    const runtime = readRuntime(config.mnemonHome)
    result.dsh = { runtimeEntries: runtime.entries.length }
  } catch (error) {
    result.dsh = { error: error.message }
  }
  try {
    const mnemonDb = openMnemonDb(mnemonPaths.dbPath)
    const insights = readInsights(mnemonDb)
    result.dsh = {
      ...(result.dsh || {}),
      insights: insights.size,
      tombstonedInsights: [...insights.values()].filter((row) => row.deleted_at).length,
    }
  } catch (error) {
    result.dsh = { ...(result.dsh || {}), error: error.message }
  }
  result.mappings = {
    runtime: Object.keys(state.rt).length,
    foreign: Object.keys(state.sharingToInsight).length,
  }
  result.git = gitInfo(sharingPaths.syncDir)
  result.lastRun = lastRun
    ? { at: lastRun.at, ok: lastRun.ok, direction: lastRun.direction, error: lastRun.error || null, ms: lastRun.ms }
    : null
  return result
}
