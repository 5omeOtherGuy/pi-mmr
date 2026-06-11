import { DEFAULT_MMR_WORKER_PARTIAL_OUTPUT_POLICY, deriveAsyncTerminalOutcome } from "./runner.js";
import {
  ASYNC_TASK_CANCEL_DEAD_AFTER_MS,
  ASYNC_TASK_MAX_RUNTIME_MS,
  ASYNC_TASK_OBSERVED_TERMINAL_TTL_MS,
  ASYNC_TASK_STALLED_AFTER_MS,
  ASYNC_TASK_TERMINAL_TTL_MS,
  DEFAULT_ASYNC_TASK_MAX_PUSHES_PER_SESSION,
  DEFAULT_ASYNC_TASK_MAX_RUNNING_PER_SESSION,
  DEFAULT_TASK_WAIT_TIMEOUT_MS,
  MAX_TASK_WAIT_TIMEOUT_MS,
  isTerminalGroupStatus,
} from "./async-task-types.js";
import type {
  MmrAsyncTaskBoard,
  MmrAsyncTaskBoardEntry,
  MmrAsyncTaskGroupNotifier,
  MmrAsyncTaskGroupSettleCallback,
  MmrAsyncTaskGroupSnapshot,
  MmrAsyncTaskGroupStatus,
  MmrAsyncTaskInternalSnapshot,
  MmrAsyncTaskProgressResult,
  MmrAsyncTaskRegistry,
  MmrAsyncTaskRegistryDeps,
  MmrAsyncTaskRun,
  MmrAsyncTaskRunResult,
  MmrAsyncTaskToolRunResult,
  MmrAsyncTerminalDeliveryClaim,
  MmrAsyncTerminalDeliveryItem,
  OpenAsyncTaskGroupArgs,
  StartAsyncTaskArgs,
  StartAsyncTaskResult,
  WaitForAsyncTaskGroupResult,
  WaitForAsyncTaskResult,
} from "./async-task-types.js";
import {
  ASYNC_TASK_GROUP_LABEL_MAX_LEN,
  assertValidGroupId,
  defaultGroupIdFactory,
  defaultIdFactory,
  isAgentToolResult,
  isTerminalStatus,
  isToolRunResult,
  isValidAsyncTaskGroupId,
  normalizeGroupLabel,
} from "./async-task-internal.js";
import type {
  MmrAsyncTaskGroupRecord,
  MmrAsyncTaskRecord,
} from "./async-task-internal.js";
import {
  type DeliveryTarget,
  terminalDeliveryOf,
} from "./async-task-delivery.js";
import {
  boardEntryOf,
  groupSnapshotOf,
  groupStatusOf,
  snapshotOf,
  terminalDeliveryItemForGroupOf,
  terminalDeliveryItemForTaskOf,
  toPublicAsyncTaskSnapshot,
  type FreshnessConfig,
} from "./async-task-projection.js";

// Re-export the public group-id validator, label cap, and the lean-snapshot
// projection from their new homes so the entry file remains the stable public
// surface for them.
export { ASYNC_TASK_GROUP_LABEL_MAX_LEN, isValidAsyncTaskGroupId };
export { toPublicAsyncTaskSnapshot };

// Re-export the public async-task types, registry interfaces, and tuning
// constants from their new home (`async-task-types.ts`) for the same reason.
export {
  ASYNC_TASK_CANCEL_DEAD_AFTER_MS,
  ASYNC_TASK_MAX_RUNTIME_MS,
  ASYNC_TASK_OBSERVED_TERMINAL_TTL_MS,
  ASYNC_TASK_STALLED_AFTER_MS,
  ASYNC_TASK_TERMINAL_TTL_MS,
  DEFAULT_ASYNC_TASK_MAX_PUSHES_PER_SESSION,
  DEFAULT_ASYNC_TASK_MAX_RUNNING_PER_SESSION,
  DEFAULT_TASK_WAIT_TIMEOUT_MS,
  MAX_TASK_WAIT_TIMEOUT_MS,
  isTerminalGroupStatus,
} from "./async-task-types.js";
export type {
  MmrAsyncTaskBoard,
  MmrAsyncTaskBoardEntry,
  MmrAsyncTaskCompletionPushState,
  MmrAsyncTaskFreshness,
  MmrAsyncTaskGroupNotifier,
  MmrAsyncTaskGroupSettleCallback,
  MmrAsyncTaskGroupSnapshot,
  MmrAsyncTaskGroupStatus,
  MmrAsyncTaskInternalSnapshot,
  MmrAsyncTaskNotifier,
  MmrAsyncTaskProgressResult,
  MmrAsyncTaskRegistry,
  MmrAsyncTaskRegistryDeps,
  MmrAsyncTaskRun,
  MmrAsyncTaskRunMode,
  MmrAsyncTaskRunResult,
  MmrAsyncTaskSettleCallback,
  MmrAsyncTaskSnapshot,
  MmrAsyncTaskStatus,
  MmrAsyncTaskTerminalFreshness,
  MmrAsyncTaskToolRunResult,
  MmrAsyncTerminalDeliveryClaim,
  MmrAsyncTerminalDeliveryItem,
  OpenAsyncTaskGroupArgs,
  StartAsyncTaskArgs,
  StartAsyncTaskResult,
  WaitForAsyncTaskGroupResult,
  WaitForAsyncTaskResult,
} from "./async-task-types.js";

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
  /** sessionKey -> whether the parent agent loop is currently active. */
  private readonly agentActiveBySession = new Map<string, boolean>();

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

  setSessionAgentActive(sessionKey: string, active: boolean): void {
    this.agentActiveBySession.set(sessionKey, active);
  }

  private isSessionAgentActive(sessionKey: string): boolean {
    return this.agentActiveBySession.get(sessionKey) === true;
  }

  /**
   * Mark a terminal item announced (model-visible) at most once. Used by both
   * the idle-wake push and the in-turn context pull so the two paths cannot
   * drift. Budget suppression does NOT call this, so a suppressed idle wake
   * stays eligible for a later context pull.
   */
  private claimTerminalAnnouncement(target: DeliveryTarget, now = this.nowMs()): boolean {
    if (!target.deliveryOptIn) return false;
    if (target.finalObservedAtMs !== undefined) return false;
    if (target.terminalAnnouncedAtMs !== undefined) return false;
    target.terminalAnnouncedAtMs = now;
    return true;
  }

  private ensureGroup(args: {
    sessionKey: string;
    groupId?: string;
    label?: string;
    deliveryOptIn?: boolean;
    notify?: MmrAsyncTaskGroupNotifier;
    onSettle?: MmrAsyncTaskGroupSettleCallback;
  }): MmrAsyncTaskGroupRecord {
    const groupId = args.groupId ?? this.groupIdFactory();
    assertValidGroupId(groupId);
    const label = normalizeGroupLabel(args.label);
    const map = this.groupMap(args.sessionKey);
    let group = map.get(groupId);
    if (!group) {
      const now = this.nowMs();
      group = {
        groupId,
        sessionKey: args.sessionKey,
        ...(label !== undefined ? { label } : {}),
        createdAtMs: now,
        updatedAtMs: now,
        deliveryOptIn: args.deliveryOptIn === true,
        ...(args.notify !== undefined ? { notify: args.notify } : {}),
        ...(args.onSettle !== undefined ? { onSettle: args.onSettle } : {}),
        waiters: new Set(),
        taskIds: new Set(),
      };
      map.set(groupId, group);
    } else {
      // Set-once: a sibling reuse may fill an absent label, but never clobber
      // the opener's.
      if (label !== undefined) group.label ??= label;
      // The opener's delivery choice is authoritative; a sibling child start
      // must not flip it. Only upgrade disabled->enabled when this call also
      // supplies a group-level delivery owner (§6).
      if (args.deliveryOptIn === true && args.notify !== undefined && !group.deliveryOptIn) {
        group.deliveryOptIn = true;
        group.notify = args.notify;
      } else if (args.notify !== undefined && group.notify === undefined && group.deliveryOptIn) {
        group.notify = args.notify;
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
    const runMode = args.runMode ?? "background";
    const blocking = runMode === "blocking";

    // Idempotency: a retried background tool call with the same id returns
    // the same task rather than spawning a duplicate worker. Blocking runs
    // are never deduplicated — every blocking execute must run fresh, and a
    // reused tool-call id across different blocking tools must not replay an
    // unrelated record.
    const indexKey = this.toolCallIndexKey(args.sessionKey, args.originToolCallId);
    if (!blocking) {
      const existingId = this.taskIdByToolCallId.get(indexKey);
      if (existingId) {
        const existing = map.get(existingId);
        if (existing) {
          return { ok: true, deduplicated: true, snapshot: this.snapshot(existing) };
        }
        this.taskIdByToolCallId.delete(indexKey);
      }
    }

    // The concurrency cap bounds background fan-out only. Blocking runs are
    // exempt in both directions: a blocking start is never rejected, and an
    // in-flight blocking run does not shrink the background capacity.
    if (!blocking) {
      const runningCount = [...map.values()].filter(
        (r) => !isTerminalStatus(r.status) && r.runMode !== "blocking",
      ).length;
      if (runningCount >= this.maxRunningPerSession) {
        return { ok: false, reason: "concurrency-cap", runningCount, cap: this.maxRunningPerSession };
      }
    }

    const group = args.groupId !== undefined
      ? this.ensureGroup({ sessionKey: args.sessionKey, groupId: args.groupId })
      : undefined;
    const manual = args.launchMode === "manual";
    const now = this.nowMs();
    const controller = new AbortController();
    const record: MmrAsyncTaskRecord = {
      taskId: this.idFactory(),
      sessionKey: args.sessionKey,
      originToolCallId: args.originToolCallId,
      runMode,
      agent: args.agent ?? "Task",
      description: args.description,
      prompt: args.prompt,
      cwd: args.cwd,
      ...(args.resolvedModel !== undefined ? { resolvedModel: args.resolvedModel } : {}),
      ...(args.contextWindow !== undefined ? { contextWindow: args.contextWindow } : {}),
      workerTools: args.workerTools,
      ...(args.capabilityProfile !== undefined ? { capabilityProfile: args.capabilityProfile } : {}),
      ...(args.partialOutputPolicy !== undefined ? { partialOutputPolicy: args.partialOutputPolicy } : {}),
      ...(args.groupId !== undefined ? { groupId: args.groupId } : {}),
      status: manual ? "ready" : "running",
      ...(manual ? { deferredLaunch: true } : {}),
      createdAtMs: now,
      startedAtMs: now,
      updatedAtMs: now,
      // A manual/ready task has no runtime budget until it actually launches
      // ({@link launchTask} stamps the real deadline); otherwise the prune
      // backstop could expire a declared-but-unlaunched fleet member by wall
      // time. An immediate task starts its budget now. Blocking runs have no
      // wall-clock budget at all: their lifetime is owned by the tool call
      // (external signal), and a watchdog cancellation would be a
      // model-visible behavior change for long blocking workers.
      maxRuntimeAtMs: manual || blocking ? Number.POSITIVE_INFINITY : now + this.maxRuntimeMs,
      expiredByWatchdog: false,
      controller,
      ...(args.projectResult !== undefined ? { projectResult: args.projectResult } : {}),
      runGeneration: 0,
      runnerSettled: false,
      deliveryOptIn: args.deliveryOptIn,
      ...(args.notify !== undefined ? { notify: args.notify } : {}),
      ...(args.onSettle !== undefined ? { onSettle: args.onSettle } : {}),
      waiters: new Set(),
    };
    map.set(record.taskId, record);
    if (group) {
      group.taskIds.add(record.taskId);
      group.updatedAtMs = now;
    }
    if (!blocking) this.taskIdByToolCallId.set(indexKey, record.taskId);

    // Signal adapter: an external (tool-call) abort requests cancellation of
    // the registered task; the registry controller stays the only signal the
    // run thunk sees, so task abort never depends on a live tool call.
    if (args.externalSignal) {
      const external = args.externalSignal;
      const onAbort = (): void => this.requestExternalCancel(record);
      if (external.aborted) {
        onAbort();
      } else {
        external.addEventListener("abort", onAbort, { once: true });
        record.externalAbortCleanup = () => external.removeEventListener("abort", onAbort);
      }
    }

    // Manual launch holds the run thunk until launchTask fires it; an immediate
    // start runs right away. Either way the watchdog clock starts only when the
    // worker actually begins, so a ready task never expires by wall time.
    if (manual) {
      record.pendingRun = args.run;
    } else {
      this.beginRun(record, args.run);
    }

    return { ok: true, deduplicated: false, snapshot: this.snapshot(record) };
  }

  /**
   * Invoke a task's run thunk and arm its max-runtime watchdog. Shared by the
   * immediate start path and {@link launchTask}; a runaway worker is aborted
   * even if the parent never polls/lists/waits again (prune is a backstop).
   */
  private beginRun(record: MmrAsyncTaskRecord, run: MmrAsyncTaskRun): void {
    const generation = record.runGeneration;
    const controller = record.controller;
    record.promise = (async () => {
      let result: MmrAsyncTaskRunResult;
      try {
        result = await run({
          signal: controller.signal,
          onProgress: (snapshot) => this.handleProgress(record, generation, snapshot),
        });
      } catch (err) {
        this.finalizeError(record, generation, err);
        return;
      }
      this.finalizeResult(record, generation, result);
    })();
    if (record.runMode !== "blocking" && Number.isFinite(this.maxRuntimeMs) && this.maxRuntimeMs > 0) {
      const timer = setTimeout(() => this.expireByWatchdog(record, generation), this.maxRuntimeMs);
      if (typeof timer.unref === "function") timer.unref();
      record.watchdogTimer = timer;
    }
  }

  /**
   * External-signal abort (the adapter installed by {@link startTask}):
   * request cancellation exactly like `cancelTask`'s non-terminal branch,
   * without the bounded settle wait — the caller that owns the external
   * signal is also the one awaiting settle.
   */
  private requestExternalCancel(record: MmrAsyncTaskRecord): void {
    if (isTerminalStatus(record.status)) return;
    if (record.status === "ready") {
      // Never launched: drop the held run thunk and finalize synchronously.
      const now = this.nowMs();
      record.cancelRequestedAtMs = now;
      record.cancelReason = "tool call aborted";
      record.status = "cancelled";
      record.terminalFreshness = "healthy";
      record.terminalOutcome = undefined;
      record.completedAtMs = now;
      record.updatedAtMs = now;
      record.pendingRun = undefined;
      if (record.finalObservedAtMs === undefined) record.finalObservedAtMs = now;
      this.settle(record);
      return;
    }
    if (record.cancelRequestedAtMs === undefined) {
      const now = this.nowMs();
      record.cancelRequestedAtMs = now;
      record.cancelReason = "tool call aborted";
      record.status = "cancelling";
      record.updatedAtMs = now;
    }
    if (!record.controller.signal.aborted) record.controller.abort();
  }

  launchTask(sessionKey: string, taskId: string): MmrAsyncTaskInternalSnapshot | undefined {
    this.prune(sessionKey);
    const record = this.sessions.get(sessionKey)?.get(taskId);
    if (!record) return undefined;
    // Idempotent: only a `ready` task with a held run thunk launches; a task
    // already running/terminal (or already launched) returns its current state.
    if (record.status !== "ready") return this.snapshot(record);
    const run = record.pendingRun;
    if (!run) return this.snapshot(record);
    record.pendingRun = undefined;
    const now = this.nowMs();
    record.status = "running";
    record.startedAtMs = now;
    record.updatedAtMs = now;
    record.maxRuntimeAtMs = now + this.maxRuntimeMs;
    this.beginRun(record, run);
    return this.snapshot(record);
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
    // The policy bit comes from the worker's subagent profile (threaded
    // through StartAsyncTaskArgs), so background classification and the
    // blocking tools always agree on what a nonzero exit means.
    record.terminalOutcome = deriveAsyncTerminalOutcome(result, {
      partialOutputPolicy: record.partialOutputPolicy ?? DEFAULT_MMR_WORKER_PARTIAL_OUTPUT_POLICY,
    });

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
    } else if (record.terminalOutcome !== "failed") {
      // Status follows the SAME profile-policy classification that produced
      // terminalOutcome (one classifier across every surface): a nonzero exit
      // with usable output under prefer-usable-output is a success, and a
      // clean exit with no usable output (empty-output) is a failure —
      // matching what the worker's own result shaping reports.
      record.status = "succeeded";
      record.terminalFreshness = "healthy";
    } else {
      record.status = "failed";
      record.terminalFreshness = "healthy";
      if (result.errorMessage) record.errorMessage = result.errorMessage;
    }

    // Projection is the ONE result path: materialize the final tool result
    // from the raw worker result here (best-effort), so the blocking
    // register-and-await path, task_poll's terminal projection, and
    // task_cancel all read the same shaped result.
    if (record.projectResult) {
      try {
        record.finalToolResult = record.projectResult(result);
      } catch {
        // A projection failure must not affect task state; consumers fall
        // back to the raw finalResult.
      }
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

  /**
   * Resolve waiters and decide terminal delivery. The four-way branch (§8.1):
   * 1. an active waiter is about to consume the result → no delivery (the
   *    waiter's continuation marks it observed; for grouped children waited via
   *    a group wait, observe=false leaves child retention intact, §8.3);
   * 2. already observed → no delivery;
   * 3. the agent loop is active → leave pending for the next context pull;
   * 4. otherwise idle → attempt an idle-wake push.
   */
  private settle(record: MmrAsyncTaskRecord): void {
    this.clearWatchdog(record);
    if (record.externalAbortCleanup) {
      try {
        record.externalAbortCleanup();
      } catch {
        // listener removal is best-effort
      }
      record.externalAbortCleanup = undefined;
    }
    // Capture observation intent BEFORE draining waiters: an active waiter at
    // settle time means a blocked task_wait is about to consume this terminal
    // result, so any delivery would only duplicate a result in hand.
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
    if (
      !observedByWaiter
      && record.finalObservedAtMs === undefined
      && !this.isSessionAgentActive(record.sessionKey)
    ) {
      this.maybeNotify(record);
    }
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

  /**
   * Idle-wake push for a terminal task. The caller (settle / flushIdleDeliveries)
   * has already established the session is idle and the item is not observed.
   */
  private maybeNotify(record: MmrAsyncTaskRecord): void {
    if (!record.deliveryOptIn || !record.notify) return;
    if (terminalDeliveryOf(record) !== "pending") return;
    // Per-session budget: even with delivery opted in, a session can only
    // self-wake a bounded number of times so a runaway plan cannot spam (or
    // loop) turns. A budget-suppressed item does NOT claim the announcement,
    // so a later context pull can still surface it.
    const used = this.completionPushesUsed.get(record.sessionKey) ?? 0;
    if (used >= this.maxCompletionPushesPerSession) {
      record.pushOutcome = "suppressed";
      return;
    }
    // Claim before awaiting the notifier so concurrent poll/cancel/prune or a
    // later context pull can never trigger a second surfacing.
    if (!this.claimTerminalAnnouncement(record)) return;
    this.completionPushesUsed.set(record.sessionKey, used + 1);
    record.pushOutcome = "sending";
    const snapshot = this.snapshot(record);
    void Promise.resolve()
      .then(() => record.notify?.(snapshot))
      .then(
        () => {
          record.pushOutcome = "sent";
        },
        () => {
          // Never retry; a failed push must not spam the session.
          record.pushOutcome = "failed";
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
    return groupStatusOf(children);
  }

  private groupSnapshot(group: MmrAsyncTaskGroupRecord): MmrAsyncTaskGroupSnapshot {
    return groupSnapshotOf(group, this.groupChildren(group), this.nowMs());
  }

  /**
   * Mark only the group observed (§8.3). A group poll/wait/cancel surfaces the
   * aggregate group status and child ids, NOT child final outputs, so child
   * observation is left to per-child getTask/waitForTask. This deliberately
   * gives grouped child outputs a slightly longer unobserved retention.
   */
  private markGroupObserved(group: MmrAsyncTaskGroupRecord): void {
    if (group.finalObservedAtMs === undefined) group.finalObservedAtMs = this.nowMs();
  }

  private fireGroupSettleCallback(group: MmrAsyncTaskGroupRecord): void {
    const onSettle = group.onSettle;
    if (!onSettle) return;
    const snapshot = this.groupSnapshot(group);
    void Promise.resolve().then(() => onSettle(snapshot)).catch(() => {
      // UI lifecycle hooks are best-effort and must never affect group state.
    });
  }

  /** Idle-wake push for a terminal group; mirrors {@link maybeNotify}. */
  private maybeNotifyGroup(group: MmrAsyncTaskGroupRecord): void {
    if (!group.deliveryOptIn || !group.notify) return;
    if (terminalDeliveryOf(group) !== "pending") return;
    const used = this.completionPushesUsed.get(group.sessionKey) ?? 0;
    if (used >= this.maxCompletionPushesPerSession) {
      group.pushOutcome = "suppressed";
      return;
    }
    if (!this.claimTerminalAnnouncement(group)) return;
    this.completionPushesUsed.set(group.sessionKey, used + 1);
    group.pushOutcome = "sending";
    const snapshot = this.groupSnapshot(group);
    void Promise.resolve()
      .then(() => group.notify?.(snapshot))
      .then(
        () => {
          group.pushOutcome = "sent";
        },
        () => {
          group.pushOutcome = "failed";
        },
      );
  }

  private maybeSettleGroup(groupId: string | undefined, sessionKey: string): void {
    if (!groupId) return;
    const group = this.groups.get(sessionKey)?.get(groupId);
    if (!group) return;
    const snapshot = this.groupSnapshot(group);
    group.updatedAtMs = this.nowMs();
    if (!isTerminalGroupStatus(snapshot.status)) return;
    if (group.completedAtMs === undefined) {
      group.completedAtMs = this.nowMs();
      // Mirror task settlement (§8.1b): an active group wait registers a waiter,
      // so a group finishing during a group wait is observed, not delivered.
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
      if (observedByWaiter) {
        this.markGroupObserved(group);
      } else if (group.finalObservedAtMs === undefined && !this.isSessionAgentActive(sessionKey)) {
        this.maybeNotifyGroup(group);
      }
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

  getGroup(
    sessionKey: string,
    groupId: string,
    options: { observe?: boolean } = {},
  ): MmrAsyncTaskGroupSnapshot | undefined {
    this.prune(sessionKey);
    if (!isValidAsyncTaskGroupId(groupId)) return undefined;
    const group = this.groups.get(sessionKey)?.get(groupId);
    if (!group) return undefined;
    // A model-facing group poll counts as observing the group only (§8.3);
    // UI/widget mirrors read non-observingly so they never suppress delivery.
    if (options.observe === true && isTerminalGroupStatus(this.groupStatus(this.groupChildren(group)))) {
      this.markGroupObserved(group);
    }
    return this.groupSnapshot(group);
  }

  claimPendingForContext(sessionKey: string, max: number): MmrAsyncTerminalDeliveryClaim {
    this.prune(sessionKey);
    const now = this.nowMs();
    const candidates = this.pendingDeliveryTargets(sessionKey);
    if (max <= 0) {
      return { items: [], hasMore: candidates.length > 0 };
    }
    const hasMore = candidates.length > max;
    const claimed = candidates.slice(0, max);
    const items: MmrAsyncTerminalDeliveryItem[] = [];
    for (const candidate of claimed) {
      if (candidate.kind === "task") {
        if (!this.claimTerminalAnnouncement(candidate.record, now)) continue;
        items.push(this.terminalDeliveryItemForTask(candidate.record));
      } else {
        if (!this.claimTerminalAnnouncement(candidate.group, now)) continue;
        items.push(this.terminalDeliveryItemForGroup(candidate.group));
      }
    }
    return { items, hasMore, ...(items.length > 0 ? { claimedAtMs: now } : {}) };
  }

  flushIdleDeliveries(sessionKey: string): void {
    this.prune(sessionKey);
    for (const candidate of this.pendingDeliveryTargets(sessionKey)) {
      if (candidate.kind === "group") this.maybeNotifyGroup(candidate.group);
      else this.maybeNotify(candidate.record);
    }
  }

  /**
   * Collect eligible pending terminal groups and ungrouped terminal tasks in a
   * single deterministic order (completedAt, then kind, then id). Grouped
   * children are excluded because the group owns automatic delivery.
   */
  private pendingDeliveryTargets(
    sessionKey: string,
  ): (
    | { kind: "task"; record: MmrAsyncTaskRecord; sortTime: number; id: string }
    | { kind: "group"; group: MmrAsyncTaskGroupRecord; sortTime: number; id: string }
  )[] {
    const candidates: (
      | { kind: "task"; record: MmrAsyncTaskRecord; sortTime: number; id: string }
      | { kind: "group"; group: MmrAsyncTaskGroupRecord; sortTime: number; id: string }
    )[] = [];
    const groupMap = this.groups.get(sessionKey);
    if (groupMap) {
      for (const group of groupMap.values()) {
        if (!group.deliveryOptIn) continue;
        if (!isTerminalGroupStatus(this.groupStatus(this.groupChildren(group)))) continue;
        if (terminalDeliveryOf(group) !== "pending") continue;
        candidates.push({
          kind: "group",
          group,
          sortTime: group.completedAtMs ?? group.updatedAtMs,
          id: group.groupId,
        });
      }
    }
    const taskMap = this.sessions.get(sessionKey);
    if (taskMap) {
      for (const record of taskMap.values()) {
        if (record.groupId !== undefined) continue;
        if (!record.deliveryOptIn) continue;
        if (!isTerminalStatus(record.status)) continue;
        if (terminalDeliveryOf(record) !== "pending") continue;
        candidates.push({
          kind: "task",
          record,
          sortTime: record.completedAtMs ?? record.updatedAtMs,
          id: record.taskId,
        });
      }
    }
    candidates.sort(
      (a, b) => a.sortTime - b.sortTime || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id),
    );
    return candidates;
  }

  private terminalDeliveryItemForTask(record: MmrAsyncTaskRecord): MmrAsyncTerminalDeliveryItem {
    return terminalDeliveryItemForTaskOf(record);
  }

  private terminalDeliveryItemForGroup(group: MmrAsyncTaskGroupRecord): MmrAsyncTerminalDeliveryItem {
    return terminalDeliveryItemForGroupOf(group, this.groupSnapshot(group));
  }

  dropEmptyGroup(sessionKey: string, groupId: string): boolean {
    const map = this.groups.get(sessionKey);
    const group = map?.get(groupId);
    if (!map || !group || group.taskIds.size > 0) return false;
    map.delete(groupId);
    return true;
  }

  getRunningCapacity(sessionKey: string): { runningCount: number; cap: number } {
    this.prune(sessionKey);
    const map = this.sessions.get(sessionKey);
    // Blocking runs are cap-exempt (see startTask), so they do not consume
    // background capacity here either.
    const runningCount = map
      ? [...map.values()].filter((r) => !isTerminalStatus(r.status) && r.runMode !== "blocking").length
      : 0;
    return { runningCount, cap: this.maxRunningPerSession };
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
      const entry = this.boardEntry(record, now);
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
    timeoutMs: number | undefined,
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
      // An undefined timeout waits indefinitely (the blocking
      // register-and-await path); settle/shutdown always drain waiters, so
      // an unbounded wait can only outlive the record's run, never leak.
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => resolve(false), timeoutMs);
        if (typeof timer.unref === "function") timer.unref();
      }
    });
    if (timer) clearTimeout(timer);
    if (waiter) record.waiters.delete(waiter);
    if (settled && observe && isTerminalStatus(record.status) && record.finalObservedAtMs === undefined) {
      record.finalObservedAtMs = this.nowMs();
    }
    return settled;
  }

  async waitForSettle(sessionKey: string, taskId: string): Promise<MmrAsyncTaskInternalSnapshot | undefined> {
    const record = this.sessions.get(sessionKey)?.get(taskId);
    if (!record) return undefined;
    await this.waitForRecord(record, undefined, true);
    return this.snapshot(record);
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
    if (isTerminalGroupStatus(snapshotBefore.status)) {
      this.markGroupObserved(group);
      return { found: true, timedOut: false, snapshot: this.groupSnapshot(group) };
    }
    if (children.length === 0) return { found: true, timedOut: false, snapshot: snapshotBefore };
    // Register a group waiter for the duration so a group finishing during this
    // wait is suppressed via maybeSettleGroup's observedByWaiter check (§8.1b),
    // independent of agent-active tracking (covers no-pi.on hosts). The waiter
    // is a sentinel; the actual settle signal is the child-record waits below.
    const groupWaiter = () => {};
    group.waiters.add(groupWaiter);
    let groupTimer: ReturnType<typeof setTimeout> | undefined;
    let allSettled: boolean;
    try {
      const waits = children
        .filter((child) => !isTerminalStatus(child.status))
        .map((child) => this.waitForRecord(child, timeoutMs, false));
      allSettled = await Promise.race([
        Promise.allSettled(waits).then(() => true),
        new Promise<boolean>((resolve) => {
          groupTimer = setTimeout(() => resolve(false), timeoutMs);
          if (typeof groupTimer.unref === "function") groupTimer.unref();
        }),
      ]);
    } finally {
      if (groupTimer) clearTimeout(groupTimer);
      group.waiters.delete(groupWaiter);
    }
    const snapshot = this.groupSnapshot(group);
    const terminal = isTerminalGroupStatus(snapshot.status);
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
      // Idempotent: cancelling an already-terminal task is a no-op read, but the
      // canceller now holds the terminal snapshot, so mark it observed (§8.2) to
      // suppress any idle-wake push or later context notice for it.
      if (record.finalObservedAtMs === undefined) record.finalObservedAtMs = this.nowMs();
      return this.snapshot(record);
    }
    if (record.status === "ready") {
      // Never launched: cancel synchronously without a worker round-trip so the
      // canceller doesn't block on the cancel grace, and the held run thunk is
      // dropped so it can never fire.
      const cancelNow = this.nowMs();
      record.cancelRequestedAtMs = cancelNow;
      record.cancelReason = args.reason ?? "cancelled by request";
      record.status = "cancelled";
      record.terminalFreshness = "healthy";
      record.terminalOutcome = undefined;
      record.completedAtMs = cancelNow;
      record.updatedAtMs = cancelNow;
      record.pendingRun = undefined;
      if (record.finalObservedAtMs === undefined) record.finalObservedAtMs = cancelNow;
      this.settle(record);
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
    // Best-effort bounded wait for the worker to actually settle. Register as
    // an observing waiter so settle() sees the terminal result is being consumed
    // by this task_cancel call and suppresses any automatic delivery (§8.2).
    const settled = await this.waitForRecord(record, this.cancelDeadAfterMs, true);
    if (!settled && !isTerminalStatus(record.status)) {
      // This call will return the synthesized terminal snapshot, so mark it
      // observed BEFORE finalizing; finalizeDead() runs settle() synchronously.
      if (record.finalObservedAtMs === undefined) record.finalObservedAtMs = this.nowMs();
      this.finalizeDead(record, this.nowMs());
    }
    // The canceller holds the terminal snapshot it returns, so mark it observed
    // (§8.2): an idle-wake push or later context notice would double-surface it.
    if (isTerminalStatus(record.status) && record.finalObservedAtMs === undefined) {
      record.finalObservedAtMs = this.nowMs();
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
    // The canceller holds the terminal group snapshot; mark the group observed
    // (§8.3) so no idle-wake/context group notice re-surfaces it.
    if (isTerminalGroupStatus(this.groupStatus(this.groupChildren(group)))) this.markGroupObserved(group);
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
        if (record.externalAbortCleanup) {
          try {
            record.externalAbortCleanup();
          } catch {
            // listener removal is best-effort
          }
          record.externalAbortCleanup = undefined;
        }
        record.deliveryOptIn = false;
        record.notify = undefined;
        record.pushOutcome = undefined;
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
          group.deliveryOptIn = false;
          group.notify = undefined;
          group.pushOutcome = undefined;
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
      this.agentActiveBySession.delete(key);
      this.sessions.delete(key);
    }
  }

  private get freshnessConfig(): FreshnessConfig {
    return { stalledAfterMs: this.stalledAfterMs, cancelDeadAfterMs: this.cancelDeadAfterMs };
  }

  private snapshot(record: MmrAsyncTaskRecord): MmrAsyncTaskInternalSnapshot {
    return snapshotOf(record, this.nowMs(), this.freshnessConfig);
  }

  private boardEntry(record: MmrAsyncTaskRecord, now = this.nowMs()): MmrAsyncTaskBoardEntry {
    return boardEntryOf(record, now, this.freshnessConfig);
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
  "launchTask",
  "getRunningCapacity",
  "openGroup",
  "getTask",
  "getGroup",
  "dropEmptyGroup",
  "listTasks",
  "waitForTask",
  "waitForSettle",
  "waitForGroup",
  "cancelTask",
  "cancelGroup",
  "prune",
  "shutdownSession",
  "setSessionAgentActive",
  "claimPendingForContext",
  "flushIdleDeliveries",
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
