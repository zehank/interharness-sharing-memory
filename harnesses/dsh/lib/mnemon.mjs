/**
 * The dsh-mnemon side: its SQLite insight store and the runtime hot layer
 * (`~/.mnemon/runtime/memories.json`, whose two Markdown projections dsh-mnemon
 * regenerates from that single source of truth).
 *
 * Runtime writes take the same `.memories.lock` dsh-mnemon takes, validate the
 * same limits, and rewrite both projections exactly like its own control layer.
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  acquireFileLock, contentKey, normalizeContent, nowIso, readJsonFile, utf8Bytes,
} from './util.mjs'

export const RUNTIME_LIMITS = { user: 4096, memory: 10240 }
export const RUNTIME_ENTRY_MAX_BYTES = 8192
export const RUNTIME_PINNED_PROJECTION_LIMIT = 1536
export const RUNTIME_LOCK_FILE = '.memories.lock'
export const RUNTIME_LOCK_STALE_MS = 30000
const IMPORTANCE = new Set(['critical', 'normal', 'low'])

export function resolveMnemonPaths(mnemonHome) {
  return {
    home: mnemonHome,
    dataDir: path.join(mnemonHome, 'data', 'default'),
    dbPath: path.join(mnemonHome, 'data', 'default', 'mnemon.db'),
    runtimeDir: path.join(mnemonHome, 'runtime'),
    runtimeFile: path.join(mnemonHome, 'runtime', 'memories.json'),
  }
}

export function openMnemonDb(dbPath) {
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA busy_timeout = 5000')
  return db
}

export function parseTags(value) {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

export function readInsights(db) {
  const rows = db.prepare('SELECT * FROM insights').all()
  const map = new Map()
  for (const row of rows) {
    map.set(row.id, { ...row, tags: parseTags(row.tags) })
  }
  return map
}

function insightInsert(db, row) {
  db.prepare(`INSERT INTO insights
    (id, content, category, importance, tags, entities, source, access_count,
     stored_at, created_at, updated_at, deleted_at, last_accessed_at, embedding, effective_importance)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`)
    .run(
      row.id,
      row.content,
      row.category || 'general',
      row.importance || 3,
      JSON.stringify(row.tags || []),
      JSON.stringify(row.entities || []),
      row.source || 'external',
      row.access_count || 0,
      row.stored_at || row.created_at || nowIso(),
      row.created_at || nowIso(),
      row.updated_at || nowIso(),
      row.deleted_at || null,
      row.last_accessed_at || null,
      row.effective_importance ?? Math.min(1, Math.max(0.1, (row.importance || 3) / 5)),
    )
}

const UPDATABLE = ['content', 'category', 'importance', 'tags', 'updated_at', 'deleted_at']

export function applyInsightWrites(db, writes) {
  const counts = { inserted: 0, updated: 0, skipped: 0 }
  if (!writes.length) return counts
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const write of writes) {
      if (write.type === 'insert') {
        const existing = db.prepare('SELECT id FROM insights WHERE id = ?').get(write.row.id)
        if (existing) { counts.skipped += 1; continue }
        insightInsert(db, write.row)
        counts.inserted += 1
        continue
      }
      const sets = []
      const values = []
      for (const key of UPDATABLE) {
        if (write[key] === undefined) continue
        sets.push(`${key} = ?`)
        values.push(key === 'tags' ? JSON.stringify(write.tags) : write[key])
      }
      if (!sets.length) { counts.skipped += 1; continue }
      const result = db.prepare(`UPDATE insights SET ${sets.join(', ')} WHERE id = ?`).run(...values, write.id)
      if (result.changes) counts.updated += 1
      else counts.skipped += 1
    }
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch {}
    throw error
  }
  return counts
}

export function appendOplog(db, rows) {
  if (!rows.length) return
  const insert = db.prepare('INSERT INTO oplog (operation, insight_id, detail, created_at) VALUES (?, ?, ?, ?)')
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const row of rows) insert.run('sync', row.insightId || '', row.detail || '', row.at || nowIso())
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch {}
    throw error
  }
}

export function runtimeKey(entry) {
  return `${entry.target}|${entry.created_at}`
}

export function runtimeBytes(entries, target) {
  const content = entries.filter((e) => e.target === target).map((e) => e.content).join('\n§\n')
  return utf8Bytes(content)
}

export function runtimeProjection(entries, target) {
  const content = entries.filter((e) => e.target === target).map((e) => e.content).join('\n§\n')
  return content === '' ? '' : `${content}\n`
}

function pinnedProjection(entries, target) {
  const pinned = entries.filter((e) => e.target === target && e.pinned === true)
  if (!pinned.length) return ''
  return `${target === 'user' ? 'USER.md' : 'MEMORY.md'} pinned entries:\n`
    + pinned.map((e) => `[pinned; importance=${e.importance}]\n${e.content}`).join('\n§\n')
    + '\n'
}

export function validateRuntime(entries, limits = RUNTIME_LIMITS) {
  for (const entry of entries) {
    if (!IMPORTANCE.has(entry.importance)) throw new Error(`runtime entry has invalid importance: ${entry.importance}`)
    if (entry.target !== 'user' && entry.target !== 'memory') throw new Error('runtime entry has invalid target')
    if (typeof entry.content !== 'string' || entry.content === '') throw new Error('runtime entry has empty content')
    if (entry.content.includes('§')) throw new Error('runtime entry contains the § separator')
    if (utf8Bytes(entry.content) > RUNTIME_ENTRY_MAX_BYTES) throw new Error('runtime entry exceeds 8192 bytes')
    if (typeof entry.created_at !== 'string' || typeof entry.updated_at !== 'string') throw new Error('runtime entry has invalid timestamps')
    if (entry.pinned !== undefined && typeof entry.pinned !== 'boolean') throw new Error('runtime entry has invalid pinned flag')
  }
  for (const target of ['user', 'memory']) {
    const used = runtimeBytes(entries, target)
    if (used > limits[target]) throw new Error(`runtime ${target} memory holds ${used} bytes (limit ${limits[target]})`)
  }
  for (const target of ['user', 'memory']) {
    const chars = pinnedProjection(entries, target).length
    if (chars > RUNTIME_PINNED_PROJECTION_LIMIT) throw new Error(`pinned ${target} projection is ${chars} chars (limit ${RUNTIME_PINNED_PROJECTION_LIMIT})`)
  }
  return true
}

function normalizeEntry(entry) {
  const out = {
    content: normalizeContent(entry.content),
    target: entry.target,
    importance: entry.importance,
    created_at: entry.created_at,
    updated_at: entry.updated_at,
  }
  if (entry.pinned !== undefined) out.pinned = entry.pinned
  if (Array.isArray(entry.branches)) out.branches = entry.branches
  if (entry.origin !== undefined) out.origin = entry.origin
  return out
}

export function readRuntime(mnemonHome) {
  const paths = resolveMnemonPaths(mnemonHome)
  if (!fs.existsSync(paths.runtimeFile)) {
    return { paths, entries: [], exists: false }
  }
  const file = readJsonFile(paths.runtimeFile, null)
  if (!file || file.version !== 1 || !Array.isArray(file.entries)) {
    throw new Error(`${paths.runtimeFile} is not a valid dsh-mnemon runtime source`)
  }
  return { paths, entries: file.entries.map(normalizeEntry), exists: true }
}

function writeFileAtomic(file, content, mode = 0o600) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, content, { mode })
  fs.renameSync(tmp, file)
}

/** Rewrite memories.json plus both Markdown projections under dsh-mnemon's runtime lock. */
export function writeRuntime(paths, entries) {
  validateRuntime(entries)
  fs.mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 })
  const release = acquireFileLock(path.join(paths.runtimeDir, RUNTIME_LOCK_FILE), {
    staleMs: RUNTIME_LOCK_STALE_MS,
  })
  try {
    const file = { version: 1, entries }
    writeFileAtomic(paths.runtimeFile, `${JSON.stringify(file, null, 2)}\n`)
    writeFileAtomic(path.join(paths.runtimeDir, 'USER.md'), runtimeProjection(entries, 'user'))
    writeFileAtomic(path.join(paths.runtimeDir, 'MEMORY.md'), runtimeProjection(entries, 'memory'))
  } finally {
    release()
  }
}

/** dsh-mnemon importance enum → Antigravity 1..5. */
export function importanceToSharing(importance) {
  if (importance === 'critical') return 5
  if (importance === 'low') return 1
  return 3
}

/** Antigravity 1..5 → dsh-mnemon importance enum. */
export function importanceToRuntime(value) {
  const n = Number(value) || 3
  if (n >= 5) return 'critical'
  if (n >= 3) return 'normal'
  return 'low'
}

export function runtimeEntryKeyByContent(entries, content) {
  const key = contentKey(content)
  return entries.find((entry) => contentKey(entry.content) === key) || null
}
