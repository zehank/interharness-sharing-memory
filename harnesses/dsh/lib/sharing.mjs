/**
 * The Antigravity `local-memory` side: read/write its SQLite store and drive its
 * official `memory_sync` MCP tool (pull --rebase --autostash, LWW merge of every
 * `devices/*.json`, MEMORY.md mirror, commit and push).
 *
 * We never copy the database into Git and never edit the local-memory plugin
 * directory; the MCP server stays the only writer of the Git sync flow.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { childPathEnv, nowIso } from './util.mjs'

export function resolveSharingPaths(sharingDir) {
  return {
    dir: sharingDir,
    dbPath: path.join(sharingDir, 'memory.db'),
    syncDir: path.join(sharingDir, 'sync'),
    configPath: path.join(sharingDir, 'config.json'),
  }
}

export function openSharingDb(dbPath, { readOnly = false } = {}) {
  const db = readOnly ? new DatabaseSync(dbPath, { readOnly: true }) : new DatabaseSync(dbPath)
  if (!readOnly) db.exec('PRAGMA busy_timeout = 5000')
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

export function readSharingMemories(db) {
  const rows = db.prepare('SELECT * FROM memories').all()
  return rows.map((row) => ({
    ...row,
    tags: parseTags(row.tags),
    pinned: Boolean(row.pinned),
    archived: Boolean(row.archived),
  }))
}

export function readSharingLinks(db) {
  return db.prepare('SELECT * FROM memory_links').all()
}

export function readSharingConfig(sharingDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(sharingDir, 'config.json'), 'utf8'))
  } catch {
    return {}
  }
}

const INSERT_SQL = `INSERT INTO memories
  (uid, title, content, category, tags, project, importance, pinned, archived,
   access_count, last_accessed_at, source_device, created_at, updated_at, deleted_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

const UPDATE_SQL = `UPDATE memories
  SET title = ?, content = ?, category = ?, tags = ?, project = ?, importance = ?,
      pinned = ?, archived = ?, access_count = ?, last_accessed_at = ?,
      source_device = ?, updated_at = ?, deleted_at = ?
  WHERE uid = ?`

/** Apply LWW-decided rows into memory.db. Returns per-kind counts. */
export function applySharingWrites(db, writes) {
  const counts = { inserted: 0, updated: 0, tombstoned: 0, skipped: 0 }
  if (!writes.length) return counts
  const select = db.prepare('SELECT * FROM memories WHERE uid = ?')
  const insert = db.prepare(INSERT_SQL)
  const update = db.prepare(UPDATE_SQL)
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const write of writes) {
      const existing = select.get(write.uid)
      if (write.type === 'insert') {
        if (existing) { counts.skipped += 1; continue }
        insert.run(
          write.uid,
          write.title,
          write.content,
          write.category,
          JSON.stringify(write.tags || []),
          write.project || '',
          write.importance,
          write.pinned ? 1 : 0,
          0,
          0,
          null,
          write.source_device || '',
          write.created_at || nowIso(),
          write.updated_at || nowIso(),
          write.deleted_at || null,
        )
        counts.inserted += 1
      } else if (write.type === 'update') {
        if (!existing) { counts.skipped += 1; continue }
        update.run(
          write.title ?? existing.title,
          write.content ?? existing.content,
          write.category ?? existing.category,
          JSON.stringify(write.tags ?? parseTags(existing.tags)),
          write.project ?? existing.project,
          write.importance ?? existing.importance,
          (write.pinned ?? Boolean(existing.pinned)) ? 1 : 0,
          Boolean(existing.archived) ? 1 : 0,
          existing.access_count || 0,
          existing.last_accessed_at || null,
          write.source_device || existing.source_device || '',
          write.updated_at || existing.updated_at,
          write.deleted_at === undefined ? existing.deleted_at : write.deleted_at,
          write.uid,
        )
        counts.updated += 1
      } else if (write.type === 'tombstone') {
        if (!existing) { counts.skipped += 1; continue }
        if (existing.deleted_at && String(existing.updated_at || '') === String(write.at || '')) {
          counts.skipped += 1
          continue
        }
        db.prepare('UPDATE memories SET deleted_at = ?, updated_at = ? WHERE uid = ?')
          .run(write.at, write.at, write.uid)
        counts.tombstoned += 1
      }
    }
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch {}
    throw error
  }
  return counts
}

/**
 * Run local-memory's own `memory_sync` over JSON-RPC stdio.
 *
 * The child gets MEMORY_AUTO_SYNC=false so `memory_sync` runs synchronously instead
 * of racing the plugin's background timer; if a background pass is still reported
 * as in flight, we keep the same child and ask again until it answers with a real
 * `git` log (bounded).
 */
export function runMemorySync({
  nodePath, serverPath, timeoutMs = 300000, dataDir, syncDir, deviceId,
}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(nodePath, ['--no-warnings', serverPath], {
        env: {
          ...process.env,
          ...(dataDir ? { MEMORY_DATA_DIR: dataDir } : {}),
          ...(syncDir ? { MEMORY_SYNC_DIR: syncDir } : {}),
          ...(deviceId ? { MEMORY_DEVICE_ID: deviceId } : {}),
          MEMORY_AUTO_SYNC: 'false',
          PATH: childPathEnv(),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ ok: false, error: error.message })
      return
    }

    let buffer = ''
    let stderr = ''
    let settled = false
    let requestId = 2
    let attempts = 0
    let retryTimer = null

    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (retryTimer) clearTimeout(retryTimer)
      try { child.kill('SIGKILL') } catch {}
      resolve({ ...value, stderr: stderr.trim() })
    }
    const timer = setTimeout(
      () => finish({ ok: false, error: `memory_sync timed out after ${timeoutMs}ms` }),
      timeoutMs,
    )

    const sendSync = () => {
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: requestId,
        method: 'tools/call',
        params: { name: 'memory_sync', arguments: {} },
      })}\n`)
    }

    child.on('error', (error) => finish({ ok: false, error: error.message }))
    child.on('close', (code) => {
      if (!settled) finish({ ok: false, error: `memory_sync process exited early (code ${code})` })
    })
    child.stderr.on('data', (chunk) => { stderr += chunk })

    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (!line) continue
        let message
        try { message = JSON.parse(line) } catch { continue }
        if (message?.id !== requestId) continue
        if (message.error) {
          finish({ ok: false, error: message.error.message || 'memory_sync failed' })
          return
        }
        const text = message.result?.content?.find((part) => part?.type === 'text')?.text
        let payload = null
        try { payload = text ? JSON.parse(text) : null } catch { payload = { raw: text } }
        if (payload?.in_flight && attempts < 6) {
          attempts += 1
          requestId += 1
          retryTimer = setTimeout(sendSync, 2000)
          return
        }
        finish({ ok: true, result: payload })
        return
      }
    })

    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'sharing-memory-sync', version: '1.0.0' },
      },
    })}\n`)
    sendSync()
  })
}
