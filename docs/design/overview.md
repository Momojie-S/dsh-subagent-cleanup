# 机制总览

## 目标 / 非目标

**目标**

1. 长期自主会话能在收尾时清理**自己的**子 agent 会话记录(含深层后代),无闲置等待
2. 提供运维侧跨 workspace 的冷记录大扫除(严格判据),应对 GUI 卡顿/列表膨胀
3. 默认可逆(归档 = 目录移动 + 官方归档集合登记),显式指定才彻底删除;每次执行返回完整清单
4. 归档语义与官方对齐(0.2.0 起):登记官方归档集合,Web UI 过滤/恢复/闸门全部按官方语义工作

**非目标**

- 不清理主会话(`session-` 前缀)——那是用户自己的对话,归档/移动由用户决策
- 不做定时自动清理——按需调用,避免"悄悄删了用户还想翻的记录"
- **不重写父会话日志**——头部子代理下拉的行来自父会话日志里的 `subagent/catalog` 事件,官方没有移除手段(官方归档同样保留行);本插件不去动父会话日志,悬空行由官方归档集合把它们标记为已归档(平台层残留,见"边界与限制")

## 工作原理

两个工具共享一个规划-执行引擎:

```
候选集(两路来源) → planSessionActions(纯函数判据) → 动作前复查
  → [archive] 官方归档集合登记 → archive(rename)/[delete] rm → projcache 记录清理 → 汇总 + manifest
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

移动/删除前重新 stat 会话目录与**全部代际日志工件**(`session*.jsonl*`:v3 名 `session.jsonl.zstd`,v4 名 `session.v4.jsonl.zstd`):目录消失或任一工件 mtime 晚于规划时的探测值 → 跳过(`rewritten`)。窗口从"扫描到动作"缩到"stat 到 rename"。只盯 v3 工件会漏掉 v4 原生会话的写入(v4 目录里没有 v3 名文件),0.2.0 起改为全工件探测。

### 归档与回滚

- 归档 = 两步:①`workspaceRegistry.archiveSession(id)` 登记**官方归档集合**(此时数据还在盘上,能通过官方的存在性检查;会话仍有活动则拒绝 → 跳过该候选,`workspace-active`);②`rename(sessions/<ws>/<id> → sessions-archive/<ws>/<id>)`,同卷原子移动
- 每次归档在 `sessions-archive/_manifests/cleanup-<时间戳>.json` 落清单(id、workspace、字节数)
- 回滚 = 把目录移回原位 + 官方集合里取消登记(GUI 归档视图有恢复按钮,或 `workspaceRegistry.unarchiveSession`)
- 删除模式不登记官方集合(删掉的 id 不该留在归档集合里)

### projcache 记录清理(0.2.0 起)

0.2.0 官方新增持久投影缓存 `storages/session_projcache`(逐会话 JSON 记录,服务列表/标题等冷读),**自身没有任何清理机制**——目录被搬走/删除后记录永久残留。本插件在每次处置成功后删除该会话的记录文件 `<home>/storages/session_projcache/sessions/<id>.json`(per-record 布局,单文件即单记录,缺失/损坏按缺席处理,删除是官方读语义内的安全操作)。进程内已加载的域内存残影到下次重启为止,但归档会话不再出现在任何列表,残影不会被读取。

### 历史回填(backfillArchiveSet)

`subagent_cleanup_global` 的 `backfillArchiveSet: true` 参数:遍历全部归档 manifest,把已归档 id 补登记进官方归档集合。登记要求会话"存在"(live 或 persistence 可见),而已搬走的 id 是 unknown——所以逐个**搬回 → 登记 → 搬回**,幂等(已在集合里的跳过)。每次搬回会让该行在列表里闪现数秒,建议空闲时跑。

## 边界与限制

- **one-shot 子 agent**:枚举路覆盖(listDescendants 含 one-shot);目录扫描路按形态覆盖,两者互补
- **跨进程盲区**:大扫除的 process-start 判据以插件所在进程为准。若 headless 短暂进程创建过子 agent 后退出,其记录对 web 进程的"进程启动后未写入"检查可能不构成排除——`minIdleHours` 闲置门槛兜底
- **send_message 后果**:被清理的 continuable 子 agent 无法再 `list_agents` 枚举到/冷恢复——这正是"清理"的语义;引导段提示模型确认不再续聊
- **DSH 重启后**:`activity: running` 的记录退化为磁盘形态,自清/点名模式的宽松判据自动收紧为枚举时的 inactive 处理(仍在,状态变了)
- **头部子代理下拉的悬空行(平台残留)**:下拉行由父会话日志的 `subagent/catalog` 事件驱动,事件只追加、无移除语义,官方归档同样保留行。本插件的归档登记让官方集合接管语义(工作区侧栏过滤、归档闸门、恢复按钮),但**父会话头部的下拉仍会列出已归档子 agent**,点击因数据已移走而打不开——这是 0.2.0-rc.2 的平台限制,插件侧无法根治,已靠官方集合把误用面(误继续/误恢复)封住

## 验证基准

- DSH `0.2.0-rc.2`,Windows,web profile(0.2.0 机制:官方集合登记 + projcache 清理 + v4 工件探测)
- 历史基准:0.1.1-rc.2 手工同等操作前置验证(2026-08-26,505 目录/627.5MB 零事故)
