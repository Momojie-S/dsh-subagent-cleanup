/**
 * Subagent session cleanup (`subagent_cleanup` / `subagent_cleanup_global`):
 * two model-facing tools that archive (reversible move to sessions-archive)
 * or delete COLD subagent conversation records under `~/.dsh/sessions/`.
 *
 * Tool 1 `subagent_cleanup` — session self-cleanup: a long-running session
 * cleans its OWN descendant subagent records (via `ctx.subagents`
 * enumeration; authoritative activity state, no idle-hours gate).
 * Tool 2 `subagent_cleanup_global` — ops-side cross-workspace sweep:
 * directory-shape scan (bare-UUID dirs) under the strict process-start +
 * idle-hours guards, optionally scoped by workspace substring or parent id.
 *
 * Safety core (validated manually 2026-08-26 over 505 dirs / 627MB, zero
 * incidents): only subagent-shaped records, never main sessions
 * (`session-` prefix); re-check the artifact mtime immediately before each
 * move/delete; archive mode is reversible by moving the dir back.
 * @module @momojie-s/dsh-subagent-cleanup
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readdir, rename, rm, stat, mkdir, writeFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis' // side-effect: ctx types
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-subagent' // side-effect: ctx.subagents types
import type {} from '@deepseek-ai/dsh-system-prompt'

export const name = 'dsh-subagent-cleanup'
export const inject = ['tools', 'subagents', 'systemPrompt']

/** Prompt order: beside the subagent delegation sections (116.5/116.6). */
const SECTION_ORDER = 116.7

export interface Config {
  /** Model-facing tool name for session self-cleanup (default `subagent_cleanup`). */
  toolSelf?: string
  /** Model-facing tool name for the ops-side global sweep (default `subagent_cleanup_global`). */
  toolGlobal?: string
  /** DSH home (default: `DSH_HOME` env, else `~/.dsh`). */
  home?: string
  /** Archive root (default: `<home>/sessions-archive`). */
  archiveRoot?: string
  /** Default idle gate in hours for the global sweep (default 24). */
  defaultIdleHours?: number
  /** Buffer for `inactive` (persistence-only) children: skip if written more recently (ms, default 30s). */
  settleBufferMs?: number
  /** Buffer for `running` (in-memory) children: eligible once silent this long (ms, default 10min). */
  liveBufferMs?: number
}

export const Config: z<Config> = z.object({
  toolSelf: z.string().default('subagent_cleanup'),
  toolGlobal: z.string().default('subagent_cleanup_global'),
  home: z.string(),
  archiveRoot: z.string(),
  defaultIdleHours: z.number().min(0).default(24),
  settleBufferMs: z.number().min(0).default(30_000),
  liveBufferMs: z.number().min(0).default(600_000),
})

// ---------------------------------------------------------------------------
// Pure planning core (exported for unit tests)
// ---------------------------------------------------------------------------

/** Main sessions carry a `session-` prefix; continuable children are bare UUIDs. */
export function isSubagentDirName(name: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name)
}

/** Store activity of a child as reported by subagent enumeration; `unknown` = directory-shape scan. */
export type CandidateActivity = 'running' | 'inactive' | 'unknown'

/** One cleanup candidate: a session directory plus everything the planner needs. */
export interface CleanupCandidate {
  readonly id: string
  readonly workspaceDir: string
  /** Latest artifact mtime in ms; `undefined` when the directory has no files. */
  readonly lastWriteMs: number | undefined
  readonly sizeBytes: number
  readonly activity: CandidateActivity
  /** True when any ancestor in the same enumeration is live (`running`). */
  readonly ancestorLive: boolean
}

/** Eligibility policy snapshot. */
export interface CleanupPolicy {
  readonly nowMs: number
  /** Only set for the global sweep (`activity: 'unknown'` candidates). */
  readonly processStartMs: number | undefined
  /** Only set for the global sweep; 0 disables the idle gate. */
  readonly minIdleMs: number | undefined
  readonly settleBufferMs: number
  readonly liveBufferMs: number
}

export type SkipReason = 'empty-dir' | 'subtree-live' | 'possibly-live' | 'just-settled' | 'attached-unknown' | 'too-recent'

export interface PlanEntry {
  readonly id: string
  readonly eligible: boolean
  readonly skipReason: SkipReason | undefined
}

/**
 * Decide eligibility for every candidate, pure and total.
 *
 * - `running` + live ancestor → skip `subtree-live` (a live child may resume its own children)
 * - `running`, quiet >= liveBufferMs → eligible (in-memory record but long silent)
 * - `running`, recent → skip `possibly-live`
 * - `inactive`, quiet >= settleBufferMs → eligible (persistence-only: no in-memory writer)
 * - `inactive`, recent → skip `just-settled`
 * - `unknown` (directory shape): written after process start → skip `attached-unknown`;
 *   idle < minIdleMs → skip `too-recent`; else eligible
 */
export function planSessionActions(candidates: readonly CleanupCandidate[], policy: CleanupPolicy): PlanEntry[] {
  return candidates.map(candidate => {
    if (candidate.lastWriteMs === undefined) return { id: candidate.id, eligible: false, skipReason: 'empty-dir' as const }
    const idleMs = policy.nowMs - candidate.lastWriteMs
    if (candidate.activity === 'running') {
      if (candidate.ancestorLive) return { id: candidate.id, eligible: false, skipReason: 'subtree-live' as const }
      if (idleMs >= policy.liveBufferMs) return { id: candidate.id, eligible: true, skipReason: undefined }
      return { id: candidate.id, eligible: false, skipReason: 'possibly-live' as const }
    }
    if (candidate.activity === 'inactive') {
      if (idleMs >= policy.settleBufferMs) return { id: candidate.id, eligible: true, skipReason: undefined }
      return { id: candidate.id, eligible: false, skipReason: 'just-settled' as const }
    }
    // unknown activity: strict directory-shape policy
    const processStartMs = policy.processStartMs ?? 0
    if (candidate.lastWriteMs >= processStartMs) return { id: candidate.id, eligible: false, skipReason: 'attached-unknown' as const }
    if (policy.minIdleMs !== undefined && policy.minIdleMs > 0 && idleMs < policy.minIdleMs) {
      return { id: candidate.id, eligible: false, skipReason: 'too-recent' as const }
    }
    return { id: candidate.id, eligible: true, skipReason: undefined }
  })
}

// ---------------------------------------------------------------------------
// Local structural types (avoid depending on subagent type export paths)
// ---------------------------------------------------------------------------

type DescendantEntry =
  | { kind: 'child'; id: string; activity: 'running' | 'inactive'; parentId: string; depth: number }
  | { kind: 'diagnostic'; id: string; reason: string }

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

/** Latest mtime + total size over every file under dir (recursive). */
async function probeDir(dir: string): Promise<{ lastWriteMs: number | undefined; sizeBytes: number }> {
  let latest: number | undefined
  let total = 0
  const stack: string[] = [dir]
  while (stack.length > 0) {
    const current = stack.pop()!
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      try {
        const info = await stat(full)
        total += info.size
        if (latest === undefined || info.mtimeMs > latest) latest = info.mtimeMs
      } catch {
        // raced away: ignore
      }
    }
  }
  return { lastWriteMs: latest, sizeBytes: total }
}

/** Re-check the session artifact right before acting; returns false when it moved or got rewritten. */
async function stillQuiescent(dir: string, plannedLastWriteMs: number | undefined): Promise<boolean> {
  try {
    const info = await stat(dir)
    if (!info.isDirectory()) return false
    // The append-only artifact is the channel every write lands on: its mtime
    // moving past the planned value means someone wrote after planning.
    const artifact = join(dir, 'session.jsonl.zstd')
    if (existsSync(artifact)) {
      const art = await stat(artifact)
      if (plannedLastWriteMs !== undefined && art.mtimeMs > plannedLastWriteMs) return false
    }
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Shared execution engine
// ---------------------------------------------------------------------------

type CleanupMode = 'archive' | 'delete'

interface RunResult {
  ok: boolean
  error: string | undefined
  mode: CleanupMode
  dryRun: boolean
  scanned: number
  eligible: number
  processed: number
  skippedExisting: number
  failures: number
  freedBytes: number
  skippedByReason: Record<string, number>
  processedIds: string[]
  failureDetails: string[]
  manifestPath: string | null
}

function emptyRunResult(mode: CleanupMode, dryRun: boolean): RunResult {
  return {
    ok: true, error: undefined, mode, dryRun, scanned: 0, eligible: 0, processed: 0,
    skippedExisting: 0, failures: 0, freedBytes: 0, skippedByReason: {},
    processedIds: [], failureDetails: [], manifestPath: null,
  }
}

export function apply(ctx: Context, config: Config): void {
  const home = config.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const archiveRoot = config.archiveRoot ?? join(home, 'sessions-archive')
  const defaultIdleHours = config.defaultIdleHours ?? 24
  const settleBufferMs = config.settleBufferMs ?? 30_000
  const liveBufferMs = config.liveBufferMs ?? 600_000
  const toolSelf = config.toolSelf ?? 'subagent_cleanup'
  const toolGlobal = config.toolGlobal ?? 'subagent_cleanup_global'

  // Captured at plugin load; uptime walk makes it the true process start.
  const processStartMs = Date.now() - process.uptime() * 1000

  /** Enumerate one parent's whole descendant tree as child candidates. */
  async function descendantsAsCandidates(parentSessionId: SessionId, index: Map<string, { workspaceDir: string }>): Promise<{ candidates: CleanupCandidate[]; unknown: string[] }> {
    const raw = await ctx.subagents.listDescendants(parentSessionId)
    const entries = raw as unknown as DescendantEntry[]
    const children = entries.filter((e): e is Extract<DescendantEntry, { kind: 'child' }> => e.kind === 'child')
    const liveIds = new Set(children.filter(c => c.activity === 'running').map(c => c.id))
    const parentOf = new Map(children.map(c => [c.id, c.parentId] as const))
    const candidates: CleanupCandidate[] = []
    const unknown: string[] = []
    for (const child of children) {
      const located = index.get(child.id)
      if (located === undefined) {
        unknown.push(child.id)
        continue
      }
      let ancestorLive = false
      let cursor: string | undefined = parentOf.get(child.id)
      while (cursor !== undefined && !ancestorLive) {
        if (liveIds.has(cursor)) ancestorLive = true
        cursor = parentOf.get(cursor)
      }
      const probed = await probeDir(join(home, 'sessions', located.workspaceDir, child.id))
      candidates.push({
        id: child.id,
        workspaceDir: located.workspaceDir,
        lastWriteMs: probed.lastWriteMs,
        sizeBytes: probed.sizeBytes,
        activity: child.activity,
        ancestorLive,
      })
    }
    return { candidates, unknown }
  }

  /** Build id → workspace mapping over subagent-shaped session dirs (all workspaces). */
  async function buildSubagentIndex(filter: string | undefined): Promise<Map<string, { workspaceDir: string }>> {
    const index = new Map<string, { workspaceDir: string }>()
    let workspaceDirs: string[] = []
    try {
      workspaceDirs = (await readdir(join(home, 'sessions'), { withFileTypes: true }))
        .filter(e => e.isDirectory()).map(e => e.name)
    } catch {
      return index
    }
    const needle = filter === undefined || filter === '' ? undefined : filter.toLowerCase()
    for (const ws of workspaceDirs) {
      if (needle !== undefined && !ws.toLowerCase().includes(needle)) continue
      let ids: string[] = []
      try {
        ids = (await readdir(join(home, 'sessions', ws), { withFileTypes: true }))
          .filter(e => e.isDirectory() && isSubagentDirName(e.name)).map(e => e.name)
      } catch {
        continue
      }
      for (const id of ids) index.set(id, { workspaceDir: ws })
    }
    return index
  }

  /** Plan + act. Mutates the filesystem unless dryRun. */
  async function runSweep(
    candidates: readonly CleanupCandidate[],
    policy: CleanupPolicy,
    mode: CleanupMode,
    dryRun: boolean,
  ): Promise<RunResult> {
    const result = emptyRunResult(mode, dryRun)
    result.scanned = candidates.length
    const plan = planSessionActions(candidates, policy)
    const planById = new Map(plan.map(entry => [entry.id, entry] as const))
    for (const entry of plan) {
      if (!entry.eligible && entry.skipReason !== undefined) {
        result.skippedByReason[entry.skipReason] = (result.skippedByReason[entry.skipReason] ?? 0) + 1
      }
    }
    result.eligible = plan.filter(entry => entry.eligible).length
    if (dryRun) return result

    for (const candidate of candidates) {
      const verdict = planById.get(candidate.id)
      if (verdict === undefined || !verdict.eligible) continue
      const sourceDir = join(home, 'sessions', candidate.workspaceDir, candidate.id)
      if (!(await stillQuiescent(sourceDir, candidate.lastWriteMs))) {
        result.skippedByReason['rewritten'] = (result.skippedByReason['rewritten'] ?? 0) + 1
        continue
      }
      try {
        if (mode === 'archive') {
          const targetDir = join(archiveRoot, candidate.workspaceDir, candidate.id)
          if (existsSync(targetDir)) {
            result.skippedExisting += 1
            continue
          }
          await mkdir(join(archiveRoot, candidate.workspaceDir), { recursive: true })
          await rename(sourceDir, targetDir)
        } else {
          await rm(sourceDir, { recursive: true, force: true })
        }
        result.processed += 1
        result.freedBytes += candidate.sizeBytes
        result.processedIds.push(candidate.id)
      } catch (error) {
        result.failures += 1
        result.failureDetails.push(`${candidate.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (result.failures > 0) result.ok = false

    // Rollback manifest for archive mode (reverse = move the dir back).
    if (mode === 'archive' && result.processedIds.length > 0) {
      try {
        const manifestDir = join(archiveRoot, '_manifests')
        await mkdir(manifestDir, { recursive: true })
        const stamp = new Date(policy.nowMs).toISOString().replace(/[:.]/g, '-')
        const manifestPath = join(manifestDir, `cleanup-${stamp}.json`)
        const manifest = {
          createdAt: new Date(policy.nowMs).toISOString(),
          mode,
          entries: candidates
            .filter(c => result.processedIds.includes(c.id))
            .map(c => ({ id: c.id, workspaceDir: c.workspaceDir, sizeBytes: c.sizeBytes })),
          rollback: 'move each <id> dir back from sessions-archive/<workspaceDir>/ to sessions/<workspaceDir>/',
        }
        await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
        result.manifestPath = manifestPath
      } catch (error) {
        result.failureDetails.push(`manifest: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return result
  }

  /** Resolve `mode` / `dryRun` / `minIdleHours` args shared by both tools. */
  function readCommonArgs(args: Record<string, unknown>): { mode: CleanupMode; dryRun: boolean; minIdleHours: number | undefined } | { error: string } {
    const mode = args.mode
    if (mode !== undefined && mode !== 'archive' && mode !== 'delete') return { error: 'mode 仅支持 archive 或 delete' }
    const dryRun = args.dryRun === true
    const hours = args.minIdleHours
    if (hours !== undefined && (typeof hours !== 'number' || hours < 0)) return { error: 'minIdleHours 必须是 >= 0 的数字' }
    return { mode: (mode === 'delete' ? 'delete' : 'archive'), dryRun, minIdleHours: typeof hours === 'number' ? hours : undefined }
  }

  ctx.systemPrompt.section({
    name: 'tool:subagent-cleanup',
    order: SECTION_ORDER,
    text: context => (ctx.tools.get(toolSelf, context.scope) === undefined && ctx.tools.get(toolGlobal, context.scope) === undefined)
      ? ''
      : [
        `子agent会话清理的分界:清理"本会话自己攒下的"子agent对话(长期任务收尾、结算通知已收完、不再需要 send_message 续聊)用 ${toolSelf},它按官方枚举处置你名下的后代,无需闲置等待;跨 workspace 的例行大扫除/堆积处理用 ${toolGlobal},判据更严(进程启动后未写入 + 闲置 ${defaultIdleHours}h)。`,
        `- 两个工具默认都是 archive(移到 sessions-archive,可逆,manifest 记录回滚清单);彻底删除需显式 mode:"delete",先向用户确认。`,
        `- 不确定影响面时先 dryRun:true 看清单。`,
        `- 长期 goal 会话收尾阶段,主动向用户建议清理本次任务的子agent会话。`,
      ].join('\n'),
  })

  // ------------------------------------------------------------------ tool 1
  ctx.tools.register(defineTool({
    name: toolSelf,
    description:
      '会话自清:清理"本会话自己的子agent"对话记录(含子agent再派的更深层后代)。通过子agent服务的官方枚举确定归属与状态,只处置已停稳的后代(正在跑的、刚结算仍在写入的会跳过)。'
      + '何时用:长期自主任务收尾时清掉本次攒下的子agent对话;用户说"把这次的子agent记录清了/删了"。'
      + '何时不用:清别的会话/别的 workspace 的堆积用 ' + toolGlobal + '(判据更严);还想对某个子agent send_message 续聊就别清它。'
      + '默认 mode=archive(移到 sessions-archive,可逆);mode="delete" 彻底删除(不可恢复,先向用户确认);dryRun=true 只看清单不动手。可选 ids 点名(必须是本会话后代)。',
    parameters: {
      mode: { type: 'string', description: 'archive(默认,移到 sessions-archive 可逆)或 delete(彻底删除,不可恢复)' },
      dryRun: { type: 'boolean', description: '只报告将处置的清单,不实际执行;默认 false' },
      ids: {
        type: 'array',
        items: { type: 'string' },
        description: '可选:只处置这些子agent会话 id(必须是本会话的后代,来自 list_agents/结算通知);省略则处置全部符合条件的后代',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec): Promise<Record<string, JsonValue>> {
      const caller = exec.agent
      if (caller === undefined) return { ok: false, error: '本工具需要会话内调用(exec.agent 缺失);跨会话清理用 ' + toolGlobal }
      const common = readCommonArgs(args)
      if ('error' in common) return { ok: false, error: common.error }

      let descendants: { candidates: CleanupCandidate[]; unknown: string[] }
      const index = await buildSubagentIndex(undefined)
      try {
        descendants = await descendantsAsCandidates(caller.id, index)
      } catch (error) {
        return { ok: false, error: `子agent枚举失败: ${error instanceof Error ? error.message : String(error)}` }
      }

      const requestedIds = Array.isArray(args.ids) ? args.ids.filter((id): id is string => typeof id === 'string') : undefined
      let candidates = descendants.candidates
      if (requestedIds !== undefined && requestedIds.length > 0) {
        const mine = new Set(candidates.map(c => c.id))
        const foreign = requestedIds.filter(id => !mine.has(id))
        if (foreign.length > 0) return { ok: false, error: `以下 id 不是本会话的后代,拒绝处置: ${foreign.join(', ')}` }
        candidates = candidates.filter(c => requestedIds.includes(c.id))
      }

      const result = await runSweep(candidates, {
        nowMs: Date.now(),
        processStartMs: undefined,
        minIdleMs: 0,
        settleBufferMs,
        liveBufferMs,
      }, common.mode, common.dryRun)

      return {
        ...result,
        scope: 'self',
        caller: String(caller.id),
        descendantsFound: descendants.candidates.length,
        notOnDisk: descendants.unknown,
      } as unknown as Record<string, JsonValue>
    },
  }))

  // ------------------------------------------------------------------ tool 2
  ctx.tools.register(defineTool({
    name: toolGlobal,
    description:
      '跨 workspace 清理子agent会话堆积(运维侧):按目录形态扫描所有 workspace 的子agent会话(裸 UUID 目录,主会话绝不触碰),只处置"当前 DSH 进程启动后从未写入 && 闲置超阈值"的冷记录。'
      + '何时用:GUI 变卡、session.list 膨胀时的例行大扫除;用户说"清理所有/某 workspace 的旧子agent会话"。'
      + '何时不用:会话清自己的子agent用 ' + toolSelf + '(无闲置门槛,枚举权威)。'
      + '参数:workspace(子串过滤,如 "StarRail")/ parent(点名某父会话,按其枚举处置,判据同自清)/ 省略两者=全量扫描。'
      + '默认 mode=archive(可逆,落 manifest 回滚清单);mode="delete" 彻底删除(先向用户确认);dryRun=true 预览;minIdleHours 默认 ' + String(defaultIdleHours) + '。',
    parameters: {
      workspace: { type: 'string', description: 'workspace 目录名子串过滤(大小写不敏感),如 "StarRail";省略=所有 workspace' },
      parent: { type: 'string', description: '点名清理某父会话(session- 前缀 id)名下的全部子agent;提供时按官方枚举处置,判据同自清工具(无闲置小时门槛)' },
      mode: { type: 'string', description: 'archive(默认,移到 sessions-archive 可逆)或 delete(彻底删除,不可恢复)' },
      dryRun: { type: 'boolean', description: '只报告将处置的清单,不实际执行;默认 false' },
      minIdleHours: { type: 'number', description: `闲置门槛小时数,默认 ${defaultIdleHours};仅全量扫描模式生效(parent 点名时忽略)` },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => false,
    async execute(args): Promise<Record<string, JsonValue>> {
      const common = readCommonArgs(args)
      if ('error' in common) return { ok: false, error: common.error }
      const nowMs = Date.now()

      // parent mode: authoritative enumeration, same policy as the self tool.
      if (typeof args.parent === 'string' && args.parent !== '') {
        const parentId = args.parent
        if (!parentId.startsWith('session-')) {
          return { ok: false, error: 'parent 必须是主会话 id(session- 前缀),子agent id 不可作为 parent' }
        }
        const index = await buildSubagentIndex(undefined)
        try {
          const descendants = await descendantsAsCandidates(parentId as SessionId, index)
          const result = await runSweep(descendants.candidates, {
            nowMs, processStartMs: undefined, minIdleMs: 0, settleBufferMs, liveBufferMs,
          }, common.mode, common.dryRun)
          return {
            ...result,
            scope: 'parent',
            parent: parentId,
            descendantsFound: descendants.candidates.length,
            notOnDisk: descendants.unknown,
          } as unknown as Record<string, JsonValue>
        } catch (error) {
          return { ok: false, error: `父会话枚举失败(可能不是会话 id): ${error instanceof Error ? error.message : String(error)}` }
        }
      }

      // sweep mode: strict directory-shape policy.
      const filter = typeof args.workspace === 'string' && args.workspace !== '' ? args.workspace : undefined
      const index = await buildSubagentIndex(filter)
      const candidates: CleanupCandidate[] = []
      for (const [id, located] of index) {
        const probed = await probeDir(join(home, 'sessions', located.workspaceDir, id))
        candidates.push({
          id,
          workspaceDir: located.workspaceDir,
          lastWriteMs: probed.lastWriteMs,
          sizeBytes: probed.sizeBytes,
          activity: 'unknown',
          ancestorLive: false,
        })
      }
      const minIdleHours = common.minIdleHours ?? defaultIdleHours
      const result = await runSweep(candidates, {
        nowMs,
        processStartMs,
        minIdleMs: minIdleHours * 3_600_000,
        settleBufferMs,
        liveBufferMs,
      }, common.mode, common.dryRun)
      return {
        ...result,
        scope: 'sweep',
        workspaceFilter: filter ?? null,
        minIdleHours,
        processStartedAt: new Date(processStartMs).toISOString(),
      } as unknown as Record<string, JsonValue>
    },
  }))

  ctx.logger.info(
    `subagent-cleanup: active (tools ${toolSelf}/${toolGlobal}, home ${home}, idle gate ${defaultIdleHours}h)`,
  )
}
