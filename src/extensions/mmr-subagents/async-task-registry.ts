import { randomBytes } from "node:crypto";
import type { MmrWorkerProgressSnapshot, MmrWorkerResult } from "./runner.js";

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
export const DEFAULT_ASYNC_TASK_MAX_RUNNING_PER_SESSION = 3;
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
  | "suppressed";

/**
 * Hard ceiling on how many completion pushes a single session may fire,
 * regardless of how many tasks opt in. A safety rail against a plan that
 * launches many notifying tasks and repeatedly self-wakes the session.
 */
export const DEFAULT_ASYNC_TASK_MAX_PUSHES_PER_SESSION = 8;

/** Run thunk: the registry supplies its own signal + progress sink. */
export type MmrAsyncTaskRun = (ctx: {
  signal: AbortSignal;
  onProgress: (snapshot: MmrWorkerProgressSnapshot) => void;
}) => Promise<MmrWorkerResult>;

/** At-most-once completion notifier (e.g. a `pi.sendMessage` closure). */
export type MmrAsyncTaskNotifier = (
  snapshot: MmrAsyncTaskInternalSnapshot,
) => void | Promise<void>;

export interface StartAsyncTaskArgs {
  sessionKey: string;
  /** Originating Pi tool-call id; used for at-most-once idempotency. */
  originToolCallId: string;
  description: string;
  prompt: string;
  cwd: string;
  resolvedModel?: string;
  contextWindow?: number;
  workerTools: readonly string[];
  run: MmrAsyncTaskRun;
  /**
   * Optional at-most-once completion notifier. When provided, the
   * registry fires it exactly once on terminal transition. Omitted →
   * pull-only (no push).
   */
  notify?: MmrAsyncTaskNotifier;
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
  latestProgress?: MmrWorkerProgressSnapshot;
  finalResult?: MmrWorkerResult;
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
    promptChars: snapshot.prompt.length,
    hasFinalResult: snapshot.finalResult !== undefined,
    ...(snapshot.errorMessage !== undefined ? { errorMessage: snapshot.errorMessage } : {}),
  };
}

export interface MmrAsyncTaskBoardEntry {
  taskId: string;
  status: MmrAsyncTaskStatus;
  freshness: MmrAsyncTaskFreshness;
  terminalFreshness?: MmrAsyncTaskTerminalFreshness;
  description: string;
  createdAtMs: number;
  startedAtMs: number;
  updatedAtMs: number;
  completedAtMs?: number;
  runtimeMs: number;
  lastProgressAgeMs?: number;
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

export interface MmrAsyncTaskRegistry {
  startTask(args: StartAsyncTaskArgs): StartAsyncTaskResult;
  getTask(sessionKey: string, taskId: string): MmrAsyncTaskInternalSnapshot | undefined;
  listTasks(sessionKey: string): MmrAsyncTaskBoard;
  waitForTask(args: {
    sessionKey: string;
    taskId: string;
    timeoutMs?: number;
  }): Promise<WaitForAsyncTaskResult>;
  cancelTask(args: {
    sessionKey: string;
    taskId: string;
    reason?: string;
  }): Promise<MmrAsyncTaskInternalSnapshot | undefined>;
  prune(sessionKey?: string): void;
  shutdownSession(sessionKey?: string, reason?: string): void;
}

export interface MmrAsyncTaskRegistryDeps {
  /** Monotonic-ish wall clock in ms. Injectable for deterministic tests. */
  nowMs?: () => number;
  /** Opaque task-id factory. Injectable for deterministic tests. */
  idFactory?: () => string;
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
  description: string;
  prompt: string;
  cwd: string;
  resolvedModel?: string;
  contextWindow?: number;
  workerTools: readonly string[];
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
  finalResult?: MmrWorkerResult;
  errorMessage?: string;
  notify?: MmrAsyncTaskNotifier;
  completionPush: MmrAsyncTaskCompletionPushState;
  waiters: Set<() => void>;
  promise?: Promise<void>;
}

function isTerminalStatus(status: MmrAsyncTaskStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function defaultIdFactory(): string {
  return `task_${randomBytes(6).toString("hex")}`;
}

class AsyncTaskRegistry implements MmrAsyncTaskRegistry {
  private readonly sessions = new Map<string, Map<string, MmrAsyncTaskRecord>>();
  private readonly taskIdByToolCallId = new Map<string, string>();
  private readonly nowMs: () => number;
  private readonly idFactory: () => string;
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

    const now = this.nowMs();
    const controller = new AbortController();
    const record: MmrAsyncTaskRecord = {
      taskId: this.idFactory(),
      sessionKey: args.sessionKey,
      originToolCallId: args.originToolCallId,
      description: args.description,
      prompt: args.prompt,
      cwd: args.cwd,
      ...(args.resolvedModel !== undefined ? { resolvedModel: args.resolvedModel } : {}),
      ...(args.contextWindow !== undefined ? { contextWindow: args.contextWindow } : {}),
      workerTools: args.workerTools,
      status: "running",
      createdAtMs: now,
      startedAtMs: now,
      updatedAtMs: now,
      maxRuntimeAtMs: now + this.maxRuntimeMs,
      expiredByWatchdog: false,
      controller,
      runGeneration: 0,
      runnerSettled: false,
      ...(args.notify !== undefined ? { notify: args.notify } : {}),
      completionPush: args.notify !== undefined ? "pending" : "disabled",
      waiters: new Set(),
    };
    map.set(record.taskId, record);
    this.taskIdByToolCallId.set(indexKey, record.taskId);

    const generation = record.runGeneration;
    record.promise = (async () => {
      let result: MmrWorkerResult;
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
    snapshot: MmrWorkerProgressSnapshot,
  ): void {
    // Late-write guard: ignore progress after terminal or from a stale run.
    if (generation !== record.runGeneration) return;
    if (isTerminalStatus(record.status)) return;
    const now = this.nowMs();
    record.latestProgress = snapshot;
    record.lastProgressAtMs = now;
    record.updatedAtMs = now;
  }

  private finalizeResult(
    record: MmrAsyncTaskRecord,
    generation: number,
    result: MmrWorkerResult,
  ): void {
    if (generation !== record.runGeneration) return;
    if (isTerminalStatus(record.status)) return;
    const now = this.nowMs();
    record.finalResult = result;
    record.runnerSettled = true;
    record.completedAtMs = now;
    record.updatedAtMs = now;

    if (result.aborted) {
      if (record.expiredByWatchdog) {
        record.status = "failed";
        record.terminalFreshness = "dead";
        record.errorMessage = result.errorMessage ?? "Background task exceeded its maximum runtime.";
      } else {
        record.status = "cancelled";
        record.terminalFreshness = "healthy";
      }
    } else if (result.spawnError || result.subagentActivationError) {
      record.status = "failed";
      record.terminalFreshness = "healthy";
      record.errorMessage = result.spawnError ?? result.subagentActivationError ?? result.errorMessage;
    } else if (result.exitCode === 0) {
      record.status = "succeeded";
      record.terminalFreshness = "healthy";
    } else {
      record.status = "failed";
      record.terminalFreshness = "healthy";
      if (result.errorMessage) record.errorMessage = result.errorMessage;
    }

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
    record.status = "failed";
    record.terminalFreshness = "healthy";
    record.errorMessage = err instanceof Error ? err.message : String(err);
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
    for (const waiter of [...record.waiters]) {
      record.waiters.delete(waiter);
      try {
        waiter();
      } catch {
        // Waiter resolvers never throw in practice; ignore defensively.
      }
    }
    this.maybeNotify(record);
  }

  private maybeNotify(record: MmrAsyncTaskRecord): void {
    if (record.completionPush !== "pending" || !record.notify) return;
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
    if (isTerminalStatus(record.status)) {
      if (record.finalObservedAtMs === undefined) record.finalObservedAtMs = this.nowMs();
      return { found: true, timedOut: false, snapshot: this.snapshot(record) };
    }

    const rawTimeout = args.timeoutMs ?? DEFAULT_TASK_WAIT_TIMEOUT_MS;
    const timeoutMs = Math.max(0, Math.min(rawTimeout, MAX_TASK_WAIT_TIMEOUT_MS));

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

    if (settled && isTerminalStatus(record.status) && record.finalObservedAtMs === undefined) {
      record.finalObservedAtMs = this.nowMs();
    }
    // A wait timeout must NOT cancel the worker.
    return { found: true, timedOut: !settled, snapshot: this.snapshot(record) };
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
    try {
      await Promise.race([
        record.promise ?? Promise.resolve(),
        new Promise<void>((resolve) => {
          graceTimer = setTimeout(resolve, this.cancelDeadAfterMs);
          if (typeof graceTimer.unref === "function") graceTimer.unref();
        }),
      ]);
    } finally {
      if (graceTimer) clearTimeout(graceTimer);
    }
    return this.snapshot(record);
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
          // if the active timer was missed. The run settles asynchronously
          // and finalizes as failed/dead.
          if (now >= record.maxRuntimeAtMs) this.requestExpiry(record, now);
          continue;
        }
        const observed = record.finalObservedAtMs;
        const ttl = observed !== undefined ? this.observedTerminalTtlMs : this.terminalTtlMs;
        const anchor = observed ?? record.completedAtMs ?? record.updatedAtMs;
        if (now - anchor > ttl) {
          this.clearWatchdog(record);
          map.delete(taskId);
          this.taskIdByToolCallId.delete(this.toolCallIndexKey(key, record.originToolCallId));
        }
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
      ...(record.latestProgress !== undefined ? { latestProgress: record.latestProgress } : {}),
      ...(record.finalResult !== undefined ? { finalResult: record.finalResult } : {}),
      ...(record.errorMessage !== undefined ? { errorMessage: record.errorMessage } : {}),
    };
  }

  private boardEntry(record: MmrAsyncTaskRecord): MmrAsyncTaskBoardEntry {
    const now = this.nowMs();
    const lastProgressAt = record.lastProgressAtMs;
    return {
      taskId: record.taskId,
      status: record.status,
      freshness: this.freshness(record, now),
      ...(record.terminalFreshness !== undefined ? { terminalFreshness: record.terminalFreshness } : {}),
      description: record.description,
      createdAtMs: record.createdAtMs,
      startedAtMs: record.startedAtMs,
      updatedAtMs: record.updatedAtMs,
      ...(record.completedAtMs !== undefined ? { completedAtMs: record.completedAtMs } : {}),
      runtimeMs: (record.completedAtMs ?? now) - record.startedAtMs,
      ...(lastProgressAt !== undefined ? { lastProgressAgeMs: now - lastProgressAt } : {}),
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
  "getTask",
  "listTasks",
  "waitForTask",
  "cancelTask",
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
