# Interharness Sharing Memory

Share a local-first memory store across AI harnesses. Each integration uses the same Local Memory MCP server and per-device snapshot format. Keep the plugin source in this repository and use a separate private repository or cloud folder for your memory data.

| Harness | Integration | Platforms |
| :--- | :--- | :--- |
| Google Antigravity | [Native Local Memory plugin](#antigravity-installation) | macOS, Windows |
| OpenAI Codex | [Stop hook for automatic reply summaries and GitHub sync](harnesses/codex/README.md) | macOS, Linux |

The Antigravity manifest and MCP entry point live at the repository root, so existing installs can keep pulling updates. Additional harness-specific entry points can live under `harnesses/` and reuse `server/memory-mcp.mjs`.

## Shared features

- **Zero external npm dependencies**: Powered by Node.js built-in `node:sqlite` (Node.js ≥ 22.5 / 24).
- **Local-First & Privacy-Preserving**: All memory data stays in `~/.gemini/memory/` (completely decoupled from this plugin directory).
- **Layered Memory**: Pinned hot runtime memories (`memory_brief`) + searchable long-term store + archived tier.
- **Knowledge Graph**: Directed edges (`relates_to`, `caused_by`, `supersedes`, `part_of`, `depends_on`) with automatic 1-hop expansion on `memory_search`.
- **Decay & Reinforcement**: Tracks `access_count` & `last_accessed_at` with 30-day half-life decay (pinned memories never decay) and stale-memory archival.
- **Deduplication & Evolution**: `memory_save` returns `similar_candidates` and supports `supersedes` to archive outdated decisions cleanly.
- **Human-Readable Mirror**: Automatically regenerates `~/.gemini/memory/MEMORY.md` on every write/sync.
- **Conflict-Free Multi-Device Sync (Win ↔ Mac)**: Local SQLite stays local; each machine writes only `sync/devices/<device-id>.json` and merges others via Last-Write-Wins (`uid` + `updated_at` + soft-delete tombstones). Works with **Private Git Repo** or **Cloud Folders** (OneDrive / iCloud / Dropbox / Syncthing).
- **Safe Auto-Update**: Automatically checks and fast-forward pulls updates from GitHub in the background (every 12 hours, non-blocking, skips if local modifications exist), plus an on-demand `memory_update` tool.

---

## Antigravity requirements

- **Node.js ≥ 22.5** (Node.js 24 LTS recommended)
- **Google Antigravity**

---

## Antigravity installation

### macOS / Linux
```bash
mkdir -p ~/.gemini/config/plugins
git clone https://github.com/zehank/interharness-sharing-memory.git ~/.gemini/config/plugins/local-memory
```

### Windows (PowerShell)
```powershell
New-Item -ItemType Directory -Force -Path "$HOME\.gemini\config\plugins" | Out-Null
git clone https://github.com/zehank/interharness-sharing-memory.git "$HOME\.gemini\config\plugins\local-memory"
```

Antigravity automatically discovers and loads the plugin on the next turn—no restart required.

---

## Cross-Device Sync Setup (Windows ↔ macOS)

### Option A: Private Git Repository (Recommended)
1. Create a **private** repository (e.g. `antigravity-memory`) on GitHub/Gitee.
2. On your first machine:
   ```bash
   mkdir -p ~/.gemini/memory/sync
   cd ~/.gemini/memory/sync
   git init -b main
   git remote add origin <your-private-memory-repo-url>
   ```
3. On your second machine:
   ```bash
   mkdir -p ~/.gemini/memory
   git clone <your-private-memory-repo-url> ~/.gemini/memory/sync
   ```
4. Ask the agent to **"sync memory"** (`memory_sync`) anytime—it runs `git pull`, merges all device snapshots with zero conflicts, updates `MEMORY.md`, and commits & pushes.

### Option B: Cloud Folder (OneDrive / iCloud / Dropbox / Syncthing)
Create `~/.gemini/memory/config.json` on each machine:
```json
{
  "syncDir": "/path/to/your/shared/cloud/memory-sync-folder"
}
```
Each machine only writes its own `devices/<device-id>.json`, avoiding cloud conflict copies and SQLite corruption.

---

## MCP Tools (`local-memory-mcp`)

| Tool | Description |
| :--- | :--- |
| `memory_brief` | Fast startup briefing returning all pinned hot memories and recent highlights |
| `memory_save` | Create or update a memory; supports `pinned`, `supersedes`, and similarity hints |
| `memory_search` | Hybrid Chinese/English search with decay × reinforcement scoring + 1-hop graph expansion |
| `memory_link` | Create or remove directed relations (`relates_to`, `caused_by`, `supersedes`, `part_of`, `depends_on`) |
| `memory_list` | List memories by category, project, pinned, or archived status |
| `memory_archive` | Archive/restore a memory or auto-archive stale low-importance memories |
| `memory_delete` | Soft-delete a memory (propagates across synced devices via tombstone) |
| `memory_sync` | Merge device snapshots and run Git pull/commit/push if `syncDir` is a Git repo |
| `memory_update` | Check for or apply plugin updates from GitHub (`git pull --ff-only`) |
| `memory_stats` | View counts, device ID, sync mode, update status, and file paths |

### Auto-Sync & Auto-Update Configuration (Optional)
By default:
- **Background Git Auto-Sync** pulls on startup, debounces writes (30s) to commit & push automatically in the background (non-blocking), and flushes pending writes on exit.
- **Safe Auto-Update** checks GitHub in the background every 12 hours and safely fast-forward updates itself when cloned via Git.

You can customize these in `~/.gemini/memory/config.json`:
```json
{
  "autoSync": true,
  "autoSyncDebounceMs": 30000,
  "autoUpdate": "apply",
  "autoUpdateIntervalHours": 12
}
```
Supported values for `autoUpdate`: `"apply"` (default, auto pull if clean), `"check"` (notify only), or `"off"`.

---

## License

MIT
