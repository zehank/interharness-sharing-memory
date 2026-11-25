# DSH sharing memory sync (`harnesses/dsh`)

DSH（dsh-mnemon）↔ Antigravity `local-memory` 统一总记忆库（[`zehank/sharing-memory`](https://github.com/zehank/sharing-memory)）双向同步插件。

- 保留 dsh-mnemon 原有热记忆 / 持久层 / `idleReview`，只加桥接层
- 严格沿用原 UID 映射：`mnemon_<uuid>`、`mnemon_rt_<8hex>`、`mnemon_doc_<uuid>`；不会重算或翻倍
- `updated_at` LWW 合并，`deleted_at` 软删除墓碑
- 不修改 `local-memory` 插件目录，不把任何数据库同步进 Git（仍只走 `devices/*.json` + `MEMORY.md`）
- macOS / Windows 通用（Node ≥ 22.5 自带的 `node:sqlite`）

## 安装

本插件现在放在 [Interharness Sharing Memory](https://github.com/zehank/interharness-sharing-memory) 的 `harnesses/dsh/` 下，和 Antigravity、Codex 的集成共用同一个 Local Memory 数据目录。

先确认目标机器已有：

1. **Node.js ≥ 22.5**（`node -v` 能输出版本；插件会自动找 Node，找不到再手动配 `nodePath`）
2. **dsh-mnemon**（`~/.mnemon/` 或 `%USERPROFILE%\.mnemon\`）
3. Antigravity 的 **local-memory** 插件（`~/.gemini/config/plugins/local-memory/`）
4. **sharing-memory** 已绑定并同步（`~/.gemini/memory/sync/`，`config.json` 里固定 `deviceId`）

推荐直接从 umbrella 仓库的子目录安装：

```bash
# macOS / Linux / Windows
dsh plugin --profile desktop add github:zehank/interharness-sharing-memory#path:harnesses/dsh
```

如果所用 pnpm 版本不支持 `#path:` 子目录安装，就 clone 整个仓库再本地安装：

```bash
git clone https://github.com/zehank/interharness-sharing-memory.git
dsh plugin --profile desktop add /绝对路径/interharness-sharing-memory/harnesses/dsh
```

装完重启 DeepSeek Harness（新插件 bundle 需要重新加载），在聊天里看到 `sharing_memory_sync` / `sharing_memory_status` 两个工具即成功。

## 两个工具

```text
sharing_memory_sync({ direction?: "both"|"push"|"pull", dry_run?: boolean, mirror_pinned?: boolean })
sharing_memory_status()
```

- `both`（默认）：先跑 local-memory 自己的 `memory_sync`（`git pull --rebase --autostash` → 合并所有 `devices/*.json` → 重写 `MEMORY.md` → commit + push），再双向合并
- `push` / `pull`：只推 / 只拉
- `dry_run`：只算差异，不写任何文件、不跑 git
- `mirror_pinned`：拉取时把其他 AI 的置顶 / 重要度 ≥4 条目额外镜像进 DSH 热记忆（默认关）

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖同一行（`id: sharing-memory-sync`）的 `config`：

| key | 默认 | 说明 |
| --- | --- | --- |
| `nodePath` | `auto` | 自动查找用户 Node；Windows 可写 `C:\Program Files\nodejs\node.exe` |
| `autoSync` | `off` | `off` / `startup` / `idle` / `both`；自动同步是 detached 子进程 + 30 分钟去抖 |
| `autoSyncMinIntervalMs` | `1800000` | 自动同步最小间隔 |
| `mirrorPinned` | `false` | 见上方 `mirror_pinned` |
| `sharingDir` | `~/.gemini/memory` | 统一总记忆库本地目录 |
| `mnemonHome` | `~/.mnemon` | dsh-mnemon 数据目录 |
| `localMemoryServerPath` | `~/.gemini/config/plugins/local-memory/server/memory-mcp.mjs` | 只调用，不修改 |
| `timeoutMs` | `300000` | 单次同步超时（含 git 网络） |

## 验证

```bash
# macOS
/Users/<you>/.local/bin/node .dsh/plugins/sharing-memory-sync/scripts/verify.mjs

# Windows
node .\path\to\dsh-sharing-memory-sync\scripts\verify.mjs
```

会验证：① 连续两次同步零新增、UID 不变；② DSH 新记忆推到 `origin/main`、删除变成墓碑；③ 其他平台条目（如 #172）已在 `mnemon.db` 且内容一致。测试记忆会带 `【DSH 同步验证 …】` 标记并被软删除。

## 工作方式

```text
DSH dsh-mnemon                     bridge                     Antigravity local-memory
~/.mnemon/data/default/mnemon.db  ──▶ uid 映射 / LWW ──▶  ~/.gemini/memory/memory.db
~/.mnemon/runtime/memories.json   ◀── 墓碑 / 热记忆 ──◀  ~/.gemini/memory/sync/devices/*.json
                                                            ↓ local-memory 自己的 memory_sync
                                                          GitHub zehank/sharing-memory
```

- 热记忆写入使用 dsh-mnemon 的 `.memories.lock`，校验同样的 4096 / 10240 字节上限与 `§` 规则
- 状态与 UID 映射保存在 `~/.dsh/sharing-memory-sync/state.json`，丢了也能按内容和确定性 id 恢复
- 详细协议见 [docs/DETAIL.md](docs/DETAIL.md)

## License

MIT
