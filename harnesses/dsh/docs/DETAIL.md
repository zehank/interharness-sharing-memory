# 总记忆库双向同步（sharing-memory-sync）

把本机 **dsh-mnemon**（持久层 `mnemon.db` + 热记忆 `USER.md` / `MEMORY.md`）和 Antigravity `local-memory` 统一总记忆库 **`zehank/sharing-memory`**（本机 `~/.gemini/memory/`）接成双向同步。

dsh-mnemon 原有的热记忆、持久层、`idleReview`、记忆工具全部保持不变；这个插件只做桥接。macOS 与 Windows 走同一份代码：默认自动查找用户 Node（`node:sqlite` 需要 ≥ 22.5），路径全部用 `os.homedir()` / `path.join` 拼，Git 调用与 `local-memory` 服务在两边一致。

## UID 映射（沿用原导入，绝不重算）

| dsh-mnemon 来源 | sharing-memory uid | 说明 |
| --- | --- | --- |
| `insights.id`（uuid） | `mnemon_<uuid>` | 双向直接映射 |
| 热记忆条目（`target` + `created_at`） | `mnemon_rt_<8 hex>` | 已有 18 条原样复用；新条目按 `target+created_at` 生成稳定 id |
| 文档 | `mnemon_doc_<uuid>` | 不参与本桥接 |
| 其他 AI 写入 | 原 uid 保留 | 按 uid 反向映射；丢失状态时按内容 + 确定性 id 恢复 |

写入 sharing 一侧的 `updated_at` 等于来源时间戳；第二次执行时两边时间戳与内容都相等，因此**幂等**。删除使用 `deleted_at` 软删除墓碑。

## 两个工具

- `sharing_memory_sync({direction?: "both"|"push"|"pull", dry_run?: boolean, mirror_pinned?: boolean})`
  先调用 local-memory 自己的 `memory_sync`（`git pull --rebase --autostash` → LWW 合并所有 `devices/*.json` → 重写 `MEMORY.md` → commit + push），再按 `updated_at` 双向合并。`dry_run` 不写任何文件、不跑 git。
- `sharing_memory_status()`
  只读：两边条数、UID 映射数、git 工作区/领先落后、上次同步结果。

## 触发

默认手动调用。插件配置可开自动同步：

```yaml
autoSync: idle      # off | startup | idle | both
autoSyncMinIntervalMs: 1800000
```

自动同步是 `detached` 子进程 + 30 分钟去抖，不阻塞会话启动，也不干预 dsh-mnemon 的 `idleReview`。

## 硬边界

- 不修改 `~/.gemini/config/plugins/local-memory/` 任何文件；Git 同步只通过它的 MCP `memory_sync` 完成。
- 不把 `memory.db` / `mnemon.db` 同步进 Git；仓库里仍然只有 `devices/*.json` + `MEMORY.md`。
- 热记忆写入使用 dsh-mnemon 的 `.memories.lock`，并校验同样的 4096 / 10240 字节上限与 `§` 分隔符规则；写不下时跳过并报告，不会破坏原热记忆。
- 状态/映射保存在 `~/.dsh/sharing-memory-sync/state.json`；删掉它也能按内容与确定性 id 恢复映射，但可能把“已删除条目”误判为新条目，建议保留。

## 验证

```bash
node .dsh/plugins/sharing-memory-sync/scripts/verify.mjs
```

会检查：连续执行两次是否零新增（幂等）、DSH 新建一条记忆能否出现在 `origin/main` 的 `devices/macbook-air-m5.json`、其他平台的新条目（如 #172）能否进入 `mnemon.db`；测试记忆用 `mnemon forget` + 墓碑清理。
