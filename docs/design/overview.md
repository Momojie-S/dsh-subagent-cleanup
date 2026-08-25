# 机制总览

## 目标 / 非目标

**目标**

1. 长期自主会话能在收尾时清理**自己的**子 agent 会话记录(含深层后代),无闲置等待
2. 提供运维侧跨 workspace 的冷记录大扫除(严格判据),应对 GUI 卡顿/列表膨胀
3. 默认可逆(归档 = 目录移动),显式指定才彻底删除;每次执行返回完整清单

**非目标**

- 不清理主会话(`session-` 前缀)——那是用户自己的对话,归档/移动由用户决策
- 不改 workspace 注册表 / 官方 `archivedSessionIds` 集合——物理移走后 persistence 自然看不到,悬空条目被 UI 容忍(2026-08-26 505 目录实测 + `ui-workspace/tree.ts` 源码确认)
- 不做定时自动清理——按需调用,避免"悄悄删了用户还想翻的记录"

## 工作原理

两个工具共享一个规划-执行引擎:

```
候选集(两路来源) → planSessionActions(纯函数判据) → 动作前复查 → archive(rename)/ delete(rm) → 汇总 + manifest
```

### 候选集的两条来源

| 来源 | 用途 | 权威性 |
|---|---|---|
| `ctx.subagents.listDescendants(parentId)` | 自清 / parent 点名 | 官方枚举:归属(后代树)、`activity`(running=在内存 / inactive=仅磁盘)、one-shot 与 continuable 都覆盖 |
| 目录扫描(`sessions/<ws>/<bare-uuid>`) | 全量大扫除 | 形态判据:子 agent 会话 id 是裸 UUID(源码 `SessionId(randomUUID())`),主会话带 `session-` 前缀 |

### 判据分级(核心设计,详见 ADR-0001)

| 候选 | 判据 | 理由 |
|---|---|---|
| inactive(仅磁盘) | 写入静默 ≥ settleBufferMs(30s) | 无内存写入者,缓冲只防结算 flush 竞态 |
| running(在内存)+ 活祖先 | 一律跳过(subtree-live) | 活着的子 agent 可能冷恢复自己的后代 |
| running(在内存) | 静默 ≥ liveBufferMs(10min) | "在内存"≠在跑(结算后记录仍驻留);长期静默 = 实质冷 |
| unknown(目录形态) | 进程启动后未写入 && 闲置 ≥ minIdleHours(24h) | 动的是**别的会话**的记录,不知道哪些还挂内存,从严 |

### 动作前复查

移动/删除前重新 stat 会话目录与 `session.jsonl.zstd`:目录消失或 mtime 晚于规划时的探测值 → 跳过(`rewritten`)。窗口从"扫描到动作"缩到"stat 到 rename"。

### 归档与回滚

- 归档 = `rename(sessions/<ws>/<id> → sessions-archive/<ws>/<id>)`,同卷原子移动
- 每次归档在 `sessions-archive/_manifests/cleanup-<时间戳>.json` 落清单(id、workspace、字节数)
- 回滚 = 把目录移回原位,无其它状态要修(workspace 注册表、内存会话列表都不需要动)

## 边界与限制

- **one-shot 子 agent**:枚举路覆盖(listDescendants 含 one-shot);目录扫描路按形态覆盖,两者互补
- **跨进程盲区**:大扫除的 process-start 判据以插件所在进程为准。若 headless 短暂进程创建过子 agent 后退出,其记录对 web 进程的"进程启动后未写入"检查可能不构成排除——`minIdleHours` 闲置门槛兜底
- **send_message 后果**:被清理的 continuable 子 agent 无法再 `list_agents` 枚举到/冷恢复——这正是"清理"的语义;引导段提示模型确认不再续聊
- **DSH 重启后**:`activity: running` 的记录退化为磁盘形态,自清/点名模式的宽松判据自动收紧为枚举时的 inactive 处理(仍在,状态变了)

## 验证基准

- DSH `0.1.1-rc.2`,Windows,web profile
- 手工同等操作前置验证:2026-08-26 归档 505 目录/627.5MB 零事故,GUI/运行中会话/history 全部正常
