# Codex automatic memory

The Codex `Stop` hook summarizes each finished text reply, saves the summary through the shared Local Memory MCP server, and syncs it to your private GitHub memory repository. A retry of the same turn updates its existing entry. If GitHub is unavailable, the summary stays on the device and can be pushed on a later turn. If the model summarizer is unavailable, the hook saves a short extract of the reply.

## Setup

Use local Codex on macOS or Linux with Python 3.9+, Git, and Node.js 22.5+ (24 LTS recommended). Follow the [shared Git setup](../../README.md#cross-device-sync-setup-windows--macos) to clone your **private memory repository** into `~/.gemini/memory/sync`, with a checked-out branch tracking `origin`. Configure Git authentication before enabling the hook.

From this plugin checkout, replace `OWNER/PRIVATE_MEMORY_REPO` with the owner and name of your private data repository, and run:

```bash
python3 harnesses/codex/local-memory-autosync.py --install --sync-repo OWNER/PRIVATE_MEMORY_REPO
```

The installer uses the MCP server in this checkout. To share an existing Antigravity installation, also pass `--server ~/.gemini/config/plugins/local-memory/server/memory-mcp.mjs`. The hook uses the same data directory and device ID as that server. Keep the checkout at its installed location or rerun the installer after moving it.

Restart local Codex, open `/hooks`, and review and trust the new `Stop` hook. Send a short test prompt and check the private repository's `devices/` directory for a memory tagged `codex` and `turn-summary`. The installed hook checks that both fetch and push use the repository specified at install time.
