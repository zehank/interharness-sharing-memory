# Local Memory Policy v2 (Semi-Automatic, Layered & Graph-Aware)

You have access to a cross-platform persistent local memory system via `local-memory-mcp` (`memory_brief`, `memory_save`, `memory_search`, `memory_link`, `memory_list`, `memory_archive`, `memory_delete`, `memory_sync`, `memory_update`, `memory_stats`). Memories are stored locally in SQLite (`~/.gemini/memory/memory.db`), mirrored to `~/.gemini/memory/MEMORY.md`, and synced across Windows/macOS via per-device JSON snapshots (`~/.gemini/memory/sync/devices/`).

## When to Recall Memories
- At the start of a new conversation involving ongoing projects, preferences, tools, or workflows, call `memory_brief` first for a lightweight snapshot of pinned hot memories and recent highlights.
- When you need specific historical context, past decisions, or troubleshooting history, call `memory_search` (which automatically expands 1-hop graph links and reinforces accessed memories).

## When to Save & Evolve Memories (Semi-Automatic + Session Summary)
Proactively call `memory_save` without waiting to be asked when the conversation reveals **durable, reusable** information, and at the wrap-up of any substantive conversation:
1. **Preferences (`preference`)**: style, language/tone, tool choices, workflow preferences, or explicit corrections (set `pinned: true` for core preferences that apply almost everywhere).
2. **Project Decisions (`project`)**: architecture choices, repo conventions, key paths, or long-term goals.
3. **Pitfalls & Fixes (`pitfall`)**: non-obvious bugs, environment quirks, or workarounds. Use `memory_link` (`caused_by` / `relates_to`) to connect a pitfall to its environment or project memory.
4. **Workflows (`workflow`)**: repeatable procedures or toolchains the user likes.
5. **Facts (`fact`)**: stable environment details (OS, installed tools, common directories).
6. **Substantive Conversation Summary**: when a session reaches a concrete outcome, decision, configuration change, or milestone, concisely summarize the key takeaway via `memory_save` (prefer updating an existing topic memory or passing `supersedes` rather than piling up fragmented chat logs; skip pure small talk or one-off throwaway steps).

### Background Git Auto-Sync
- When `~/.gemini/memory/sync/` is a Git repo, the MCP server automatically pulls on startup and debounced-pushes in the background after writes (plus flushes on exit). You can still call `memory_sync` anytime for immediate on-demand sync.

### Important Guardrails
- **Always inform the user briefly** whenever you automatically save, link, or update a memory (e.g., `已自动记录记忆 #3：《偏好使用简洁中文回复》`).
- **Avoid duplicates & preserve evolution**: inspect `similar_candidates` returned by `memory_save`. If a new conclusion replaces an older one, pass `supersedes: <old_id>` so the graph records the evolution and archives the outdated entry.
- **Avoid noise & secrets**: never save transient chatter, temporary logs, or sensitive credentials (API keys, passwords, tokens).
- **Honor explicit requests**: immediately execute memory tools when the user asks to remember, edit, link, forget, archive, audit, or sync memories.
