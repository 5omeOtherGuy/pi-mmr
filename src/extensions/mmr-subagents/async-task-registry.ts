import { randomBytes } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
  deriveAsyncTerminalOutcome,
  type MmrAsyncTerminalOutcome,
  type MmrWorkerProgressSnapshot,
  type MmrWorkerResult,
  type MmrWorkerTrailItem,
  type MmrWorkerUsageStats,
} from "./runner.js";

/**
 * In-memory, session-scoped registry for async background subagent tasks
 * (issue #23). The blocking `Task` tool runs a worker and returns its
 * result inline; the async companion tools (`start_task` / `task_poll` /
 * `task_wait` / `task_cancel`) instead register a background run here and
 * return an opaque `taskId` immediately.
 *
 * Design invariants (see the ratified plan):
 * - The registry owns the worker's `AbortController`. A background run is
 *   NEVER bound to the per-call tool `signal`, which fires the moment
 *   `start_task` returns.
 * - Records are partitioned by an opaque session key so concurrent Pi
 *   sessions in the same process never see each other's tasks.
 * - Liveness is DERIVED from heartbeat recency + watchdog, not trusted
 *   from a static "running" flag, so a dead/stalled worker cannot linger
 *   as a zombie "running" record.
 * - Terminal records are retained briefly (TTL) so they can be polled
 *   once, then pruned.
 * - State is process-local and in-memory only: it does not survive a Pi
 *   restart and is never written to disk. The durable, cross-process
 *   task-coordination store (issues #15/#16) is a separate layer; the
 *   field names here (`taskId`, `status`, `sessionKey`, actor-shaped
 *   origin) are aligned so a future bridge stays clean.
 */

export type MmrAsyncTaskStatus =
  | "running"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled";

export type MmrAsyncTaskTerminalFreshness = "healthy" | "stalled" | "dead";

export type MmrAsyncTaskFreshness =
  | "healthy"
  | "stalled"
  | "dead"
  | "terminal";

/** Default per-session cap on concurrently running background tasks. */
export const DEFAULT_ASYNC_TASK_MAX_RUNNING_PER_SESSION = 10;
/** A run with no progress for this long is classified `stalled` (advisory). */
export const ASYNC_TASK_STALLED_AFTER_MS = 5 * 60_000;
/** Hard wall-clock cap; the watchdog requests cancellation past this. */
export const ASYNC_TASK_MAX_RUNTIME_MS = 60 * 60_000;
/** Grace after a cancel/expiry request before a still-running task is `dead`. */
export const ASYNC_TASK_CANCEL_DEAD_AFTER_MS = 15_000;
/** Retain an unobserved terminal record this long before pruning. */
export const ASYNC_TASK_TERMINAL_TTL_MS = 15 * 60_000;
/** Retain a terminal record this long after it has been observed once. */
export const ASYNC_TASK_OBSERVED_TERMINAL_TTL_MS = 2 * 60_000;
/** Default `task_wait` timeout when the caller omits one. */
export const DEFAULT_TASK_WAIT_TIMEOUT_MS = 30_000;
/** Upper bound on `task_wait` timeout so the call stays intentional. */
export const MAX_TASK_WAIT_TIMEOUT_MS = 120_000;

export type MmrAsyncTaskCompletionPushState =
  | "disabled"
  | "pending"
  | "sending"
  | "sent"
  | "failed"
  /** Push was requested but suppressed because the per-session budget was exhausted. */
  | "suppressed"
  /**
   * Push was requested but skipped because the parent already observed (or was
   * actively blocked waiting on) the terminal result via task_wait/task_poll.
   * The agent already has the result in hand, so a push would only duplicate it.
   */
  | "observed";

/**
 * Hard ceiling on how many completion pushes a single session may fire,
 * regardless of how many tasks opt in. A safety rail against a plan that
 * launches many notifying tasks and repeatedly self-wakes the session.
 */
export const DEFAULT_ASYNC_TASK_MAX_PUSHES_PER_SESSION = 8;

/** Completed result from a background run that delegates to a Pi tool definition. */
export interface MmrAsyncTaskToolRunResult {
  toolResult: AgentToolResult<unknown>;
  status?: MmrAsyncTaskStatus;
  terminalOutcome?: MmrAsyncTerminalOutcome;
  errorMessage?: string;
}

export type MmrAsyncTaskRunResult = MmrWorkerResult | MmrAsyncTaskToolRunResult;

export type MmrAsyncTaskProgressResult = MmrWorkerProgressSnapshot | AgentToolResult<unknown>;

/** Run thunk: the registry supplies its own signal + progress sink. */
export type MmrAsyncTaskRun = (ctx: {
  signal: AbortSignal;
  onProgress: (snapshot: MmrAsyncTaskProgressResult) => void;
}) => Promise<MmrAsyncTaskRunResult>;

/** At-most-once completion notifier (e.g. a `pi.sendMessage` closure). */
export type MmrAsyncTaskNotifier = (
  snapshot: MmrAsyncTaskInternalSnapshot,
) => void | Promise<void>;

/** Best-effort lifecycle hook fired after a task reaches a terminal state. */
export type MmrAsyncTaskSettleCallback = (
  snapshot: MmrAsyncTaskInternalSnapshot,
) => void | Promise<void>;

export interface StartAsyncTaskArgs {
  sessionKey: string;
  /** Originating Pi tool-call id; used for at-most-once idempotency. */
  originToolCallId: string;
  /** User-facing worker kind launched by start_task (Task, finder, librarian). */
  agent?: string;
  description: string;
  prompt: string;
  cwd: string;
  resolvedModel?: string;
  contextWindow?: number;
  workerTools: readonly string[];
  capabilityProfile?: string;
  groupId?: string;
  run: MmrAsyncTaskRun;
  /**
   * Optional at-most-once completion notifier. When provided, the
   * registry fires it exactly once on terminal transition. Omitted →
   * pull-only (no push).
   */
  notify?: MmrAsyncTaskNotifier;
  /** Optional best-effort hook for UI state such as a background-task footer. */
  onSettle?: MmrAsyncTaskSettleCallback;
}

export type StartAsyncTaskResult =
  | { ok: true; deduplicated: boolean; snapshot: MmrAsyncTaskInternalSnapshot }
  | { ok: false; reason: "concurrency-cap"; runningCount: number; cap: number };

export interface WaitForAsyncTaskResult {
  found: boolean;
  timedOut: boolean;
  snapshot?: MmrAsyncTaskInternalSnapshot;
}

/**
 * Full, copy-on-read view of a task used internally by the in-package async
 * tools to rebuild the rich `Task` projection (it carries the prompt, cwd,
 * worker tools, latest progress, and the full worker result). It is NOT part
 * of the package's stable public surface; external consumers should use the
 * lean {@link MmrAsyncTaskSnapshot} via {@link toPublicAsyncTaskSnapshot}.
 */
export interface MmrAsyncTaskInternalSnapshot {
  taskId: string;
  status: MmrAsyncTaskStatus;
  freshness: MmrAsyncTaskFreshness;
  terminalFreshness?: MmrAsyncTaskTerminalFreshness;
  agent: string;
  description: string;
  prompt: string;
  cwd: string;
  resolvedModel?: string;
  contextWindow?: number;
  workerTools: readonly string[];
  createdAtMs: number;
  startedAtMs: number;
  updatedAtMs: number;
  lastProgressAtMs?: number;
  completedAtMs?: number;
  cancelRequestedAtMs?: number;
  cancelReason?: string;
  runtimeMs: number;
  lastProgressAgeMs?: number;
  completionPush: MmrAsyncTaskCompletionPushState;
  terminalOutcome?: MmrAsyncTerminalOutcome;
  capabilityProfile?: string;
  groupId?: string;
  latestProgress?: MmrWorkerProgressSnapshot;
  latestToolResult?: AgentToolResult<unknown>;
  finalResult?: MmrWorkerResult;
  finalToolResult?: AgentToolResult<unknown>;
  errorMessage?: string;
}

/**
 * Lean, public, copy-on-read view of a task suitable for external monitoring
 * and reporting. Deliberately omits the prompt text, cwd, resolved model,
 * worker tools, latest-progress payload, and the full worker result (which
 * can include stderr/args/trail). Identity/status/timing only, plus light
 * indicators (`promptChars`, `hasFinalResult`). Build it from an internal
 * snapshot with {@link toPublicAsyncTaskSnapshot}.
 */
export interface MmrAsyncTaskSnapshot {
  taskId: string;
  status: MmrAsyncTaskStatus;
  freshness: MmrAsyncTaskFreshness;
  terminalFreshness?: MmrAsyncTaskTerminalFreshness;
  agent: string;
  description: string;
  createdAtMs: number;
  startedAtMs: number;
  updatedAtMs: number;
  lastProgressAtMs?: number;
  completedAtMs?: number;
  cancelRequestedAtMs?: number;
  cancelReason?: string;
  runtimeMs: number;
  lastProgressAgeMs?: number;
  completionPush: MmrAsyncTaskCompletionPushState;
  terminalOutcome?: MmrAsyncTerminalOutcome;
  capabilityProfile?: string;
  groupId?: string;
  /** Length of the worker prompt in characters; the text itself is not exposed. */
  promptChars: number;
  /** Whether a terminal worker result is available (read it via task_poll). */
  hasFinalResult: boolean;
  errorMessage?: string;
}

/** Project an internal snapshot down to the lean public surface. */
export function toPublicAsyncTaskSnapshot(
  snapshot: MmrAsyncTaskInternalSnapshot,
): MmrAsyncTaskSnapshot {
  return {
    taskId: snapshot.taskId,
    status: snapshot.status,
    freshness: snapshot.freshness,
    ...(snapshot.terminalFreshness !== undefined
      ? { terminalFreshness: snapshot.terminalFreshness }
      : {}),
    agent: snapshot.agent,
    description: snapshot.description,
    createdAtMs: snapshot.createdAtMs,
    startedAtMs: snapshot.startedAtMs,
    updatedAtMs: snapshot.updatedAtMs,
    ...(snapshot.lastProgressAtMs !== undefined
      ? { lastProgressAtMs: snapshot.lastProgressAtMs }
      : {}),
    ...(snapshot.completedAtMs !== undefined ? { completedAtMs: snapshot.completedAtMs } : {}),
    ...(snapshot.cancelRequestedAtMs !== undefined
      ? { cancelRequestedAtMs: snapshot.cancelRequestedAtMs }
      : {}),
    ...(snapshot.cancelReason !== undefined ? { cancelReason: snapshot.cancelReason } : {}),
    runtimeMs: snapshot.runtimeMs,
    ...(snapshot.lastProgressAgeMs !== undefined
      ? { lastProgressAgeMs: snapshot.lastProgressAgeMs }
      : {}),
    completionPush: snapshot.completionPush,
    ...(snapshot.terminalOutcome !== undefined ? { terminalOutcome: snapshot.terminalOutcome } : {}),
    ...(snapshot.capabilityProfile !== undefined ? { capabilityProfile: snapshot.capabilityProfile } : {}),
    ...(snapshot.groupId !== undefined ? { groupId: snapshot.groupId } : {}),
    promptChars: snapshot.prompt.length,
    hasFinalResult: snapshot.finalResult !== undefined || snapshot.finalToolResult !== undefined,
    ...(snapshot.errorMessage !== undefined ? { errorMessage: snapshot.errorMessage } : {}),
  };
}

export interface MmrAsyncTaskBoardEntry {
  taskId: string;
  status: MmrAsyncTaskStatus;
  freshness: MmrAsyncTaskFreshness;
  terminalFreshness?: MmrAsyncTaskTerminalFreshness;
  agent: string;
  description: string;
  createdAtMs: number;
  startedAtMs: number;
  updatedAtMs: number;
  completedAtMs?: number;
  runtimeMs: number;
  lastProgressAgeMs?: number;
  resolvedModel?: string;
  contextWindow?: number;
  usage?: MmrWorkerUsageStats;
  latestToolName?: string;
  latestToolStatus?: Extract<MmrWorkerTrailItem, { type: "tool" }>["status"];
  toolCount?: number;
  terminalOutcome?: MmrAsyncTerminalOutcome;
  capabilityProfile?: string;
  groupId?: string;
  errorMessage?: string;
}

export interface MmrAsyncTaskBoard {
  version: 1;
  generatedAtMs: number;
  counts: { active: number; stalled: number; finished: number };
  active: MmrAsyncTaskBoardEntry[];
  stalled: MmrAsyncTaskBoardEntry[];
  finished: MmrAsyncTaskBoardEntry[];
}

export type MmrAsyncTaskGroupStatus = "running" | "failed" | "cancelled" | "partial" | "completed";

export interface MmrAsyncTaskGroupSnapshot {
  groupId: string;
  status: MmrAsyncTaskGroupStatus;
  generatedAtMs: number;
  createdAtMs: number;
  updatedAtMs: number;
  completedAtMs?: number;
  completionPush: MmrAsyncTaskCompletionPushState;
  taskIds: string[];
  counts: { running: number; succeeded: number; failed: number; cancelled: number; partial: number; total: number };
}

export interface WaitForAsyncTaskGroupResult {
  found: boolean;
  timedOut: boolean;
  snapshot?: MmrAsyncTaskGroupSnapshot;
}

export interface OpenAsyncTaskGroupArgs {
  sessionKey: string;
  groupId?: string;
  notify?: MmrAsyncTaskGroupNotifier;
  onSettle?: MmrAsyncTaskGroupSettleCallback;
}

export type MmrAsyncTaskGroupNotifier = (
  snapshot: MmrAsyncTaskGroupSnapshot,
) => void | Promise<void>;

export type MmrAsyncTaskGroupSettleCallback = (
  snapshot: MmrAsyncTaskGroupSnapshot,
) => void | Promise<void>;

export interface MmrAsyncTaskRegistry {
  startTask(args: StartAsyncTaskArgs): StartAsyncTaskResult;
  openGroup(args: OpenAsyncTaskGroupArgs): MmrAsyncTaskGroupSnapshot;
  getTask(sessionKey: string, taskId: string): MmrAsyncTaskInternalSnapshot | undefined;
  getGroup(sessionKey: string, groupId: string): MmrAsyncTaskGroupSnapshot | undefined;
  /**
   * Remove a group only if it currently holds no tasks. Returns true when a
   * group was dropped. Used to roll back a just-opened group when the
   * accompanying task start is rejected (e.g. concurrency cap), so a failed
   * start never leaves an empty orphan group.
   */
  dropEmptyGroup(sessionKey: string, groupId: string): boolean;
  listTasks(sessionKey: string): MmrAsyncTaskBoard;
  waitForTask(args: {
    sessionKey: string;
    taskId: string;
    timeoutMs?: number;
  }): Promise<WaitForAsyncTaskResult>;
  waitForGroup(args: {
    sessionKey: string;
    groupId: string;
    timeoutMs?: number;
  }): Promise<WaitForAsyncTaskGroupResult>;
  cancelTask(args: {
    sessionKey: string;
    taskId: string;
    reason?: string;
  }): Promise<MmrAsyncTaskInternalSnapshot | undefined>;
  cancelGroup(args: {
    sessionKey: string;
    groupId: string;
    reason?: string;
  }): Promise<MmrAsyncTaskGroupSnapshot | undefined>;
  prune(sessionKey?: string): void;
  shutdownSession(sessionKey?: string, reason?: string): void;
}

export interface MmrAsyncTaskRegistryDeps {
  /** Monotonic-ish wall clock in ms. Injectable for deterministic tests. */
  nowMs?: () => number;
  /** Opaque task-id factory. Injectable for deterministic tests. */
  idFactory?: () => string;
  /** Opaque group-id factory. Injectable for deterministic tests. */
  groupIdFactory?: () => string;
  /** Per-session concurrency cap. */
  maxRunningPerSession?: number;
  maxRuntimeMs?: number;
  stalledAfterMs?: number;
  cancelDeadAfterMs?: number;
  terminalTtlMs?: number;
  observedTerminalTtlMs?: number;
  /** Hard cap on completion pushes per session (default {@link DEFAULT_ASYNC_TASK_MAX_PUSHES_PER_SESSION}). */
  maxCompletionPushesPerSession?: number;
}

interface MmrAsyncTaskRecord {
  taskId: string;
  sessionKey: string;
  originToolCallId: string;
  agent: string;
  description: string;
  prompt: string;
  cwd: string;
  resolvedModel?: string;
  contextWindow?: number;
  workerTools: readonly string[];
  capabilityProfile?: string;
  groupId?: string;
  status: MmrAsyncTaskStatus;
  createdAtMs: number;
  startedAtMs: number;
  updatedAtMs: number;
  lastProgressAtMs?: number;
  completedAtMs?: number;
  cancelRequestedAtMs?: number;
  cancelReason?: string;
  maxRuntimeAtMs: number;
  finalObservedAtMs?: number;
  terminalFreshness?: MmrAsyncTaskTerminalFreshness;
  expiredByWatchdog: boolean;
  controller: AbortController;
  runGeneration: number;
  runnerSettled: boolean;
  watchdogTimer?: ReturnType<typeof setTimeout>;
  latestProgress?: MmrWorkerProgressSnapshot;
  latestToolResult?: AgentToolResult<unknown>;
  terminalOutcome?: MmrAsyncTerminalOutcome;
  finalResult?: MmrWorkerResult;
  finalToolResult?: AgentToolResult<unknown>;
  errorMessage?: string;
  notify?: MmrAsyncTaskNotifier;
  onSettle?: MmrAsyncTaskSettleCallback;
  completionPush: MmrAsyncTaskCompletionPushState;
  waiters: Set<() => void>;
  promise?: Promise<void>;
}

interface MmrAsyncTaskGroupRecord {
  groupId: string;
  sessionKey: string;
  createdAtMs: number;
  updatedAtMs: number;
  completedAtMs?: number;
  finalObservedAtMs?: number;
  notify?: MmrAsyncTaskGroupNotifier;
  onSettle?: MmrAsyncTaskGroupSettleCallback;
  completionPush: MmrAsyncTaskCompletionPushState;
  waiters: Set<() => void>;
  taskIds: Set<string>;
}

function isTerminalStatus(status: MmrAsyncTaskStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function defaultIdFactory(): string {
  return `task_${randomBytes(6).toString("hex")}`;
}

function defaultGroupIdFactory(): string {
  return `group_${randomBytes(6).toString("hex")}`;
}

export function isValidAsyncTaskGroupId(groupId: string): boolean {
  return /^group_[a-f0-9]{6,}$/.test(groupId);
}

function assertValidGroupId(groupId: string): void {
  if (!isValidAsyncTaskGroupId(groupId)) {
    throw new Error(`Invalid async task group id "${groupId}"; expected group_<hex>.`);
  }
}

function isAgentToolResult(value: unknown): value is AgentToolResult<unknown> {
  return typeof value === "object"
    && value !== null
    && Array.isArray((value as { content?: unknown }).content);
}

function isToolRunResult(value: MmrAsyncTaskRunResult): value is MmrAsyncTaskToolRunResult {
  return typeof value === "object"
    && value !== null
    && "toolResult" in value
    && isAgentToolResult((value as { toolResult?: unknown }).toolResult);
}

function latestToolFromProgress(
  progress: MmrWorkerProgressSnapshot | undefined,
): Extract<MmrWorkerTrailItem, { type: "tool" }> | undefined {
  if (!progress) return undefined;
  let latest: Extract<MmrWorkerTrailItem, { type: "tool" }> | undefined;
  let latestRunning: Extract<MmrWorkerTrailItem, { type: "tool" }> | undefined;
  for (const item of progress.trail) {
    if (item.type !== "tool") continue;
    latest = item;
    if (item.status === "running") latestRunning = item;
  }
  return latestRunning ?? latest;
}

class AsyncTaskRegistry implements MmrAsyncTaskRegistry {
  private readonly sessions = new Map<string, Map<string, MmrAsyncTaskRecord>>();
  private readonly groups = new Map<string, Map<string, MmrAsyncTaskGroupRecord>>();
  private readonly taskIdByToolCallId = new Map<string, string>();
  private readonly nowMs: () => number;
  private readonly idFactory: () => string;
  private readonly groupIdFactory: () => string;
  private readonly maxRunningPerSession: number;
  private readonly maxRuntimeMs: number;
  private readonly stalledAfterMs: number;
  private readonly cancelDeadAfterMs: number;
  private readonly terminalTtlMs: number;
  private readonly observedTerminalTtlMs: number;
  private readonly maxCompletionPushesPerSession: number;
  /** sessionKey -> completion pushes already fired this session. */
  private readonly completionPushesUsed = new Map<string, number>();

  constructor(deps: MmrAsyncTaskRegistryDeps = {}) {
    this.nowMs = deps.nowMs ?? (() => Date.now());
    this.idFactory = deps.idFactory ?? defaultIdFactory;
    this.groupIdFactory = deps.groupIdFactory ?? defaultGroupIdFactory;
    this.maxRunningPerSession = deps.maxRunningPerSession ?? DEFAULT_ASYNC_TASK_MAX_RUNNING_PER_SESSION;
    this.maxRuntimeMs = deps.maxRuntimeMs ?? ASYNC_TASK_MAX_RUNTIME_MS;
    this.stalledAfterMs = deps.stalledAfterMs ?? ASYNC_TASK_STALLED_AFTER_MS;
    this.cancelDeadAfterMs = deps.cancelDeadAfterMs ?? ASYNC_TASK_CANCEL_DEAD_AFTER_MS;
    this.terminalTtlMs = deps.terminalTtlMs ?? ASYNC_TASK_TERMINAL_TTL_MS;
    this.observedTerminalTtlMs = deps.observedTerminalTtlMs ?? ASYNC_TASK_OBSERVED_TERMINAL_TTL_MS;
    this.maxCompletionPushesPerSession =
      deps.maxCompletionPushesPerSession ?? DEFAULT_ASYNC_TASK_MAX_PUSHES_PER_SESSION;
  }

  private sessionMap(sessionKey: string): Map<string, MmrAsyncTaskRecord> {
    let map = this.sessions.get(sessionKey);
    if (!map) {
      map = new Map<string, MmrAsyncTaskRecord>();
      this.sessions.set(sessionKey, map);
    }
    return map;
  }

  private groupMap(sessionKey: string): Map<string, MmrAsyncTaskGroupRecord> {
    let map = this.groups.get(sessionKey);
    if (!map) {
      map = new Map<string, MmrAsyncTaskGroupRecord>();
      this.groups.set(sessionKey, map);
    }
    return map;
  }

  private ensureGroup(args: OpenAsyncTaskGroupArgs): MmrAsyncTaskGroupRecord {
    const groupId = args.groupId ?? this.groupIdFactory();
    assertValidGroupId(groupId);
    const map = this.groupMap(args.sessionKey);
    let group = map.get(groupId);
    if (!group) {
      const now = this.nowMs();
      group = {
        groupId,
        sessionKey: args.sessionKey,
        createdAtMs: now,
        updatedAtMs: now,
        ...(args.notify !== undefined ? { notify: args.notify } : {}),
        ...(args.onSettle !== undefined ? { onSettle: args.onSettle } : {}),
        completionPush: args.notify !== undefined ? "pending" : "disabled",
        waiters: new Set(),
        taskIds: new Set(),
      };
      map.set(groupId, group);
    } else {
      if (args.notify !== undefined && group.notify === undefined) {
        group.notify = args.notify;
        if (group.completionPush === "disabled") group.completionPush = "pending";
      }
      if (args.onSettle !== undefined) group.onSettle = args.onSettle;
    }
    return group;
  }

  openGroup(args: OpenAsyncTaskGroupArgs): MmrAsyncTaskGroupSnapshot {
    this.prune(args.sessionKey);
    return this.groupSnapshot(this.ensureGroup(args));
  }

  private toolCallIndexKey(sessionKey: string, toolCallId: string): string {
    return `${sessionKey}\u0000${toolCallId}`;
  }

  startTask(args: StartAsyncTaskArgs): StartAsyncTaskResult {
    this.prune(args.sessionKey);
    const map = this.sessionMap(args.sessionKey);

    // Idempotency: a retried tool call with the same id returns the same
    // task rather than spawning a duplicate worker.
    const indexKey = this.toolCallIndexKey(args.sessionKey, args.originToolCallId);
    const existingId = this.taskIdByToolCallId.get(indexKey);
    if (existingId) {
      const existing = map.get(existingId);
      if (existing) {
        return { ok: true, deduplicated: true, snapshot: this.snapshot(existing) };
      }
      this.taskIdByToolCallId.delete(indexKey);
    }

    const runningCount = [...map.values()].filter((r) => !isTerminalStatus(r.status)).length;
    if (runningCount >= this.maxRunningPerSession) {
      return { ok: false, reason: "concurrency-cap", runningCount, cap: this.maxRunningPerSession };
    }

    const group = args.groupId !== undefined
      ? this.ensureGroup({ sessionKey: args.sessionKey, groupId: args.groupId })
      : undefined;
    const now = this.nowMs();
    const controller = new AbortController();
    const record: MmrAsyncTaskRecord = {
      taskId: this.idFactory(),
      sessionKey: args.sessionKey,
      originToolCallId: args.originToolCallId,
      agent: args.agent ?? "Task",
      description: args.description,
      prompt: args.prompt,
      cwd: args.cwd,
      ...(args.resolvedModel !== undefined ? { resolvedModel: args.resolvedModel } : {}),
      ...(args.contextWindow !== undefined ? { contextWindow: args.contextWindow } : {}),
      workerTools: args.workerTools,
      ...(args.capabilityProfile !== undefined ? { capabilityProfile: args.capabilityProfile } : {}),
      ...(args.groupId !== undefined ? { groupId: args.groupId } : {}),
      status: "running",
      createdAtMs: now,
      startedAtMs: now,
      updatedAtMs: now,
      maxRuntimeAtMs: now + this.maxRuntimeMs,
      expiredByWatchdog: false,
      controller,
      runGeneration: 0,
      runnerSettled: false,
      ...(args.groupId === undefined && args.notify !== undefined ? { notify: args.notify } : {}),
      ...(args.onSettle !== undefined ? { onSettle: args.onSettle } : {}),
      completionPush: args.groupId === undefined && args.notify !== undefined ? "pending" : "disabled",
      waiters: new Set(),
    };
    map.set(record.taskId, record);
    if (group) {
      group.taskIds.add(record.taskId);
      group.updatedAtMs = now;
    }
    this.taskIdByToolCallId.set(indexKey, record.taskId);

    const generation = record.runGeneration;
    record.promise = (async () => {
      let result: MmrAsyncTaskRunResult;
      try {
        result = await args.run({
          signal: controller.signal,
          onProgress: (snapshot) => this.handleProgress(record, generation, snapshot),
        });
      } catch (err) {
        this.finalizeError(record, generation, err);
        return;
      }
      this.finalizeResult(record, generation, result);
    })();

    // Active max-runtime watchdog: a runaway task is aborted even if the
    // parent never polls/lists/waits again. The prune-time check below is a
    // backstop. Unref so a pending timer never keeps the process alive.
    if (Number.isFinite(this.maxRuntimeMs) && this.maxRuntimeMs > 0) {
      const timer = setTimeout(() => this.expireByWatchdog(record, generation), this.maxRuntimeMs);
      if (typeof timer.unref === "function") timer.unref();
      record.watchdogTimer = timer;
    }

    return { ok: true, deduplicated: false, snapshot: this.snapshot(record) };
  }

  private handleProgress(
    record: MmrAsyncTaskRecord,
    generation: number,
    snapshot: MmrAsyncTaskProgressResult,
  ): void {
    // Late-write guard: ignore progress after terminal or from a stale run.
    if (generation !== record.runGeneration) return;
    if (isTerminalStatus(record.status)) return;
    const now = this.nowMs();
    if (isAgentToolResult(snapshot)) record.latestToolResult = snapshot;
    else record.latestProgress = snapshot;
    record.lastProgressAtMs = now;
    record.updatedAtMs = now;
  }

  private finalizeResult(
    record: MmrAsyncTaskRecord,
    generation: number,
    result: MmrAsyncTaskRunResult,
  ): void {
    if (generation !== record.runGeneration) return;
    if (isTerminalStatus(record.status)) return;
    if (isToolRunResult(result)) {
      this.finalizeToolResult(record, result);
      return;
    }
    const now = this.nowMs();
    record.finalResult = result;
    record.runnerSettled = true;
    record.completedAtMs = now;
    record.updatedAtMs = now;
    record.terminalOutcome = deriveAsyncTerminalOutcome(result, { partialOutputPolicy: "prefer-usable-output" });

    if (record.cancelRequestedAtMs !== undefined) {
      if (record.expiredByWatchdog) {
        record.status = "failed";
        record.terminalFreshness = "dead";
        record.terminalOutcome = "failed";
        record.errorMessage = result.errorMessage ?? "Background task exceeded its maximum runtime.";
      } else {
        record.status = "cancelled";
        record.terminalFreshness = "healthy";
        record.terminalOutcome = undefined;
      }
    } else if (result.aborted) {
      record.status = "cancelled";
      record.terminalFreshness = "healthy";
      record.terminalOutcome = undefined;
    } else if (result.spawnError || result.subagentActivationError) {
      record.status = "failed";
      record.terminalFreshness = "healthy";
      record.terminalOutcome = "failed";
      record.errorMessage = result.spawnError ?? result.subagentActivationError ?? result.errorMessage;
    } else if (result.exitCode === 0) {
      record.status = "succeeded";
      record.terminalFreshness = "healthy";
    } else {
      record.status = "failed";
      record.terminalFreshness = "healthy";
      record.terminalOutcome = "failed";
      if (result.errorMessage) record.errorMessage = result.errorMessage;
    }

    this.settle(record);
  }

  private finalizeToolResult(
    record: MmrAsyncTaskRecord,
    result: MmrAsyncTaskToolRunResult,
  ): void {
    const now = this.nowMs();
    record.finalToolResult = result.toolResult;
    record.runnerSettled = true;
    record.completedAtMs = now;
    record.updatedAtMs = now;
    record.terminalOutcome = result.terminalOutcome;
    let status = result.status ?? "succeeded";
    if (record.cancelRequestedAtMs !== undefined) {
      if (record.expiredByWatchdog) {
        status = "failed";
        record.terminalFreshness = "dead";
        record.terminalOutcome = "failed";
        record.errorMessage = result.errorMessage ?? "Background task exceeded its maximum runtime.";
      } else {
        status = "cancelled";
        record.terminalFreshness = "healthy";
        record.terminalOutcome = undefined;
      }
    } else {
      record.terminalFreshness = "healthy";
      if (result.errorMessage) record.errorMessage = result.errorMessage;
    }
    record.status = status;
    this.settle(record);
  }

  private finalizeDead(
    record: MmrAsyncTaskRecord,
    now: number,
    message = "Background task did not stop after cancellation.",
  ): void {
    if (isTerminalStatus(record.status)) return;
    record.runGeneration += 1;
    record.runnerSettled = true;
    record.completedAtMs = now;
    record.updatedAtMs = now;
    record.status = "failed";
    record.terminalFreshness = "dead";
    record.terminalOutcome = "failed";
    record.errorMessage = record.expiredByWatchdog
      ? "Background task exceeded its maximum runtime."
      : message;
    this.settle(record);
  }

  private finalizeError(
    record: MmrAsyncTaskRecord,
    generation: number,
    err: unknown,
  ): void {
    if (generation !== record.runGeneration) return;
    if (isTerminalStatus(record.status)) return;
    const now = this.nowMs();
    record.runnerSettled = true;
    record.completedAtMs = now;
    record.updatedAtMs = now;
    if (record.cancelRequestedAtMs !== undefined) {
      if (record.expiredByWatchdog) {
        record.status = "failed";
        record.terminalFreshness = "dead";
        record.terminalOutcome = "failed";
        record.errorMessage = "Background task exceeded its maximum runtime.";
      } else {
        record.status = "cancelled";
        record.terminalFreshness = "healthy";
        record.terminalOutcome = undefined;
      }
    } else {
      record.status = "failed";
      record.terminalFreshness = "healthy";
      record.terminalOutcome = "failed";
      record.errorMessage = err instanceof Error ? err.message : String(err);
    }
    this.settle(record);
  }

  /** Mark a non-terminal runaway task as expired and abort its worker. */
  private requestExpiry(record: MmrAsyncTaskRecord, now: number): void {
    if (record.expiredByWatchdog || isTerminalStatus(record.status)) return;
    record.expiredByWatchdog = true;
    if (record.cancelRequestedAtMs === undefined) {
      record.cancelRequestedAtMs = now;
      record.cancelReason = "expired";
      record.status = "cancelling";
      record.updatedAtMs = now;
    }
    if (!record.controller.signal.aborted) record.controller.abort();
  }

  private expireByWatchdog(record: MmrAsyncTaskRecord, generation: number): void {
    if (generation !== record.runGeneration) return;
    this.requestExpiry(record, this.nowMs());
  }

  private clearWatchdog(record: MmrAsyncTaskRecord): void {
    if (record.watchdogTimer) {
      clearTimeout(record.watchdogTimer);
      record.watchdogTimer = undefined;
    }
  }

  /** Resolve waiters and fire the at-most-once completion push. */
  private settle(record: MmrAsyncTaskRecord): void {
    this.clearWatchdog(record);
    // Capture observation intent BEFORE draining waiters: an active waiter at
    // settle time means a blocked task_wait is about to consume this terminal
    // result, so a completion push would only duplicate a result in hand. The
    // waiter's continuation sets finalObservedAtMs on a later microtask (after
    // maybeNotify runs synchronously here), so the live waiter — not
    // finalObservedAtMs — is the reliable concurrent-observation signal.
    const observedByWaiter = record.waiters.size > 0;
    for (const waiter of [...record.waiters]) {
      record.waiters.delete(waiter);
      try {
        waiter();
      } catch {
        // Waiter resolvers never throw in practice; ignore defensively.
      }
    }
    this.fireSettleCallback(record);
    this.maybeNotify(record, observedByWaiter);
    this.maybeSettleGroup(record.groupId, record.sessionKey);
  }

  private fireSettleCallback(record: MmrAsyncTaskRecord): void {
    const onSettle = record.onSettle;
    if (!onSettle) return;
    const snapshot = this.snapshot(record);
    void Promise.resolve().then(() => onSettle(snapshot)).catch(() => {
      // UI lifecycle hooks are best-effort and must never affect task state.
    });
  }

  private maybeNotify(record: MmrAsyncTaskRecord, observedByWaiter = false): void {
    if (record.completionPush !== "pending" || !record.notify) return;
    // Skip the push when the parent already observed (or is actively waiting on)
    // the terminal result via task_wait/task_poll: the agent has the result in
    // hand, so pushing would double-surface the same finished task. This does
    // not consume the per-session push budget.
    if (observedByWaiter || record.finalObservedAtMs !== undefined) {
      record.completionPush = "observed";
      return;
    }
    // Per-session budget: even with push opted in, a session can only
    // self-wake a bounded number of times so a runaway plan cannot spam
    // (or loop) turns. An over-budget completion is recorded as suppressed.
    const used = this.completionPushesUsed.get(record.sessionKey) ?? 0;
    if (used >= this.maxCompletionPushesPerSession) {
      record.completionPush = "suppressed";
      return;
    }
    this.completionPushesUsed.set(record.sessionKey, used + 1);
    // Mutate state synchronously BEFORE awaiting so concurrent
    // poll/cancel/prune can never trigger a second send.
    record.completionPush = "sending";
    const snapshot = this.snapshot(record);
    void Promise.resolve()
      .then(() => record.notify?.(snapshot))
      .then(
        () => {
          record.completionPush = "sent";
        },
        () => {
          // Never retry; a failed push must not spam the session.
          record.completionPush = "failed";
        },
      );
  }

  private groupChildren(group: MmrAsyncTaskGroupRecord): MmrAsyncTaskRecord[] {
    const map = this.sessions.get(group.sessionKey);
    if (!map) return [];
    return [...group.taskIds].flatMap((taskId) => {
      const record = map.get(taskId);
      return record ? [record] : [];
    });
  }

  private groupStatus(children: readonly MmrAsyncTaskRecord[]): MmrAsyncTaskGroupStatus {
    if (children.length === 0 || children.some((child) => !isTerminalStatus(child.status))) return "running";
    if (children.some((child) => child.status === "failed" || child.terminalFreshness === "dead")) return "failed";
    if (children.some((child) => child.status === "cancelled")) return "cancelled";
    if (children.some((child) => child.terminalOutcome === "partial")) return "partial";
    return "completed";
  }

  private groupSnapshot(group: MmrAsyncTaskGroupRecord): MmrAsyncTaskGroupSnapshot {
    const now = this.nowMs();
    const children = this.groupChildren(group);
    const status = this.groupStatus(children);
    return {
      groupId: group.groupId,
      status,
      generatedAtMs: now,
      createdAtMs: group.createdAtMs,
      updatedAtMs: group.updatedAtMs,
      ...(group.completedAtMs !== undefined ? { completedAtMs: group.completedAtMs } : {}),
      completionPush: group.completionPush,
      taskIds: children.map((child) => child.taskId),
      counts: {
        running: children.filter((child) => !isTerminalStatus(child.status)).length,
        succeeded: children.filter((child) => child.status === "succeeded").length,
        failed: children.filter((child) => child.status === "failed").length,
        cancelled: children.filter((child) => child.status === "cancelled").length,
        partial: children.filter((child) => child.terminalOutcome === "partial").length,
        total: children.length,
      },
    };
  }

  private markGroupObserved(group: MmrAsyncTaskGroupRecord): void {
    const now = this.nowMs();
    group.finalObservedAtMs = now;
    for (const child of this.groupChildren(group)) {
      if (isTerminalStatus(child.status) && child.finalObservedAtMs === undefined) child.finalObservedAtMs = now;
    }
  }

  private fireGroupSettleCallback(group: MmrAsyncTaskGroupRecord): void {
    const onSettle = group.onSettle;
    if (!onSettle) return;
    const snapshot = this.groupSnapshot(group);
    void Promise.resolve().then(() => onSettle(snapshot)).catch(() => {
      // UI lifecycle hooks are best-effort and must never affect group state.
    });
  }

  private maybeNotifyGroup(group: MmrAsyncTaskGroupRecord, observedByWaiter = false): void {
    if (group.completionPush !== "pending" || !group.notify) return;
    if (observedByWaiter || group.finalObservedAtMs !== undefined) {
      group.completionPush = "observed";
      return;
    }
    const used = this.completionPushesUsed.get(group.sessionKey) ?? 0;
    if (used >= this.maxCompletionPushesPerSession) {
      group.completionPush = "suppressed";
      return;
    }
    this.completionPushesUsed.set(group.sessionKey, used + 1);
    group.completionPush = "sending";
    const snapshot = this.groupSnapshot(group);
    void Promise.resolve()
      .then(() => group.notify?.(snapshot))
      .then(
        () => {
          group.completionPush = "sent";
        },
        () => {
          group.completionPush = "failed";
        },
      );
  }

  private maybeSettleGroup(groupId: string | undefined, sessionKey: string): void {
    if (!groupId) return;
    const group = this.groups.get(sessionKey)?.get(groupId);
    if (!group) return;
    const snapshot = this.groupSnapshot(group);
    group.updatedAtMs = this.nowMs();
    if (snapshot.status === "running") return;
    if (group.completedAtMs === undefined) {
      group.completedAtMs = this.nowMs();
      const observedByWaiter = group.waiters.size > 0;
      for (const waiter of [...group.waiters]) {
        group.waiters.delete(waiter);
        try {
          waiter();
        } catch {
          // ignore
        }
      }
      this.fireGroupSettleCallback(group);
      this.maybeNotifyGroup(group, observedByWaiter);
    }
  }

  getTask(sessionKey: string, taskId: string): MmrAsyncTaskInternalSnapshot | undefined {
    this.prune(sessionKey);
    const record = this.sessions.get(sessionKey)?.get(taskId);
    if (!record) return undefined;
    // A direct poll of a terminal task counts as observation, shortening
    // its retention so consumed results do not linger.
    if (isTerminalStatus(record.status) && record.finalObservedAtMs === undefined) {
      record.finalObservedAtMs = this.nowMs();
    }
    return this.snapshot(record);
  }

  getGroup(sessionKey: string, groupId: string): MmrAsyncTaskGroupSnapshot | undefined {
    this.prune(sessionKey);
    if (!isValidAsyncTaskGroupId(groupId)) return undefined;
    const group = this.groups.get(sessionKey)?.get(groupId);
    return group ? this.groupSnapshot(group) : undefined;
  }

  dropEmptyGroup(sessionKey: string, groupId: string): boolean {
    const map = this.groups.get(sessionKey);
    const group = map?.get(groupId);
    if (!map || !group || group.taskIds.size > 0) return false;
    map.delete(groupId);
    return true;
  }

  listTasks(sessionKey: string): MmrAsyncTaskBoard {
    this.prune(sessionKey);
    const now = this.nowMs();
    const map = this.sessions.get(sessionKey);
    const board: MmrAsyncTaskBoard = {
      version: 1,
      generatedAtMs: now,
      counts: { active: 0, stalled: 0, finished: 0 },
      active: [],
      stalled: [],
      finished: [],
    };
    if (!map) return board;
    // Listing is NOT a final observation; it must not shorten retention.
    for (const record of map.values()) {
      const entry = this.boardEntry(record);
      if (isTerminalStatus(record.status)) {
        board.finished.push(entry);
      } else if (entry.freshness === "healthy") {
        board.active.push(entry);
      } else {
        board.stalled.push(entry);
      }
    }
    const byCreated = (a: MmrAsyncTaskBoardEntry, b: MmrAsyncTaskBoardEntry) => a.createdAtMs - b.createdAtMs;
    board.active.sort(byCreated);
    board.stalled.sort(byCreated);
    board.finished.sort(byCreated);
    board.counts = {
      active: board.active.length,
      stalled: board.stalled.length,
      finished: board.finished.length,
    };
    return board;
  }

  private async waitForRecord(
    record: MmrAsyncTaskRecord,
    timeoutMs: number,
    observe: boolean,
  ): Promise<boolean> {
    if (isTerminalStatus(record.status)) {
      if (observe && record.finalObservedAtMs === undefined) record.finalObservedAtMs = this.nowMs();
      return true;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let waiter: (() => void) | undefined;
    const settled = await new Promise<boolean>((resolve) => {
      waiter = () => resolve(true);
      record.waiters.add(waiter);
      timer = setTimeout(() => resolve(false), timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    });
    if (timer) clearTimeout(timer);
    if (waiter) record.waiters.delete(waiter);
    if (settled && observe && isTerminalStatus(record.status) && record.finalObservedAtMs === undefined) {
      record.finalObservedAtMs = this.nowMs();
    }
    return settled;
  }

  async waitForTask(args: {
    sessionKey: string;
    taskId: string;
    timeoutMs?: number;
  }): Promise<WaitForAsyncTaskResult> {
    this.prune(args.sessionKey);
    const record = this.sessions.get(args.sessionKey)?.get(args.taskId);
    if (!record) {
      return { found: false, timedOut: false };
    }
    const rawTimeout = args.timeoutMs ?? DEFAULT_TASK_WAIT_TIMEOUT_MS;
    const timeoutMs = Math.max(0, Math.min(rawTimeout, MAX_TASK_WAIT_TIMEOUT_MS));
    const settled = await this.waitForRecord(record, timeoutMs, true);
    // A wait timeout must NOT cancel the worker.
    return { found: true, timedOut: !settled, snapshot: this.snapshot(record) };
  }

  async waitForGroup(args: {
    sessionKey: string;
    groupId: string;
    timeoutMs?: number;
  }): Promise<WaitForAsyncTaskGroupResult> {
    this.prune(args.sessionKey);
    if (!isValidAsyncTaskGroupId(args.groupId)) return { found: false, timedOut: false };
    const group = this.groups.get(args.sessionKey)?.get(args.groupId);
    if (!group) return { found: false, timedOut: false };
    const rawTimeout = args.timeoutMs ?? DEFAULT_TASK_WAIT_TIMEOUT_MS;
    const timeoutMs = Math.max(0, Math.min(rawTimeout, MAX_TASK_WAIT_TIMEOUT_MS));
    const children = this.groupChildren(group);
    const snapshotBefore = this.groupSnapshot(group);
    if (snapshotBefore.status !== "running") {
      this.markGroupObserved(group);
      return { found: true, timedOut: false, snapshot: this.groupSnapshot(group) };
    }
    if (children.length === 0) return { found: true, timedOut: false, snapshot: snapshotBefore };
    const waits = children
      .filter((child) => !isTerminalStatus(child.status))
      .map((child) => this.waitForRecord(child, timeoutMs, false));
    let groupTimer: ReturnType<typeof setTimeout> | undefined;
    const allSettled = await Promise.race([
      Promise.allSettled(waits).then(() => true),
      new Promise<boolean>((resolve) => {
        groupTimer = setTimeout(() => resolve(false), timeoutMs);
        if (typeof groupTimer.unref === "function") groupTimer.unref();
      }),
    ]);
    if (groupTimer) clearTimeout(groupTimer);
    const snapshot = this.groupSnapshot(group);
    const terminal = snapshot.status !== "running";
    if (terminal) this.markGroupObserved(group);
    return { found: true, timedOut: !allSettled || !terminal, snapshot: this.groupSnapshot(group) };
  }

  async cancelTask(args: {
    sessionKey: string;
    taskId: string;
    reason?: string;
  }): Promise<MmrAsyncTaskInternalSnapshot | undefined> {
    this.prune(args.sessionKey);
    const record = this.sessions.get(args.sessionKey)?.get(args.taskId);
    if (!record) return undefined;
    if (isTerminalStatus(record.status)) {
      // Idempotent: cancelling an already-terminal task is a no-op read.
      return this.snapshot(record);
    }
    const now = this.nowMs();
    if (record.cancelRequestedAtMs === undefined) {
      record.cancelRequestedAtMs = now;
      record.cancelReason = args.reason ?? "cancelled by request";
      record.status = "cancelling";
      record.updatedAtMs = now;
      if (!record.controller.signal.aborted) record.controller.abort();
    }
    // Best-effort bounded wait for the worker to actually settle. Clear the
    // grace timer when the worker settles first so it does not linger.
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      await Promise.race([
        record.promise ?? Promise.resolve(),
        new Promise<void>((resolve) => {
          graceTimer = setTimeout(() => {
            timedOut = true;
            resolve();
          }, this.cancelDeadAfterMs);
          if (typeof graceTimer.unref === "function") graceTimer.unref();
        }),
      ]);
    } finally {
      if (graceTimer) clearTimeout(graceTimer);
    }
    if (timedOut && !isTerminalStatus(record.status)) {
      this.finalizeDead(record, this.nowMs());
    }
    return this.snapshot(record);
  }

  async cancelGroup(args: {
    sessionKey: string;
    groupId: string;
    reason?: string;
  }): Promise<MmrAsyncTaskGroupSnapshot | undefined> {
    this.prune(args.sessionKey);
    if (!isValidAsyncTaskGroupId(args.groupId)) return undefined;
    const group = this.groups.get(args.sessionKey)?.get(args.groupId);
    if (!group) return undefined;
    const children = this.groupChildren(group).filter((child) => !isTerminalStatus(child.status));
    await Promise.allSettled(children.map((child) => this.cancelTask({
      sessionKey: args.sessionKey,
      taskId: child.taskId,
      ...(args.reason !== undefined ? { reason: args.reason } : {}),
    })));
    this.maybeSettleGroup(args.groupId, args.sessionKey);
    return this.groupSnapshot(group);
  }

  prune(sessionKey?: string): void {
    const now = this.nowMs();
    const keys = sessionKey !== undefined ? [sessionKey] : [...this.sessions.keys()];
    for (const key of keys) {
      const map = this.sessions.get(key);
      if (!map) continue;
      for (const [taskId, record] of [...map.entries()]) {
        if (!isTerminalStatus(record.status)) {
          // Backstop watchdog: request cancellation for runaway tasks even
          // if the active timer was missed.
          if (now >= record.maxRuntimeAtMs) this.requestExpiry(record, now);
          // A worker that ignores the abort cannot keep consuming the
          // concurrency cap forever; finalize it after the cancel grace.
          if (
            record.cancelRequestedAtMs !== undefined
            && now - record.cancelRequestedAtMs > this.cancelDeadAfterMs
          ) {
            this.finalizeDead(record, now);
          }
          continue;
        }
        const observed = record.finalObservedAtMs;
        const ttl = observed !== undefined ? this.observedTerminalTtlMs : this.terminalTtlMs;
        const anchor = observed ?? record.completedAtMs ?? record.updatedAtMs;
        if (now - anchor > ttl) {
          this.clearWatchdog(record);
          map.delete(taskId);
          if (record.groupId) this.groups.get(key)?.get(record.groupId)?.taskIds.delete(taskId);
          this.taskIdByToolCallId.delete(this.toolCallIndexKey(key, record.originToolCallId));
        }
      }
      const groupMap = this.groups.get(key);
      if (groupMap) {
        for (const [groupId, group] of [...groupMap.entries()]) {
          for (const taskId of [...group.taskIds]) {
            if (!map.has(taskId)) group.taskIds.delete(taskId);
          }
          if (group.taskIds.size === 0) groupMap.delete(groupId);
        }
        if (groupMap.size === 0) this.groups.delete(key);
      }
      if (map.size === 0) this.sessions.delete(key);
    }
  }

  shutdownSession(sessionKey?: string, reason?: string): void {
    const now = this.nowMs();
    const keys = sessionKey !== undefined ? [sessionKey] : [...this.sessions.keys()];
    for (const key of keys) {
      const map = this.sessions.get(key);
      if (!map) continue;
      for (const record of map.values()) {
        // Invalidate any still-in-flight worker callbacks for this record so
        // a late finalize/progress cannot mutate it or fire a completion
        // push after the session has ended.
        record.runGeneration += 1;
        this.clearWatchdog(record);
        record.completionPush = "disabled";
        record.notify = undefined;
        if (!record.controller.signal.aborted) record.controller.abort();
        if (!isTerminalStatus(record.status)) {
          record.status = "cancelled";
          record.terminalFreshness = "healthy";
          record.terminalOutcome = undefined;
          record.cancelReason = reason ?? "session shutdown";
          record.completedAtMs = now;
          record.updatedAtMs = now;
        }
        this.taskIdByToolCallId.delete(this.toolCallIndexKey(key, record.originToolCallId));
        for (const waiter of [...record.waiters]) {
          record.waiters.delete(waiter);
          try {
            waiter();
          } catch {
            // ignore
          }
        }
      }
      const groupMap = this.groups.get(key);
      if (groupMap) {
        for (const group of groupMap.values()) {
          group.completionPush = "disabled";
          group.notify = undefined;
          for (const waiter of [...group.waiters]) {
            group.waiters.delete(waiter);
            try {
              waiter();
            } catch {
              // ignore
            }
          }
        }
        this.groups.delete(key);
      }
      this.completionPushesUsed.delete(key);
      this.sessions.delete(key);
    }
  }

  private freshness(record: MmrAsyncTaskRecord, now: number): MmrAsyncTaskFreshness {
    if (isTerminalStatus(record.status)) return "terminal";
    if (
      record.cancelRequestedAtMs !== undefined &&
      now - record.cancelRequestedAtMs > this.cancelDeadAfterMs
    ) {
      return "dead";
    }
    if (now > record.maxRuntimeAtMs + this.cancelDeadAfterMs) return "dead";
    const observedAt = record.lastProgressAtMs ?? record.startedAtMs ?? record.createdAtMs;
    if (now - observedAt > this.stalledAfterMs) return "stalled";
    return "healthy";
  }

  private snapshot(record: MmrAsyncTaskRecord): MmrAsyncTaskInternalSnapshot {
    const now = this.nowMs();
    const lastProgressAt = record.lastProgressAtMs;
    return {
      taskId: record.taskId,
      status: record.status,
      freshness: this.freshness(record, now),
      ...(record.terminalFreshness !== undefined ? { terminalFreshness: record.terminalFreshness } : {}),
      agent: record.agent,
      description: record.description,
      prompt: record.prompt,
      cwd: record.cwd,
      ...(record.resolvedModel !== undefined ? { resolvedModel: record.resolvedModel } : {}),
      ...(record.contextWindow !== undefined ? { contextWindow: record.contextWindow } : {}),
      workerTools: record.workerTools,
      createdAtMs: record.createdAtMs,
      startedAtMs: record.startedAtMs,
      updatedAtMs: record.updatedAtMs,
      ...(lastProgressAt !== undefined ? { lastProgressAtMs: lastProgressAt } : {}),
      ...(record.completedAtMs !== undefined ? { completedAtMs: record.completedAtMs } : {}),
      ...(record.cancelRequestedAtMs !== undefined ? { cancelRequestedAtMs: record.cancelRequestedAtMs } : {}),
      ...(record.cancelReason !== undefined ? { cancelReason: record.cancelReason } : {}),
      runtimeMs: (record.completedAtMs ?? now) - record.startedAtMs,
      ...(lastProgressAt !== undefined ? { lastProgressAgeMs: now - lastProgressAt } : {}),
      completionPush: record.completionPush,
      ...(record.terminalOutcome !== undefined ? { terminalOutcome: record.terminalOutcome } : {}),
      ...(record.capabilityProfile !== undefined ? { capabilityProfile: record.capabilityProfile } : {}),
      ...(record.groupId !== undefined ? { groupId: record.groupId } : {}),
      ...(record.latestProgress !== undefined ? { latestProgress: record.latestProgress } : {}),
      ...(record.latestToolResult !== undefined ? { latestToolResult: record.latestToolResult } : {}),
      ...(record.finalResult !== undefined ? { finalResult: record.finalResult } : {}),
      ...(record.finalToolResult !== undefined ? { finalToolResult: record.finalToolResult } : {}),
      ...(record.errorMessage !== undefined ? { errorMessage: record.errorMessage } : {}),
    };
  }

  private boardEntry(record: MmrAsyncTaskRecord): MmrAsyncTaskBoardEntry {
    const now = this.nowMs();
    const lastProgressAt = record.lastProgressAtMs;
    const progress = record.latestProgress;
    const latestTool = latestToolFromProgress(progress);
    const toolCount = progress?.trail.filter((item) => item.type === "tool").length;
    return {
      taskId: record.taskId,
      status: record.status,
      freshness: this.freshness(record, now),
      ...(record.terminalFreshness !== undefined ? { terminalFreshness: record.terminalFreshness } : {}),
      agent: record.agent,
      description: record.description,
      createdAtMs: record.createdAtMs,
      startedAtMs: record.startedAtMs,
      updatedAtMs: record.updatedAtMs,
      ...(record.completedAtMs !== undefined ? { completedAtMs: record.completedAtMs } : {}),
      runtimeMs: (record.completedAtMs ?? now) - record.startedAtMs,
      ...(lastProgressAt !== undefined ? { lastProgressAgeMs: now - lastProgressAt } : {}),
      ...(progress?.model !== undefined || record.resolvedModel !== undefined
        ? { resolvedModel: progress?.model ?? record.resolvedModel }
        : {}),
      ...(record.contextWindow !== undefined ? { contextWindow: record.contextWindow } : {}),
      ...(progress?.usage !== undefined ? { usage: { ...progress.usage } } : {}),
      ...(latestTool !== undefined
        ? { latestToolName: latestTool.toolName, latestToolStatus: latestTool.status }
        : {}),
      ...(toolCount !== undefined ? { toolCount } : {}),
      ...(record.terminalOutcome !== undefined ? { terminalOutcome: record.terminalOutcome } : {}),
      ...(record.capabilityProfile !== undefined ? { capabilityProfile: record.capabilityProfile } : {}),
      ...(record.groupId !== undefined ? { groupId: record.groupId } : {}),
      ...(record.errorMessage !== undefined ? { errorMessage: record.errorMessage } : {}),
    };
  }
}

/**
 * Build a fresh, isolated registry instance. Production uses the process
 * singleton via {@link getMmrAsyncTaskRegistry}; tests use this with
 * injected clock/id/caps for determinism.
 */
export function createMmrAsyncTaskRegistry(
  deps: MmrAsyncTaskRegistryDeps = {},
): MmrAsyncTaskRegistry {
  return new AsyncTaskRegistry(deps);
}

const MMR_ASYNC_TASK_REGISTRY_GLOBAL_KEY = "__pi_mmr_subagents_async_task_registry_v1__";

const globalRegistryStore = globalThis as typeof globalThis & {
  [MMR_ASYNC_TASK_REGISTRY_GLOBAL_KEY]?: MmrAsyncTaskRegistry;
};

const REQUIRED_REGISTRY_METHODS = [
  "startTask",
  "openGroup",
  "getTask",
  "getGroup",
  "dropEmptyGroup",
  "listTasks",
  "waitForTask",
  "waitForGroup",
  "cancelTask",
  "cancelGroup",
  "prune",
  "shutdownSession",
] as const satisfies readonly (keyof MmrAsyncTaskRegistry)[];

function isRegistryCompatible(value: unknown): value is MmrAsyncTaskRegistry {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return REQUIRED_REGISTRY_METHODS.every((method) => typeof candidate[method] === "function");
}

/**
 * Process-wide async-task registry singleton.
 *
 * Stored on `globalThis` with a shape-compatibility guard, mirroring
 * `mmr-core/runtime.ts`: Pi may load extension entrypoints with isolated
 * module caches, so a module-local singleton would not be shared across
 * sibling copies. The guard rebuilds the singleton if an older in-process
 * build left an incompatible instance behind.
 */
export function getMmrAsyncTaskRegistry(): MmrAsyncTaskRegistry {
  const existing = globalRegistryStore[MMR_ASYNC_TASK_REGISTRY_GLOBAL_KEY];
  if (isRegistryCompatible(existing)) return existing;
  const fresh = createMmrAsyncTaskRegistry();
  globalRegistryStore[MMR_ASYNC_TASK_REGISTRY_GLOBAL_KEY] = fresh;
  return fresh;
}
