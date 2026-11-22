---
name: memory-management
description: Manage, search, link, curate, archive, import, and sync the user's persistent local memory store (SQLite + knowledge graph + MEMORY.md + Win/Mac sync) using local-memory-mcp tools.
---

# Memory Management Skill (v2.0)

Use this skill when the user wants to inspect, organize, link, deduplicate, archive, migrate/import, or sync their persistent local memory store across Windows and macOS.

## Storage & Sync Locations
- **Local SQLite index**: `~/.gemini/memory/memory.db` (machine-local cache, never sync directly)
- **Readable Markdown mirror**: `~/.gemini/memory/MEMORY.md` (auto-regenerated on every write/sync)
- **Sync directory**: `~/.gemini/memory/sync/` (or custom `syncDir` in `~/.gemini/memory/config.json` / `MEMORY_SYNC_DIR` env var)
  - `devices/<device-id>.json`: per-device snapshot merged via Last-Write-Wins (LWW) on `uid` + `updated_at` with soft-delete tombstones.

## Available MCP Tools (`local-memory-mcp`)
- `memory_brief`: Fast startup briefing (pinned hot memories + recent highlights).
- `memory_save`: Create/update memory; supports `pinned`, `supersedes`, and returns `similar_candidates`.
- `memory_search`: Hybrid Chinese/English search with importance × access reinforcement × 30-day decay scoring + 1-hop graph expansion.
- `memory_link`: Create or remove directed relations (`relates_to`, `caused_by`, `supersedes`, `part_of`, `depends_on`).
- `memory_list`: List memories by category, project, pinned, or archived status.
- `memory_archive`: Archive/restore a memory or auto-archive stale low-importance memories (`stale_days`).
- `memory_delete`: Soft-delete a memory (tombstone propagates across synced devices).
- `memory_sync`: Merge all device snapshots and run Git pull/commit/push if `syncDir` is a Git repo.
- `memory_stats`: Show counts, device ID, sync mode, and paths.

## Cross-Platform & Win/Mac Sync Setup
1. **Install on macOS**: Copy the `local-memory` plugin directory to `~/.gemini/config/plugins/local-memory/` (requires Node.js >= 22.5, e.g. Node 24). `mcp_config.json` uses a relative path (`./server/memory-mcp.mjs`), so zero path edits are needed.
2. **Sync Option A — Private Git Repo (Recommended)**:
   - Initialize `~/.gemini/memory/sync/` as a private Git repo (only `devices/` and `MEMORY.md` live there; `memory.db` stays outside).
   - Clone the same repo to `~/.gemini/memory/sync/` on Mac.
   - Call `memory_sync` (or say "同步记忆") anytime to pull, LWW-merge, and push with zero merge conflicts.
3. **Sync Option B — Cloud Folder (OneDrive / iCloud / Dropbox / Syncthing)**:
   - Create `~/.gemini/memory/config.json` on both machines with `{"syncDir": "<path-to-shared-cloud-folder>"}`.
   - Each machine only writes its own `devices/<device-id>.json` and reads all other devices' JSON files, avoiding cloud conflict copies and SQLite corruption.
