# @momojie-s/dsh-subagent-cleanup

DSH 插件:**子 agent 会话清理**——长期自主会话收尾时清掉自己攒下的子 agent 对话,或从运维侧跨 workspace 清理冷记录堆积。默认归档(可逆),可选彻底删除。

## 一句话作用

DSH 官方没有会话删除能力(API 只有归档隐藏,不减少 `session.list` 负担;官方 README 明言删除是"later product decision")。长期自主会话持续产生子 agent 会话记录,几十上百个堆积后拖慢 Web GUI(实测 664 条 ≈ 1s/880KB)。本插件提供两个模型可调用的工具补上这块:

- **`subagent_cleanup`(会话自清)**:清理"本会话自己的"子 agent 及更深层后代。通过子 agent 服务枚举(`listDescendants`)确定归属与状态,只处置已停稳的(正在跑的、刚结算仍在写的、活祖先名下的都跳过),无闲置小时门槛。
- **`subagent_cleanup_global`(运维大扫除)**:跨 workspace 按目录形态扫描(裸 UUID = 子 agent,`session-` 前缀主会话绝不触碰),只处置"当前 DSH 进程启动后从未写入 && 闲置超阈值(默认 24h)"的冷记录;支持 workspace 子串过滤和 `parent` 点名。

## 环境要求

- DSH `0.1.5-rc.1`(验证基准);host 半部插件,无浏览器组件,任意 profile 可用
- Windows / Linux / macOS(`fs.rename` 同卷移动;DSH home 与 sessions 同盘)

## 用法

装好后无需配置。对话里直接说:

- "把这次任务攒的子agent会话清掉"(长期会话收尾)→ 模型调 `subagent_cleanup`
- "清理 StarRail 的旧子agent会话" / "全局大扫除一下子agent记录" → `subagent_cleanup_global`
- 工具结果返回:处置清单、跳过分类计数、释放空间、归档 manifest 路径

参数要点(两个工具同构):`mode: archive(默认)/ delete(不可恢复)`,`dryRun: true` 只看清单;自清支持 `ids: [...]` 点名自己的后代;大扫除支持 `workspace` 子串 / `parent` 会话 id / `minIdleHours`。

## 安装

```powershell
dsh plugin --profile web add <本仓库路径>   # 开发机本地
# 或
dsh plugin --profile web add github:Momojie-S/dsh-subagent-cleanup
```

安装后**重启 DSH** 生效(bundle 层启动时快照)。

## 配置

patch `config` 字段(全部可选):

| 字段 | 默认 | 说明 |
|---|---|---|
| `toolSelf` | `subagent_cleanup` | 自清工具的模型可见名 |
| `toolGlobal` | `subagent_cleanup_global` | 大扫除工具的模型可见名 |
| `home` | `DSH_HOME` 环境变量,再退 `~/.dsh` | DSH home 覆盖 |
| `archiveRoot` | `<home>/sessions-archive` | 归档目标根 |
| `defaultIdleHours` | `24` | 大扫除闲置门槛(小时) |
| `settleBufferMs` | `30000` | 仅磁盘子级的写入缓冲(毫秒) |
| `liveBufferMs` | `600000` | 在内存子级需静默多久才可处置(毫秒) |

## 验证

插件加载成功后 DSH 日志出现一行:

```
subagent-cleanup: active (tools subagent_cleanup/subagent_cleanup_global, home C:\...\.dsh, idle gate 24h)
```

会话里让模型执行 `dryRun: true` 的大扫除,返回的 `skippedByReason` 有合理分布(正在跑的 `possibly-live`/`attached-unknown` 被跳过)即为判据生效。

机制总览、安全边界与决策记录见 [docs/design/overview.md](docs/design/overview.md)。
