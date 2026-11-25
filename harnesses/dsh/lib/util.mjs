/** Small dependency-free helpers shared by the bridge modules. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

export const HOME = os.homedir()

export function expandHome(value) {
  const p = String(value || '')
  if (p === '~') return HOME
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(HOME, p.slice(2))
  return p
}

/**
 * Pick a real `node` executable across macOS and Windows. The Host plugin runs on
 * Electron's Node, but node:sqlite needs the user's Node (>= 22.5), so this path is
 * resolved once and passed to every child process.
 */
export function resolveNodePath(configured = '') {
  const value = String(configured || '').trim()
  if (value && value !== 'auto' && fs.existsSync(value)) return value
  const candidates = [
    path.join(HOME, '.local', 'bin', process.platform === 'win32' ? 'node.exe' : 'node'),
  ]
  if (process.platform === 'win32') {
    candidates.push(
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs', 'node.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs', 'node.exe'),
    )
  } else {
    candidates.push('/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node')
  }
  for (const candidate of candidates.filter(Boolean)) {
    try { if (fs.existsSync(candidate)) return candidate } catch {}
  }
  return process.platform === 'win32' ? 'node.exe' : 'node'
}

/** PATH for children: include the usual per-user and per-machine tool directories. */
export function childPathEnv() {
  const extra = process.platform === 'win32'
    ? [
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs'),
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'cmd'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'cmd'),
      ]
    : [path.join(HOME, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
  return [...extra, process.env.PATH || ''].filter(Boolean).join(process.platform === 'win32' ? ';' : ':')
}

export function readJsonFile(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return fallback
  }
}

export function writeJsonFile(file, value, { mode = 0o600 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode })
  fs.renameSync(tmp, file)
}

export function nowIso() {
  return new Date().toISOString()
}

export function parseTime(value) {
  if (!value) return Number.NaN
  const t = Date.parse(String(value))
  return Number.isFinite(t) ? t : Number.NaN
}

/** True when a is strictly newer than b. Unparsable timestamps fall back to string order. */
export function isNewer(a, b) {
  const ta = parseTime(a)
  const tb = parseTime(b)
  if (Number.isFinite(ta) && Number.isFinite(tb)) return ta > tb
  return String(a || '') > String(b || '')
}

export function maxTime(a, b) {
  return isNewer(a, b) ? a : b
}

/** dsh-mnemon stores runtime content with whitespace collapsed; mirror that before comparing or writing. */
export function normalizeContent(value) {
  return String(value || '').trim().replace(/\s+/gu, ' ')
}

export function contentKey(value) {
  return normalizeContent(value).toLowerCase()
}

export function sha8(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 8)
}

/** Deterministic RFC-4122-shaped id so a foreign sharing uid always maps to the same mnemon insight. */
export function uuidFromSeed(seed) {
  const hex = crypto.createHash('sha256').update(String(seed)).digest('hex')
  const variant = '89ab'[parseInt(hex[16], 16) & 3]
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export function deriveTitle(content, max = 60) {
  const first = normalizeContent(content).split('\n')[0]
  let title = first.split(/[：:]/)[0].trim()
  if (title.length < 4) title = first
  title = title.replace(/[*`#>]+/g, '').trim()
  if (!title) title = '未命名记忆'
  return title.length > max ? `${title.slice(0, max)}…` : title
}

export function sameStringSet(a, b) {
  const left = [...new Set((a || []).map(String))].sort()
  const right = [...new Set((b || []).map(String))].sort()
  return left.length === right.length && left.every((v, i) => v === right[i])
}

export function utf8Bytes(value) {
  return Buffer.byteLength(String(value || ''), 'utf8')
}

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Exclusive lock file, matching the liveness rule dsh-mnemon uses for its runtime files. */
export function acquireFileLock(lockPath, { staleMs = 30000, timeoutMs = 30000, retryMs = 25 } = {}) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600)
      fs.closeSync(fd)
      return () => {
        try { fs.rmSync(lockPath, { force: true }) } catch {}
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > staleMs) fs.rmSync(lockPath, { force: true })
      } catch {}
      if (Date.now() >= deadline) throw new Error(`lock busy: ${lockPath}`)
      sleepSync(retryMs)
    }
  }
}

/** Directory lock for one whole bridge run; a stale owner is taken over after staleMs. */
export function acquireDirLock(dirPath, { staleMs = 10 * 60 * 1000, timeoutMs = 15000, retryMs = 50 } = {}) {
  fs.mkdirSync(path.dirname(dirPath), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      fs.mkdirSync(dirPath, { mode: 0o700 })
      fs.writeFileSync(
        path.join(dirPath, 'owner.json'),
        `${JSON.stringify({ pid: process.pid, startedAt: nowIso() })}\n`,
        { mode: 0o600 },
      )
      return () => {
        try { fs.rmSync(dirPath, { recursive: true, force: true }) } catch {}
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      try {
        if (Date.now() - fs.statSync(dirPath).mtimeMs > staleMs) fs.rmSync(dirPath, { recursive: true, force: true })
      } catch {}
      if (Date.now() >= deadline) throw new Error('another sharing-memory sync is running')
      sleepSync(retryMs)
    }
  }
}
