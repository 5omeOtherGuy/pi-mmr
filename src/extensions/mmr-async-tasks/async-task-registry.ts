import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
  deriveAsyncTerminalOutcome,
  type MmrAsyncTerminalOutcome,
  type MmrWorkerProgressSnapshot,
  type MmrWorkerResult,
  type MmrWorkerTrailItem,
  type MmrWorkerUsageStats,
} from "../mmr-subagents/runner.js";
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
  /**
   * Declared but not yet launched. Used by the `start_task` fleet form: every
   * member is created `ready` up front so all group cards render before any
   * worker starts, then a deferred launch flips each row to `running`. A
   * single immediate `start_task` never observes this state.
   */
  | "ready"
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
  /**
   * Successful idle-wake transport (compatibility alias). New code projects a
   * surfaced terminal item as {@link "announced"}; `"sent"` is retained in the
   * type for replayed/normalized older shapes.
   */
  | "sent"
  /**
   * The terminal item was surfaced to the model (by an idle-wake push or an
   * in-turn context pull). Replaces a successful `"sent"` for new code.
   */
  | "announced"
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
   * `"immediate"` (default) invokes the run thunk at creation. `"manual"`
   * creates the task `ready` and holds the run thunk until {@link
   * MmrAsyncTaskRegistry.launchTask} fires it — the fleet form declares all
   * members `ready` up front, then launches them on a deferred tick.
   */
  launchMode?: "immediate" | "manual";
  /**
   * Whether automatic model-facing delivery (context pull + idle-wake push) is
   * permitted for this task. Required: the start handler always computes it
   * (§6); the registry never guesses delivery eligibility. Grouped child tasks
   * pass `false` because the group owns automatic delivery.
   */
  deliveryOptIn: boolean;
  /**
   * Optional at-most-once idle-wake notifier. When provided AND `deliveryOptIn`
   * is true, the registry fires it exactly once when the task settles while the
   * session is idle. The notifier is only the idle-wake transport; context pull
   * works from `deliveryOptIn` alone even when this is absent.
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
  /** Declared up front by the fleet form and launched on a deferred tick. */
  deferredLaunch?: boolean;
  /** Projected public delivery state (§12.4); same projection as snapshots. */
  completionPush: MmrAsyncTaskCompletionPushState;
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

export type MmrAsyncTaskGroupStatus =
  /** Every child is `ready`: the fleet is declared but no worker has launched. */
  | "ready"
  | "running"
  | "failed"
  | "cancelled"
  | "partial"
  | "completed";

/**
 * A group is terminal only once every child has finished. `ready` (declared,
 * not launched) and `running` are both non-terminal: settlement, automatic
 * delivery, observation, and wait-completion must treat them the same so a
 * freshly declared fleet is never delivered or "settled" before it launches.
 */
export function isTerminalGroupStatus(status: MmrAsyncTaskGroupStatus): boolean {
  return (
    status === "completed"
    || status === "failed"
    || status === "cancelled"
    || status === "partial"
  );
}

export interface MmrAsyncTaskGroupSnapshot {
  groupId: string;
  status: MmrAsyncTaskGroupStatus;
  /**
   * Human-readable group label resolved to a single source of truth: the
   * explicit label supplied at {@link openGroup}, else the earliest child's
   * description. Omitted only when the group has no explicit label and no
   * children to borrow one from. The widget header and the (future) settlement
   * card both read this so the label is computed once here.
   */
  label?: string;
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
  /**
   * Optional human-readable group label. Set-once: stored only when this call
   * mints a brand-new group, so a later sibling reuse can never clobber the
   * opener's label. Trimmed and length-capped by the registry.
   */
  label?: string;
  /**
   * Whether automatic model-facing delivery is permitted for this group. The
   * opening call owns group-level delivery; sibling child starts do not change
   * it (§6).
   */
  deliveryOptIn: boolean;
  notify?: MmrAsyncTaskGroupNotifier;
  onSettle?: MmrAsyncTaskGroupSettleCallback;
}

/**
 * Raw terminal-delivery descriptor claimed by the in-turn context pull. `kind`
 * is the discriminant: group items always carry `childTaskIds` and `counts`;
 * task items carry neither. The tool layer formats the model-visible text; the
 * registry only returns descriptors and never renders text.
 */
export interface MmrAsyncTerminalDeliveryItem {
  kind: "task" | "group";
  id: string;
  status: MmrAsyncTaskStatus | MmrAsyncTaskGroupStatus;
  description: string;
  completedAtMs?: number;
  terminalOutcome?: MmrAsyncTerminalOutcome;
  errorMessage?: string;
  childTaskIds?: string[];
  counts?: {
    running: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    partial: number;
    total: number;
  };
}

export interface MmrAsyncTerminalDeliveryClaim {
  items: MmrAsyncTerminalDeliveryItem[];
  hasMore: boolean;
  claimedAtMs?: number;
}

export type MmrAsyncTaskGroupNotifier = (
  snapshot: MmrAsyncTaskGroupSnapshot,
) => void | Promise<void>;

export type MmrAsyncTaskGroupSettleCallback = (
  snapshot: MmrAsyncTaskGroupSnapshot,
) => void | Promise<void>;

export interface MmrAsyncTaskRegistry {
  startTask(args: StartAsyncTaskArgs): StartAsyncTaskResult;
  /**
   * Launch a task created with `launchMode:"manual"`: flip `ready`→`running`,
   * stamp `startedAt`, fire the held run thunk once, and arm the watchdog.
   * Idempotent and a no-op for a task that is not `ready`.
   */
  launchTask(sessionKey: string, taskId: string): MmrAsyncTaskInternalSnapshot | undefined;
  /**
   * Current non-terminal task count and the per-session cap. Lets a batch
   * caller (the fleet form) reject a whole fan-out up front instead of
   * creating a partial set that hits the cap mid-way.
   */
  getRunningCapacity(sessionKey: string): { runningCount: number; cap: number };
  openGroup(args: OpenAsyncTaskGroupArgs): MmrAsyncTaskGroupSnapshot;
  getTask(sessionKey: string, taskId: string): MmrAsyncTaskInternalSnapshot | undefined;
  /**
   * Read a group snapshot. Pass `observe: true` for the model-facing
   * task_poll path so a polled terminal group is marked observed; the default
   * is a non-observing read for UI/widget mirrors.
   */
  getGroup(
    sessionKey: string,
    groupId: string,
    options?: { observe?: boolean },
  ): MmrAsyncTaskGroupSnapshot | undefined;
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
  /** Mark whether the parent agent loop is currently active for a session. */
  setSessionAgentActive(sessionKey: string, active: boolean): void;
  /**
   * Claim up to `max` pending terminal items for an in-turn context pull,
   * marking each claimed item announced. Returns raw descriptors plus overflow
   * metadata; the tool layer renders the model-visible text.
   */
  claimPendingForContext(sessionKey: string, max: number): MmrAsyncTerminalDeliveryClaim;
  /** Flush still-pending terminal items through the idle-wake push path. */
  flushIdleDeliveries(sessionKey: string): void;
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
    const manual = args.launchMode === "manual";
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
      status: manual ? "ready" : "running",
      ...(manual ? { deferredLaunch: true } : {}),
      createdAtMs: now,
      startedAtMs: now,
      updatedAtMs: now,
      // A manual/ready task has no runtime budget until it actually launches
      // ({@link launchTask} stamps the real deadline); otherwise the prune
      // backstop could expire a declared-but-unlaunched fleet member by wall
      // time. An immediate task starts its budget now.
      maxRuntimeAtMs: manual ? Number.POSITIVE_INFINITY : now + this.maxRuntimeMs,
      expiredByWatchdog: false,
      controller,
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
    this.taskIdByToolCallId.set(indexKey, record.taskId);

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
    if (Number.isFinite(this.maxRuntimeMs) && this.maxRuntimeMs > 0) {
      const timer = setTimeout(() => this.expireByWatchdog(record, generation), this.maxRuntimeMs);
      if (typeof timer.unref === "function") timer.unref();
      record.watchdogTimer = timer;
    }
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
    const runningCount = map ? [...map.values()].filter((r) => !isTerminalStatus(r.status)).length : 0;
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
