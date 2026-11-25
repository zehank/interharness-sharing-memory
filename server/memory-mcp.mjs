#!/usr/bin/env node
/**
 * Local Memory MCP Server v2.0 (Cross-platform: Windows & macOS, Zero external dependencies)
 * Requires Node.js >= 22.5 (uses built-in node:sqlite).
 *
 * Features (inspired by dsh-mnemon + multi-device sync):
 * 1. Layered memory: pinned hot memories (memory_brief) + long-term searchable store
 * 2. Multi-relation knowledge graph (caused_by, relates_to, supersedes, part_of, depends_on) + 1-hop recall
 * 3. Access reinforcement & time decay scoring + archival
 * 4. Similarity detection on save (dedup & evolution hints)
 * 5. Conflict-free Win/Mac sync via per-device JSON snapshots (works with Git OR iCloud/OneDrive/Dropbox/Syncthing)
 * 6. Automatic human-readable MEMORY.md mirror
 */

import crypto from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, "..");

const DATA_DIR =
  process.env.MEMORY_DATA_DIR || path.join(os.homedir(), ".gemini", "memory");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const UPDATE_STATE_PATH = path.join(DATA_DIR, "update_state.json");

function loadUserConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, "utf8").replace(/^\uFEFF/, "");
      return JSON.parse(raw);
    }
  } catch (err) {
    process.stderr.write(`[local-memory] Failed to read config.json: ${err.message}\n`);
  }
  return {};
}

const userConfig = loadUserConfig();
const SYNC_DIR =
  process.env.MEMORY_SYNC_DIR ||
  userConfig.syncDir ||
  path.join(DATA_DIR, "sync");
const DEVICES_DIR = path.join(SYNC_DIR, "devices");
const DB_PATH = path.join(DATA_DIR, "memory.db");
const MD_PATH = path.join(DATA_DIR, "MEMORY.md");
const SYNC_MD_PATH = path.join(SYNC_DIR, "MEMORY.md");

const DEVICE_ID = (
  process.env.MEMORY_DEVICE_ID ||
  userConfig.deviceId ||
  `${process.platform}-${os.hostname()}`
)
  .toLowerCase()
  .replace(/[^a-z0-9._-]+/g, "-");

const VALID_CATEGORIES = [
  "preference",
  "project",
  "pitfall",
  "workflow",
  "fact",
  "other",
];

const VALID_RELATIONS = [
  "relates_to",
  "caused_by",
  "supersedes",
  "part_of",
  "depends_on",
];

const CATEGORY_LABELS = {
  preference: "个人偏好 (preference)",
  project: "项目背景与决策 (project)",
  pitfall: "踩坑与排障经验 (pitfall)",
  workflow: "工作流与习惯 (workflow)",
  fact: "事实与环境信息 (fact)",
  other: "其他 (other)",
};

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(DEVICES_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT UNIQUE,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'other',
    tags TEXT NOT NULL DEFAULT '[]',
    project TEXT NOT NULL DEFAULT '',
    importance INTEGER NOT NULL DEFAULT 3,
    pinned INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    access_count INTEGER NOT NULL DEFAULT 0,
    last_accessed_at TEXT,
    source_device TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS memory_links (
    uid TEXT PRIMARY KEY,
    from_uid TEXT NOT NULL,
    to_uid TEXT NOT NULL,
    relation TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
`);

// Schema migration from v1.0 if existing DB lacks new columns
function migrateSchema() {
  const cols = new Set(
    db
      .prepare("PRAGMA table_info(memories)")
      .all()
      .map((c) => c.name)
  );
  const addCol = (name, def) => {
    if (!cols.has(name)) {
      db.exec(`ALTER TABLE memories ADD COLUMN ${name} ${def}`);
    }
  };
  addCol("uid", "TEXT");
  addCol("pinned", "INTEGER NOT NULL DEFAULT 0");
  addCol("archived", "INTEGER NOT NULL DEFAULT 0");
  addCol("access_count", "INTEGER NOT NULL DEFAULT 0");
  addCol("last_accessed_at", "TEXT");
  addCol("source_device", "TEXT NOT NULL DEFAULT ''");
  addCol("deleted_at", "TEXT");

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_uid ON memories(uid);
    CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
    CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project);
    CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_links_from ON memory_links(from_uid);
    CREATE INDEX IF NOT EXISTS idx_links_to ON memory_links(to_uid);
  `);

  // Backfill uid for v1 rows
  const missingUid = db
    .prepare("SELECT id FROM memories WHERE uid IS NULL OR uid = ''")
    .all();
  const upd = db.prepare("UPDATE memories SET uid = ?, source_device = ? WHERE id = ?");
  for (const r of missingUid) {
    upd.run(genUid(), DEVICE_ID, r.id);
  }
}

function nowIso() {
  return new Date().toISOString();
}

function genUid() {
  return `m_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = new Set();
  const result = [];
  for (const raw of tags) {
    if (typeof raw !== "string") continue;
    const t = raw.trim();
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      result.push(t);
    }
  }
  return result;
}

function parseRow(row) {
  if (!row) return null;
  let tags = [];
  try {
    tags = JSON.parse(row.tags || "[]");
  } catch {
    tags = [];
  }
  return {
    id: row.id,
    uid: row.uid,
    title: row.title,
    content: row.content,
    category: row.category,
    tags,
    project: row.project,
    importance: row.importance,
    pinned: Boolean(row.pinned),
    archived: Boolean(row.archived),
    access_count: row.access_count || 0,
    last_accessed_at: row.last_accessed_at || null,
    source_device: row.source_device || "",
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at || null,
  };
}

function resolveMemoryRef(ref) {
  if (ref === undefined || ref === null || ref === "") return null;
  if (typeof ref === "number" || /^\d+$/.test(String(ref).trim())) {
    const row = db
      .prepare("SELECT * FROM memories WHERE id = ?")
      .get(Number(ref));
    return parseRow(row);
  }
  const row = db
    .prepare("SELECT * FROM memories WHERE uid = ?")
    .get(String(ref).trim());
  return parseRow(row);
}

function getLinksForUids(uids) {
  if (!uids.length) return [];
  const placeholders = uids.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT * FROM memory_links
       WHERE deleted_at IS NULL
         AND (from_uid IN (${placeholders}) OR to_uid IN (${placeholders}))`
    )
    .all(...uids, ...uids);
}

function writeAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, content, "utf8");
  fs.renameSync(tmpPath, filePath);
}

function syncMarkdown() {
  const rows = db
    .prepare(
      `SELECT * FROM memories
       WHERE deleted_at IS NULL
       ORDER BY pinned DESC, archived ASC, importance DESC, updated_at DESC, id DESC`
    )
    .all()
    .map(parseRow);

  const active = rows.filter((r) => !r.archived);
  const pinned = active.filter((r) => r.pinned);
  const archived = rows.filter((r) => r.archived);
  const links = db
    .prepare("SELECT * FROM memory_links WHERE deleted_at IS NULL")
    .all();

  const uidToMem = new Map(rows.map((r) => [r.uid, r]));

  const lines = [
    "# Antigravity Local Memory",
    "",
    `> 设备：\`${DEVICE_ID}\` | 活跃记忆：**${active.length}**（置顶 ${pinned.length}）| 已归档：**${archived.length}** | 关联边：**${links.length}**`,
    `> 同步目录：\`${SYNC_DIR}\` | 最后更新：${nowIso()}`,
    "",
  ];

  const renderEntry = (item) => {
    const stars = "★".repeat(Math.max(1, Math.min(5, item.importance)));
    const pinBadge = item.pinned ? " 📌" : "";
    const tagStr =
      item.tags.length > 0
        ? ` | 标签: ${item.tags.map((t) => `\`${t}\``).join(" ")}`
        : "";
    const projStr = item.project ? ` | 项目: \`${item.project}\`` : "";
    lines.push(`### #${item.id} ${item.title}${pinBadge} (\`${item.uid}\`)`);
    lines.push(
      `- **重要度**: ${stars} (${item.importance}/5) | **访问**: ${item.access_count} 次${projStr}${tagStr}`
    );
    lines.push(`- **更新时间**: ${item.updated_at}`);

    const rels = links.filter(
      (l) => l.from_uid === item.uid || l.to_uid === item.uid
    );
    if (rels.length > 0) {
      const relStrs = rels.map((l) => {
        if (l.from_uid === item.uid) {
          const target = uidToMem.get(l.to_uid);
          return `\`${l.relation}\` → ${target ? `#${target.id} ${target.title}` : l.to_uid}`;
        } else {
          const src = uidToMem.get(l.from_uid);
          return `← \`${l.relation}\` ${src ? `#${src.id} ${src.title}` : l.from_uid}`;
        }
      });
      lines.push(`- **关联**: ${relStrs.join("；")}`);
    }
    lines.push("", item.content.trim(), "");
  };

  if (pinned.length > 0) {
    lines.push("## 📌 置顶热记忆 (Pinned Runtime Layer)", "");
    for (const item of pinned) renderEntry(item);
  }

  const nonPinnedActive = active.filter((r) => !r.pinned);
  if (nonPinnedActive.length === 0 && pinned.length === 0) {
    lines.push("_当前暂无活跃记忆条目。_", "");
  } else {
    for (const cat of VALID_CATEGORIES) {
      const items = nonPinnedActive.filter((r) => r.category === cat);
      if (items.length === 0) continue;
      lines.push(`## ${CATEGORY_LABELS[cat]}`, "");
      for (const item of items) renderEntry(item);
    }
  }

  if (archived.length > 0) {
    lines.push("## 🗄️ 已归档记忆 (Archived)", "");
    for (const item of archived) {
      lines.push(
        `- #${item.id} **${item.title}** (\`${item.uid}\`, ${item.category}, updated ${item.updated_at})`
      );
    }
    lines.push("");
  }

  const md = lines.join("\n");
  writeAtomic(MD_PATH, md);
  if (SYNC_DIR !== DATA_DIR) {
    try {
      writeAtomic(SYNC_MD_PATH, md);
    } catch {
      // ignore if sync dir temporarily unavailable
    }
  }
}

function exportDeviceSnapshot() {
  const memories = db.prepare("SELECT * FROM memories").all().map(parseRow);
  const links = db.prepare("SELECT * FROM memory_links").all();
  const snapshot = {
    schema_version: 2,
    device_id: DEVICE_ID,
    exported_at: nowIso(),
    memories,
    links,
  };
  const deviceFile = path.join(DEVICES_DIR, `${DEVICE_ID}.json`);
  writeAtomic(deviceFile, JSON.stringify(snapshot, null, 2));
  return deviceFile;
}

function mergeAllDeviceSnapshots() {
  if (!fs.existsSync(DEVICES_DIR)) {
    return { files_read: 0, memories_merged: 0, links_merged: 0 };
  }
  const files = fs
    .readdirSync(DEVICES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();

  let memoriesMerged = 0;
  let linksMerged = 0;

  const getLocalMem = db.prepare("SELECT * FROM memories WHERE uid = ?");
  const insertMem = db.prepare(
    `INSERT INTO memories
     (uid, title, content, category, tags, project, importance, pinned, archived,
      access_count, last_accessed_at, source_device, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const updateMem = db.prepare(
    `UPDATE memories
     SET title = ?, content = ?, category = ?, tags = ?, project = ?, importance = ?,
         pinned = ?, archived = ?, access_count = ?, last_accessed_at = ?,
         source_device = ?, updated_at = ?, deleted_at = ?
     WHERE uid = ?`
  );

  const getLocalLink = db.prepare("SELECT * FROM memory_links WHERE uid = ?");
  const upsertLink = db.prepare(
    `INSERT INTO memory_links (uid, from_uid, to_uid, relation, note, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(uid) DO UPDATE SET
       relation = excluded.relation,
       note = excluded.note,
       updated_at = excluded.updated_at,
       deleted_at = excluded.deleted_at`
  );

  for (const file of files) {
    let snap;
    try {
      const raw = fs.readFileSync(path.join(DEVICES_DIR, file), "utf8").replace(/^\uFEFF/, "");
      snap = JSON.parse(raw);
    } catch {
      continue;
    }

    for (const m of snap.memories || []) {
      if (!m?.uid || !m.title || !m.content) continue;
      const local = getLocalMem.get(m.uid);
      const tagsJson = JSON.stringify(normalizeTags(m.tags));
      if (!local) {
        insertMem.run(
          m.uid,
          m.title,
          m.content,
          VALID_CATEGORIES.includes(m.category) ? m.category : "other",
          tagsJson,
          m.project || "",
          Math.max(1, Math.min(5, Number(m.importance) || 3)),
          m.pinned ? 1 : 0,
          m.archived ? 1 : 0,
          Number(m.access_count) || 0,
          m.last_accessed_at || null,
          m.source_device || snap.device_id || "",
          m.created_at || nowIso(),
          m.updated_at || nowIso(),
          m.deleted_at || null
        );
        memoriesMerged++;
      } else {
        const remoteUpdated = String(m.updated_at || "");
        const localUpdated = String(local.updated_at || "");
        const mergedAccess = Math.max(
          Number(local.access_count) || 0,
          Number(m.access_count) || 0
        );
        const mergedLastAccess =
          [local.last_accessed_at, m.last_accessed_at].filter(Boolean).sort().pop() || null;

        if (remoteUpdated > localUpdated) {
          updateMem.run(
            m.title,
            m.content,
            VALID_CATEGORIES.includes(m.category) ? m.category : "other",
            tagsJson,
            m.project || "",
            Math.max(1, Math.min(5, Number(m.importance) || 3)),
            m.pinned ? 1 : 0,
            m.archived ? 1 : 0,
            mergedAccess,
            mergedLastAccess,
            m.source_device || snap.device_id || local.source_device,
            remoteUpdated,
            m.deleted_at || null,
            m.uid
          );
          memoriesMerged++;
        } else if (mergedAccess > (local.access_count || 0)) {
          db.prepare(
            "UPDATE memories SET access_count = ?, last_accessed_at = ? WHERE uid = ?"
          ).run(mergedAccess, mergedLastAccess, m.uid);
        }
      }
    }

    for (const l of snap.links || []) {
      if (!l?.uid || !l.from_uid || !l.to_uid || !l.relation) continue;
      const local = getLocalLink.get(l.uid);
      if (!local || String(l.updated_at || "") > String(local.updated_at || "")) {
        upsertLink.run(
          l.uid,
          l.from_uid,
          l.to_uid,
          l.relation,
          l.note || "",
          l.created_at || nowIso(),
          l.updated_at || nowIso(),
          l.deleted_at || null
        );
        linksMerged++;
      }
    }
  }

  return { files_read: files.length, memories_merged: memoriesMerged, links_merged: linksMerged };
}

function isGitRepo(dir) {
  return fs.existsSync(path.join(dir, ".git"));
}

function runGitSync() {
  if (!isGitRepo(SYNC_DIR)) {
    return { git_enabled: false, note: "Sync directory is not a Git repository (cloud/local folder sync mode)." };
  }
  const git = (args) =>
    execFileSync("git", args, {
      cwd: SYNC_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

  const log = {};
  try {
    log.pull = git(["pull", "--rebase", "--autostash"]);
  } catch (err) {
    log.pull_warning = err.stderr?.toString()?.trim() || err.message;
  }

  const mergeResult = mergeAllDeviceSnapshots();
  exportDeviceSnapshot();
  syncMarkdown();

  try {
    const addTargets = ["devices/", "MEMORY.md"];
    if (fs.existsSync(path.join(SYNC_DIR, "documents"))) {
      addTargets.push("documents/");
    }
    git(["add", ...addTargets]);
    const status = git(["status", "--porcelain"]);
    if (status) {
      git(["commit", "-m", `sync(${DEVICE_ID}): ${nowIso()}`]);
      try {
        log.push = git(["push"]);
      } catch (err) {
        log.push_warning = err.stderr?.toString()?.trim() || err.message;
      }
    } else {
      log.commit = "no local changes";
    }
  } catch (err) {
    log.git_error = err.stderr?.toString()?.trim() || err.message;
  }

  return { git_enabled: true, merge: mergeResult, git: log };
}

const AUTO_SYNC_ENABLED = !["false", "0", "off"].includes(
  String(
    process.env.MEMORY_AUTO_SYNC !== undefined
      ? process.env.MEMORY_AUTO_SYNC
      : userConfig.autoSync !== undefined
        ? userConfig.autoSync
        : "true"
  )
    .trim()
    .toLowerCase()
);
const AUTO_SYNC_DEBOUNCE_MS = Math.max(
  1000,
  Number(
    process.env.MEMORY_AUTO_SYNC_DEBOUNCE_MS ||
      userConfig.autoSyncDebounceMs ||
      30000
  ) || 30000
);

let gitSyncInFlight = false;
let autoSyncTimer = null;
let autoSyncPendingAfterFlight = false;
let lastAutoSyncState = null;

function runAsyncSyncGit(args, cb, timeout = 20000) {
  execFile(
    "git",
    args,
    { cwd: SYNC_DIR, timeout, windowsHide: true },
    (err, stdout, stderr) =>
      cb(err, (stdout || "").trim(), (stderr || "").trim())
  );
}

function runBackgroundGitSync({ pushChanges = true } = {}) {
  if (!AUTO_SYNC_ENABLED || !isGitRepo(SYNC_DIR)) return;
  if (gitSyncInFlight) {
    if (pushChanges) autoSyncPendingAfterFlight = true;
    return;
  }

  gitSyncInFlight = true;
  const finish = (state) => {
    gitSyncInFlight = false;
    lastAutoSyncState = { ...state, at: nowIso() };
    if (autoSyncPendingAfterFlight) {
      autoSyncPendingAfterFlight = false;
      scheduleBackgroundGitSync();
    }
  };

  runAsyncSyncGit(["pull", "--rebase", "--autostash"], (pullErr, pullOut, pullStderr) => {
    let mergeResult = null;
    try {
      mergeResult = mergeAllDeviceSnapshots();
      if (pushChanges) {
        exportDeviceSnapshot();
      }
      syncMarkdown();
    } catch (err) {
      finish({ status: "error", phase: "merge", message: err.message });
      return;
    }

    if (!pushChanges) {
      finish({
        status: pullErr ? "pull_warning" : "pulled",
        pull: pullOut || undefined,
        warning: pullErr ? pullStderr || pullErr.message : undefined,
        merge: mergeResult,
      });
      return;
    }

    const addTargets = ["devices/", "MEMORY.md"];
    if (fs.existsSync(path.join(SYNC_DIR, "documents"))) {
      addTargets.push("documents/");
    }

    runAsyncSyncGit(["add", ...addTargets], (addErr, _addOut, addStderr) => {
      if (addErr) {
        finish({ status: "error", phase: "add", message: addStderr || addErr.message });
        return;
      }
      runAsyncSyncGit(["status", "--porcelain"], (stErr, stOut, stStderr) => {
        if (stErr) {
          finish({ status: "error", phase: "status", message: stStderr || stErr.message });
          return;
        }
        if (!stOut) {
          finish({ status: "up_to_date", merge: mergeResult });
          return;
        }
        runAsyncSyncGit(
          ["commit", "-m", `sync(${DEVICE_ID}): ${nowIso()}`],
          (commitErr, _commitOut, commitStderr) => {
            if (commitErr) {
              finish({
                status: "error",
                phase: "commit",
                message: commitStderr || commitErr.message,
              });
              return;
            }
            runAsyncSyncGit(["push"], (pushErr, pushOut, pushStderr) => {
              finish({
                status: pushErr ? "push_warning" : "synced",
                push: pushOut || undefined,
                warning: pushErr ? pushStderr || pushErr.message : undefined,
                merge: mergeResult,
              });
            });
          }
        );
      });
    });
  });
}

function scheduleBackgroundGitSync() {
  if (!AUTO_SYNC_ENABLED || !isGitRepo(SYNC_DIR)) return;
  if (autoSyncTimer) {
    clearTimeout(autoSyncTimer);
  }
  autoSyncTimer = setTimeout(() => {
    autoSyncTimer = null;
    runBackgroundGitSync({ pushChanges: true });
  }, AUTO_SYNC_DEBOUNCE_MS);
  if (typeof autoSyncTimer.unref === "function") {
    autoSyncTimer.unref();
  }
}

function persistAndMirror() {
  exportDeviceSnapshot();
  syncMarkdown();
  scheduleBackgroundGitSync();
}

// Compute time decay multiplier (pinned memories do not decay; 30-day half-life with 0.35 floor)
function decayFactor(mem) {
  if (mem.pinned) return 1.25;
  const refTime = mem.last_accessed_at || mem.updated_at || mem.created_at;
  const ageDays = Math.max(
    0,
    (Date.now() - Date.parse(refTime || nowIso())) / (1000 * 60 * 60 * 24)
  );
  const decay = Math.pow(0.5, ageDays / 30);
  const reinforce = Math.min(0.45, Math.log1p(mem.access_count || 0) * 0.15);
  return Math.max(0.35, decay) + reinforce;
}

function textRelevance(mem, query) {
  if (!query) return 10;
  const q = query.trim().toLowerCase();
  if (!q) return 10;

  const title = mem.title.toLowerCase();
  const content = mem.content.toLowerCase();
  const tags = mem.tags.join(" ").toLowerCase();
  const project = mem.project.toLowerCase();
  const full = `${title}\n${tags}\n${project}\n${content}`;

  let score = 0;
  if (title.includes(q)) score += 30;
  if (tags.includes(q)) score += 20;
  if (project.includes(q)) score += 15;
  if (content.includes(q)) score += 15;

  const tokens = q
    .split(/[\s,，。、;；:/\\|]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const tok of tokens) {
    if (title.includes(tok)) score += 12;
    if (tags.includes(tok)) score += 10;
    if (content.includes(tok)) score += 6;
    if (project.includes(tok)) score += 6;

    if (/[\u4e00-\u9fff]/.test(tok) && tok.length >= 3) {
      let biHits = 0;
      for (let i = 0; i < tok.length - 1; i++) {
        if (full.includes(tok.slice(i, i + 2))) biHits++;
      }
      if (biHits > 0) score += Math.min(12, biHits * 3);
    }
  }
  return score;
}

function findSimilarMemories(title, content, excludeUid = null, limit = 3) {
  const rows = db
    .prepare("SELECT * FROM memories WHERE deleted_at IS NULL AND archived = 0")
    .all()
    .map(parseRow)
    .filter((r) => r.uid !== excludeUid);

  const queryText = `${title} ${content.slice(0, 120)}`;
  return rows
    .map((r) => ({ mem: r, score: textRelevance(r, title) + textRelevance(r, queryText) * 0.2 }))
    .filter((x) => x.score >= 22)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => ({
      id: x.mem.id,
      uid: x.mem.uid,
      title: x.mem.title,
      category: x.mem.category,
      similarity_score: Math.round(x.score),
    }));
}

const AUTO_UPDATE_MODE =
  process.env.MEMORY_AUTO_UPDATE || userConfig.autoUpdate || "apply"; // "apply" | "check" | "off"
const AUTO_UPDATE_INTERVAL_HOURS =
  Number(userConfig.autoUpdateIntervalHours) || 12;

function readPluginVersion() {
  try {
    const raw = fs
      .readFileSync(path.join(PLUGIN_ROOT, "plugin.json"), "utf8")
      .replace(/^\uFEFF/, "");
    return JSON.parse(raw).version || "2.1.0";
  } catch {
    return "2.1.0";
  }
}

function readUpdateState() {
  try {
    if (fs.existsSync(UPDATE_STATE_PATH)) {
      const raw = fs
        .readFileSync(UPDATE_STATE_PATH, "utf8")
        .replace(/^\uFEFF/, "");
      return JSON.parse(raw);
    }
  } catch {
    // ignore corrupt state
  }
  return null;
}

function saveUpdateState(state) {
  try {
    writeAtomic(UPDATE_STATE_PATH, JSON.stringify(state, null, 2));
  } catch {
    // ignore
  }
}

function runPluginUpdate({ checkOnly = false } = {}) {
  const versionBefore = readPluginVersion();
  const baseState = {
    last_checked_at: nowIso(),
    plugin_root: PLUGIN_ROOT,
    auto_update_mode: AUTO_UPDATE_MODE,
    current_version: versionBefore,
  };

  if (!isGitRepo(PLUGIN_ROOT)) {
    const res = {
      ...baseState,
      status: "not_git_repo",
      message:
        "Plugin directory is not a Git repository. Clone from GitHub to enable auto-update.",
    };
    saveUpdateState(res);
    return res;
  }

  const git = (args) =>
    execFileSync("git", args, {
      cwd: PLUGIN_ROOT,
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

  try {
    git(["fetch", "--quiet", "origin"]);
    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]) || "main";
    let upstream = `origin/${branch}`;
    try {
      upstream = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    } catch {
      // fallback to origin/<branch>
    }

    const localSha = git(["rev-parse", "--short", "HEAD"]);
    const remoteSha = git(["rev-parse", "--short", upstream]);
    const behindCount = Number(git(["rev-list", "--count", `HEAD..${upstream}`])) || 0;
    const changes =
      behindCount > 0
        ? git(["log", `HEAD..${upstream}`, "--oneline", "-n", "10"])
            .split(/\r?\n/)
            .filter(Boolean)
        : [];

    if (behindCount === 0) {
      const res = {
        ...baseState,
        status: "up_to_date",
        local_commit: localSha,
        remote_commit: remoteSha,
        behind_count: 0,
        message: "Plugin is already up to date.",
      };
      saveUpdateState(res);
      return res;
    }

    if (checkOnly) {
      const res = {
        ...baseState,
        status: "update_available",
        local_commit: localSha,
        remote_commit: remoteSha,
        behind_count: behindCount,
        pending_commits: changes,
        message: `${behindCount} new commit(s) available on ${upstream}. Call memory_update to apply.`,
      };
      saveUpdateState(res);
      return res;
    }

    const dirty = git(["status", "--porcelain"]);
    if (dirty) {
      const res = {
        ...baseState,
        status: "skipped_dirty",
        local_commit: localSha,
        remote_commit: remoteSha,
        behind_count: behindCount,
        pending_commits: changes,
        message:
          "Update available, but skipped because plugin directory has local uncommitted modifications.",
      };
      saveUpdateState(res);
      return res;
    }

    git(["pull", "--ff-only", "--quiet"]);
    const versionAfter = readPluginVersion();
    const newSha = git(["rev-parse", "--short", "HEAD"]);
    const res = {
      ...baseState,
      status: "updated",
      previous_version: versionBefore,
      current_version: versionAfter,
      previous_commit: localSha,
      local_commit: newSha,
      remote_commit: remoteSha,
      behind_count: 0,
      applied_commits: changes,
      restart_required: true,
      message: `Updated plugin ${versionBefore} (${localSha}) -> ${versionAfter} (${newSha}). New server code takes effect on next MCP reload/session.`,
    };
    saveUpdateState(res);
    return res;
  } catch (err) {
    const res = {
      ...baseState,
      status: "error",
      message: err.stderr?.toString()?.trim() || err.message,
    };
    saveUpdateState(res);
    return res;
  }
}

function scheduleBackgroundAutoUpdate() {
  if (AUTO_UPDATE_MODE === "off" || !isGitRepo(PLUGIN_ROOT)) return;
  const prev = readUpdateState();
  if (prev?.last_checked_at) {
    const elapsedHours =
      (Date.now() - Date.parse(prev.last_checked_at)) / (1000 * 60 * 60);
    if (elapsedHours < AUTO_UPDATE_INTERVAL_HOURS) return;
  }

  // Run non-blocking git fetch in background so MCP startup stays instant
  const runAsyncGit = (args, cb) =>
    execFile(
      "git",
      args,
      { cwd: PLUGIN_ROOT, timeout: 10000, windowsHide: true },
      (err, stdout, stderr) => cb(err, (stdout || "").trim(), (stderr || "").trim())
    );

  runAsyncGit(["fetch", "--quiet", "origin"], (fetchErr) => {
    if (fetchErr) return;
    runAsyncGit(["rev-list", "--count", "HEAD..@{u}"], (cntErr, cntOut) => {
      if (cntErr) return;
      const behind = Number(cntOut) || 0;
      if (behind === 0) {
        saveUpdateState({
          last_checked_at: nowIso(),
          plugin_root: PLUGIN_ROOT,
          auto_update_mode: AUTO_UPDATE_MODE,
          current_version: readPluginVersion(),
          behind_count: 0,
          status: "up_to_date",
        });
        return;
      }
      if (AUTO_UPDATE_MODE === "check") {
        saveUpdateState({
          last_checked_at: nowIso(),
          plugin_root: PLUGIN_ROOT,
          auto_update_mode: AUTO_UPDATE_MODE,
          current_version: readPluginVersion(),
          behind_count: behind,
          status: "update_available",
          message: `${behind} new commit(s) available. Call memory_update to apply.`,
        });
        return;
      }
      runAsyncGit(["status", "--porcelain"], (stErr, dirty) => {
        if (stErr || dirty) return;
        const versionBefore = readPluginVersion();
        runAsyncGit(["pull", "--ff-only", "--quiet"], (pullErr) => {
          if (pullErr) return;
          const versionAfter = readPluginVersion();
          saveUpdateState({
            last_checked_at: nowIso(),
            plugin_root: PLUGIN_ROOT,
            auto_update_mode: AUTO_UPDATE_MODE,
            previous_version: versionBefore,
            current_version: versionAfter,
            behind_count: 0,
            status: "updated",
            restart_required: true,
            message: `Auto-updated plugin ${versionBefore} -> ${versionAfter}. Takes effect on next MCP reload/session.`,
          });
        });
      });
    });
  });
}

// Startup: migrate, merge local snapshots, pull remote snapshots & check updates in background
migrateSchema();
mergeAllDeviceSnapshots();
syncMarkdown();
runBackgroundGitSync({ pushChanges: false });
scheduleBackgroundAutoUpdate();

const TOOLS = [
  {
    name: "memory_brief",
    description:
      "Fast startup briefing: returns all pinned (hot runtime) memories plus top recent high-importance memories and stats. Call this once at the start of a new conversation to orient yourself without flooding context.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Optional active project name/path to prioritize project memories.",
        },
        recent_limit: {
          type: "integer",
          minimum: 0,
          maximum: 20,
          description: "Number of non-pinned high-importance/recent memories to include (default 5).",
        },
      },
    },
  },
  {
    name: "memory_save",
    description:
      "Save a new persistent memory or update an existing one. Automatically checks for similar existing memories (dedup hint), supports pinning hot memories, supports `supersedes` to replace outdated conclusions, and syncs to devices/<device>.json + MEMORY.md.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: ["integer", "string"],
          description: "Optional existing memory numeric id or uid to update in place.",
        },
        title: { type: "string", description: "Short, descriptive title." },
        content: { type: "string", description: "Detailed memory content." },
        category: {
          type: "string",
          enum: VALID_CATEGORIES,
          description: "Category: preference, project, pitfall, workflow, fact, other.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Keywords/tags for retrieval.",
        },
        project: {
          type: "string",
          description: "Optional project name or path. Empty = global.",
        },
        importance: {
          type: "integer",
          minimum: 1,
          maximum: 5,
          description: "Importance 1 (low) to 5 (critical). Defaults to 3.",
        },
        pinned: {
          type: "boolean",
          description: "Pin to hot runtime layer (never decays, returned by memory_brief).",
        },
        supersedes: {
          type: ["integer", "string"],
          description:
            "Optional id or uid of an older memory that this new memory replaces. Creates a `supersedes` graph link and archives the older memory.",
        },
      },
      required: ["title", "content"],
    },
  },
  {
    name: "memory_search",
    description:
      "Search persistent memories using hybrid Chinese/English relevance × importance × access reinforcement × time decay. Automatically updates access stats and optionally expands 1-hop knowledge graph links.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search keywords or phrase." },
        category: { type: "string", enum: VALID_CATEGORIES },
        tag: { type: "string" },
        project: { type: "string" },
        include_archived: {
          type: "boolean",
          description: "Include archived memories (default false).",
        },
        include_related: {
          type: "boolean",
          description: "Expand 1-hop graph links from matched memories (default true).",
        },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
    },
  },
  {
    name: "memory_link",
    description:
      "Create or remove a directed knowledge-graph relationship between two memories (e.g. pitfall caused_by environment fact, new decision supersedes old decision).",
    inputSchema: {
      type: "object",
      properties: {
        from: {
          type: ["integer", "string"],
          description: "Source memory id or uid.",
        },
        to: {
          type: ["integer", "string"],
          description: "Target memory id or uid.",
        },
        relation: {
          type: "string",
          enum: VALID_RELATIONS,
          description: "Relation type: relates_to, caused_by, supersedes, part_of, depends_on.",
        },
        note: {
          type: "string",
          description: "Optional brief explanation of the link.",
        },
        remove: {
          type: "boolean",
          description: "Set true to remove this link instead of creating it.",
        },
      },
      required: ["from", "to", "relation"],
    },
  },
  {
    name: "memory_list",
    description:
      "List memories ordered by pinned, importance, and recency, with optional filters.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", enum: VALID_CATEGORIES },
        project: { type: "string" },
        pinned_only: { type: "boolean" },
        include_archived: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: "memory_archive",
    description:
      "Archive or unarchive a specific memory, OR auto-archive stale low-importance memories older than `stale_days`.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: ["integer", "string"],
          description: "Specific memory id or uid to archive/unarchive.",
        },
        archived: {
          type: "boolean",
          description: "True to archive (default), false to restore.",
        },
        stale_days: {
          type: "integer",
          minimum: 7,
          description:
            "If set (without id), auto-archives non-pinned memories with importance <= 2 not accessed in this many days.",
        },
      },
    },
  },
  {
    name: "memory_delete",
    description:
      "Soft-delete a memory by numeric id or uid (propagates across synced devices via tombstone) and update MEMORY.md.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: ["integer", "string"],
          description: "Memory id or uid to delete.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "memory_sync",
    description:
      "Synchronize memories across Windows and macOS devices: merges all device snapshots in sync/devices/ using Last-Write-Wins, regenerates MEMORY.md, and runs git pull/commit/push if the sync directory is a Git repo.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "memory_update",
    description:
      "Check for or apply plugin updates from GitHub (fast-forward git pull in the plugin directory). Safe: skips automatically if local uncommitted changes exist.",
    inputSchema: {
      type: "object",
      properties: {
        check_only: {
          type: "boolean",
          description: "If true, only check whether updates are available without pulling (default false).",
        },
      },
    },
  },
  {
    name: "memory_stats",
    description:
      "Return memory statistics (active, pinned, archived, links), current device_id, sync mode, update status, and file paths.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

function handleToolCall(name, args = {}) {
  switch (name) {
    case "memory_brief": {
      mergeAllDeviceSnapshots();
      const projectFilter = args.project
        ? String(args.project).trim().toLowerCase()
        : "";
      const recentLimit = Number.isInteger(args.recent_limit)
        ? Math.max(0, Math.min(20, args.recent_limit))
        : 5;

      const active = db
        .prepare(
          `SELECT * FROM memories
           WHERE deleted_at IS NULL AND archived = 0
           ORDER BY pinned DESC, importance DESC, updated_at DESC`
        )
        .all()
        .map(parseRow);

      const pinned = active.filter((m) => m.pinned);
      let others = active.filter((m) => !m.pinned);
      if (projectFilter) {
        const projMatches = others.filter((m) =>
          m.project.toLowerCase().includes(projectFilter)
        );
        const nonProj = others.filter(
          (m) => !m.project.toLowerCase().includes(projectFilter)
        );
        others = [...projMatches, ...nonProj];
      }
      const recent = others.slice(0, recentLimit);

      const updateState = readUpdateState();
      const briefPayload = {
        device_id: DEVICE_ID,
        total_active: active.length,
        pinned_count: pinned.length,
        pinned,
        recent_highlights: recent,
        markdown_path: MD_PATH,
      };
      if (
        updateState &&
        (updateState.status === "updated" || updateState.status === "update_available")
      ) {
        briefPayload.plugin_update = {
          status: updateState.status,
          message: updateState.message,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(briefPayload, null, 2),
          },
        ],
      };
    }

    case "memory_save": {
      const title = String(args.title || "").trim();
      const content = String(args.content || "").trim();
      if (!title || !content) {
        return {
          isError: true,
          content: [{ type: "text", text: "Error: title and content are required." }],
        };
      }
      const category = VALID_CATEGORIES.includes(args.category)
        ? args.category
        : "other";
      const tags = normalizeTags(args.tags);
      const project = String(args.project || "").trim();
      const importance = Math.max(
        1,
        Math.min(5, Number.isInteger(args.importance) ? args.importance : 3)
      );
      const pinned = args.pinned ? 1 : 0;
      const ts = nowIso();

      let action = "created";
      let savedUid;

      if (args.id !== undefined && args.id !== null && args.id !== "") {
        const existing = resolveMemoryRef(args.id);
        if (!existing || existing.deleted_at) {
          return {
            isError: true,
            content: [{ type: "text", text: `Error: memory ${args.id} not found.` }],
          };
        }
        const newPinned = args.pinned !== undefined ? pinned : existing.pinned ? 1 : 0;
        db.prepare(
          `UPDATE memories
           SET title = ?, content = ?, category = ?, tags = ?, project = ?,
               importance = ?, pinned = ?, source_device = ?, updated_at = ?
           WHERE uid = ?`
        ).run(
          title,
          content,
          category,
          JSON.stringify(tags),
          project,
          importance,
          newPinned,
          DEVICE_ID,
          ts,
          existing.uid
        );
        savedUid = existing.uid;
        action = "updated";
      } else {
        const dup = db
          .prepare(
            `SELECT * FROM memories
             WHERE deleted_at IS NULL AND lower(title) = lower(?) AND category = ? AND lower(project) = lower(?)`
          )
          .get(title, category, project);

        if (dup) {
          db.prepare(
            `UPDATE memories
             SET title = ?, content = ?, tags = ?, importance = ?, pinned = ?,
                 archived = 0, source_device = ?, updated_at = ?
             WHERE uid = ?`
          ).run(
            title,
            content,
            JSON.stringify(tags),
            importance,
            args.pinned !== undefined ? pinned : dup.pinned,
            DEVICE_ID,
            ts,
            dup.uid
          );
          savedUid = dup.uid;
          action = "updated_existing";
        } else {
          savedUid = genUid();
          db.prepare(
            `INSERT INTO memories
             (uid, title, content, category, tags, project, importance, pinned, archived,
              access_count, last_accessed_at, source_device, created_at, updated_at, deleted_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, ?, ?, ?, NULL)`
          ).run(
            savedUid,
            title,
            content,
            category,
            JSON.stringify(tags),
            project,
            importance,
            pinned,
            DEVICE_ID,
            ts,
            ts
          );
        }
      }

      // Handle `supersedes` relation & auto-archive old memory
      let superseded = null;
      if (args.supersedes !== undefined && args.supersedes !== null && args.supersedes !== "") {
        const oldMem = resolveMemoryRef(args.supersedes);
        if (oldMem && !oldMem.deleted_at && oldMem.uid !== savedUid) {
          const linkUid = `${savedUid}::supersedes::${oldMem.uid}`;
          db.prepare(
            `INSERT INTO memory_links (uid, from_uid, to_uid, relation, note, created_at, updated_at, deleted_at)
             VALUES (?, ?, ?, 'supersedes', 'auto-linked via memory_save', ?, ?, NULL)
             ON CONFLICT(uid) DO UPDATE SET updated_at = excluded.updated_at, deleted_at = NULL`
          ).run(linkUid, savedUid, oldMem.uid, ts, ts);
          db.prepare(
            "UPDATE memories SET archived = 1, pinned = 0, updated_at = ? WHERE uid = ?"
          ).run(ts, oldMem.uid);
          superseded = { id: oldMem.id, uid: oldMem.uid, title: oldMem.title };
        }
      }

      const similar = findSimilarMemories(title, content, savedUid, 3);
      persistAndMirror();
      const row = resolveMemoryRef(savedUid);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                action,
                memory: row,
                superseded,
                similar_candidates: similar,
                markdown_path: MD_PATH,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    case "memory_search": {
      const query = String(args.query || "").trim();
      const category = args.category ? String(args.category) : "";
      const tag = args.tag ? String(args.tag).trim().toLowerCase() : "";
      const project = args.project
        ? String(args.project).trim().toLowerCase()
        : "";
      const includeArchived = Boolean(args.include_archived);
      const includeRelated = args.include_related !== false;
      const limit = Math.max(1, Math.min(50, Number(args.limit) || 10));

      let rows = db
        .prepare("SELECT * FROM memories WHERE deleted_at IS NULL")
        .all()
        .map(parseRow);

      if (!includeArchived) rows = rows.filter((r) => !r.archived);
      if (category) rows = rows.filter((r) => r.category === category);
      if (tag) {
        rows = rows.filter((r) =>
          r.tags.some((t) => t.toLowerCase().includes(tag))
        );
      }
      if (project) {
        rows = rows.filter((r) => r.project.toLowerCase().includes(project));
      }

      const scored = rows
        .map((r) => {
          const rel = textRelevance(r, query);
          if (query && rel === 0) return { mem: r, score: 0 };
          const score = (rel + r.importance * 2) * decayFactor(r);
          return { mem: r, score };
        })
        .filter((x) => x.score > 0)
        .sort(
          (a, b) =>
            b.score - a.score ||
            b.mem.updated_at.localeCompare(a.mem.updated_at)
        )
        .slice(0, limit);

      // Reinforce accessed memories
      const ts = nowIso();
      const bump = db.prepare(
        "UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE uid = ?"
      );
      for (const item of scored) {
        bump.run(ts, item.mem.uid);
        item.mem.access_count += 1;
        item.mem.last_accessed_at = ts;
      }

      // 1-hop graph expansion
      let related = [];
      let links = [];
      if (includeRelated && scored.length > 0) {
        const hitUids = new Set(scored.map((x) => x.mem.uid));
        links = getLinksForUids([...hitUids]);
        const neighborUids = new Set();
        for (const l of links) {
          if (!hitUids.has(l.from_uid)) neighborUids.add(l.from_uid);
          if (!hitUids.has(l.to_uid)) neighborUids.add(l.to_uid);
        }
        for (const nUid of neighborUids) {
          const nm = resolveMemoryRef(nUid);
          if (nm && !nm.deleted_at && (includeArchived || !nm.archived)) {
            related.push(nm);
          }
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                count: scored.length,
                results: scored.map((x) => ({
                  ...x.mem,
                  relevance_score: Math.round(x.score * 10) / 10,
                })),
                related_memories: related,
                links,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    case "memory_link": {
      const fromMem = resolveMemoryRef(args.from);
      const toMem = resolveMemoryRef(args.to);
      const relation = String(args.relation || "");
      if (!fromMem || fromMem.deleted_at) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: source memory ${args.from} not found.` }],
        };
      }
      if (!toMem || toMem.deleted_at) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: target memory ${args.to} not found.` }],
        };
      }
      if (fromMem.uid === toMem.uid) {
        return {
          isError: true,
          content: [{ type: "text", text: "Error: cannot link a memory to itself." }],
        };
      }
      if (!VALID_RELATIONS.includes(relation)) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: invalid relation "${relation}".` }],
        };
      }

      const linkUid = `${fromMem.uid}::${relation}::${toMem.uid}`;
      const ts = nowIso();
      if (args.remove) {
        db.prepare(
          "UPDATE memory_links SET deleted_at = ?, updated_at = ? WHERE uid = ?"
        ).run(ts, ts, linkUid);
        persistAndMirror();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ action: "removed", link_uid: linkUid }, null, 2),
            },
          ],
        };
      }

      db.prepare(
        `INSERT INTO memory_links (uid, from_uid, to_uid, relation, note, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(uid) DO UPDATE SET
           note = excluded.note,
           updated_at = excluded.updated_at,
           deleted_at = NULL`
      ).run(linkUid, fromMem.uid, toMem.uid, relation, String(args.note || ""), ts, ts);

      if (relation === "supersedes") {
        db.prepare(
          "UPDATE memories SET archived = 1, pinned = 0, updated_at = ? WHERE uid = ?"
        ).run(ts, toMem.uid);
      }

      persistAndMirror();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                action: "linked",
                link: {
                  uid: linkUid,
                  from: { id: fromMem.id, uid: fromMem.uid, title: fromMem.title },
                  relation,
                  to: { id: toMem.id, uid: toMem.uid, title: toMem.title },
                  note: String(args.note || ""),
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }

    case "memory_list": {
      const category = args.category ? String(args.category) : "";
      const project = args.project
        ? String(args.project).trim().toLowerCase()
        : "";
      const pinnedOnly = Boolean(args.pinned_only);
      const includeArchived = Boolean(args.include_archived);
      const limit = Math.max(1, Math.min(100, Number(args.limit) || 20));

      let rows = db
        .prepare(
          `SELECT * FROM memories
           WHERE deleted_at IS NULL
           ORDER BY pinned DESC, archived ASC, importance DESC, updated_at DESC, id DESC`
        )
        .all()
        .map(parseRow);

      if (!includeArchived) rows = rows.filter((r) => !r.archived);
      if (pinnedOnly) rows = rows.filter((r) => r.pinned);
      if (category) rows = rows.filter((r) => r.category === category);
      if (project) {
        rows = rows.filter((r) => r.project.toLowerCase().includes(project));
      }

      const sliced = rows.slice(0, limit);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                total_matching: rows.length,
                returned: sliced.length,
                memories: sliced,
                markdown_path: MD_PATH,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    case "memory_archive": {
      const ts = nowIso();
      if (args.id !== undefined && args.id !== null && args.id !== "") {
        const mem = resolveMemoryRef(args.id);
        if (!mem || mem.deleted_at) {
          return {
            isError: true,
            content: [{ type: "text", text: `Error: memory ${args.id} not found.` }],
          };
        }
        const targetState = args.archived === false ? 0 : 1;
        db.prepare(
          "UPDATE memories SET archived = ?, pinned = CASE WHEN ? = 1 THEN 0 ELSE pinned END, updated_at = ? WHERE uid = ?"
        ).run(targetState, targetState, ts, mem.uid);
        persistAndMirror();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  action: targetState ? "archived" : "restored",
                  memory: resolveMemoryRef(mem.uid),
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const staleDays = Number(args.stale_days) || 60;
      const cutoff = new Date(Date.now() - staleDays * 86400 * 1000).toISOString();
      const candidates = db
        .prepare(
          `SELECT * FROM memories
           WHERE deleted_at IS NULL AND archived = 0 AND pinned = 0 AND importance <= 2
             AND COALESCE(last_accessed_at, updated_at) < ?`
        )
        .all(cutoff)
        .map(parseRow);

      const upd = db.prepare(
        "UPDATE memories SET archived = 1, updated_at = ? WHERE uid = ?"
      );
      for (const c of candidates) upd.run(ts, c.uid);
      if (candidates.length > 0) persistAndMirror();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                action: "auto_archived_stale",
                stale_days: staleDays,
                archived_count: candidates.length,
                archived_items: candidates.map((c) => ({
                  id: c.id,
                  uid: c.uid,
                  title: c.title,
                })),
              },
              null,
              2
            ),
          },
        ],
      };
    }

    case "memory_delete": {
      const existing = resolveMemoryRef(args.id);
      if (!existing || existing.deleted_at) {
        return {
          isError: true,
          content: [{ type: "text", text: `Memory ${args.id} not found.` }],
        };
      }
      const ts = nowIso();
      db.prepare(
        "UPDATE memories SET deleted_at = ?, updated_at = ? WHERE uid = ?"
      ).run(ts, ts, existing.uid);
      db.prepare(
        "UPDATE memory_links SET deleted_at = ?, updated_at = ? WHERE from_uid = ? OR to_uid = ?"
      ).run(ts, ts, existing.uid, existing.uid);
      persistAndMirror();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                deleted: existing,
                markdown_path: MD_PATH,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    case "memory_sync": {
      if (autoSyncTimer) {
        clearTimeout(autoSyncTimer);
        autoSyncTimer = null;
      }
      let result;
      if (isGitRepo(SYNC_DIR)) {
        if (gitSyncInFlight) {
          const merge = mergeAllDeviceSnapshots();
          exportDeviceSnapshot();
          syncMarkdown();
          autoSyncPendingAfterFlight = true;
          result = {
            git_enabled: true,
            in_flight: true,
            note: "Background Git sync is currently running; local snapshots merged and follow-up sync queued.",
            merge,
          };
        } else {
          result = runGitSync();
        }
      } else {
        const merge = mergeAllDeviceSnapshots();
        const snapshotFile = exportDeviceSnapshot();
        syncMarkdown();
        result = {
          git_enabled: false,
          mode: "folder_sync",
          sync_dir: SYNC_DIR,
          device_snapshot: snapshotFile,
          merge,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "memory_update": {
      const res = runPluginUpdate({ checkOnly: Boolean(args.check_only) });
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
      };
    }

    case "memory_stats": {
      const active = db
        .prepare("SELECT COUNT(*) as c FROM memories WHERE deleted_at IS NULL AND archived = 0")
        .get().c;
      const pinned = db
        .prepare("SELECT COUNT(*) as c FROM memories WHERE deleted_at IS NULL AND archived = 0 AND pinned = 1")
        .get().c;
      const archived = db
        .prepare("SELECT COUNT(*) as c FROM memories WHERE deleted_at IS NULL AND archived = 1")
        .get().c;
      const links = db
        .prepare("SELECT COUNT(*) as c FROM memory_links WHERE deleted_at IS NULL")
        .get().c;
      const byCategory = db
        .prepare(
          "SELECT category, COUNT(*) as count FROM memories WHERE deleted_at IS NULL AND archived = 0 GROUP BY category"
        )
        .all();
      const deviceFiles = fs.existsSync(DEVICES_DIR)
        ? fs.readdirSync(DEVICES_DIR).filter((f) => f.endsWith(".json"))
        : [];
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                version: readPluginVersion(),
                device_id: DEVICE_ID,
                active,
                pinned,
                archived,
                links,
                by_category: byCategory,
                sync_mode: isGitRepo(SYNC_DIR) ? "git" : "folder",
                sync_dir: SYNC_DIR,
                synced_devices: deviceFiles.map((f) => f.replace(/\.json$/, "")),
                auto_sync_enabled: AUTO_SYNC_ENABLED,
                auto_sync_debounce_ms: AUTO_SYNC_DEBOUNCE_MS,
                last_auto_sync: lastAutoSyncState,
                auto_update_mode: AUTO_UPDATE_MODE,
                update_state: readUpdateState(),
                db_path: DB_PATH,
                markdown_path: MD_PATH,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    default:
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
      };
  }
}

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let req;
  try {
    req = JSON.parse(trimmed);
  } catch (err) {
    process.stderr.write(`[local-memory] Invalid JSON: ${err.message}\n`);
    return;
  }

  const { id, method, params } = req;
  if (id === undefined || id === null) return;

  try {
    switch (method) {
      case "initialize":
        send({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: params?.protocolVersion || "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "local-memory", version: readPluginVersion() },
          },
        });
        break;
      case "ping":
        send({ jsonrpc: "2.0", id, result: {} });
        break;
      case "tools/list":
        send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
        break;
      case "tools/call": {
        const result = handleToolCall(params?.name, params?.arguments || {});
        send({ jsonrpc: "2.0", id, result });
        break;
      }
      default:
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        });
    }
  } catch (err) {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: err?.message || "Internal server error" },
    });
  }
});

rl.on("close", () => {
  if (autoSyncTimer) {
    clearTimeout(autoSyncTimer);
    autoSyncTimer = null;
    if (AUTO_SYNC_ENABLED && isGitRepo(SYNC_DIR) && !gitSyncInFlight) {
      try {
        runGitSync();
      } catch {
        // best-effort flush on exit
      }
    }
  }
});
