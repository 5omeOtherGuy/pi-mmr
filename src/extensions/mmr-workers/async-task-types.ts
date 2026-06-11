import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { MmrSubagentPartialOutputPolicy } from "../mmr-core/subagent-profiles.js";
import type {
  MmrAsyncTerminalOutcome,
  MmrWorkerProgressSnapshot,
  MmrWorkerResult,
  MmrWorkerTrailItem,
  MmrWorkerUsageStats,
} from "./runner.js";

/**
 * Public types and tuning constants for the async background-task registry
 * (`async-task-registry.ts`): statuses, snapshot/board/group shapes, the
 * registry interface and its injectable deps, and the timing/cap constants
 * the engine defaults to. Pure declarations only — no registry state, clocks,
 * or side effects live here. `async-task-registry.ts` re-exports everything
 * in this module, so the entry file remains the stable public surface.
 */

/** Lifecycle status of a background async task. */
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

/** Liveness classification a task had at the moment it reached a terminal state. */
export type MmrAsyncTaskTerminalFreshness = "healthy" | "stalled" | "dead";

/** Derived liveness classification based on heartbeat recency and the watchdog. */
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

/** Delivery state of the at-most-once completion push/announcement for a task. */
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

/** Terminal payload produced by a background run (worker or tool-delegating). */
export type MmrAsyncTaskRunResult = MmrWorkerResult | MmrAsyncTaskToolRunResult;

/** Progress payload reported by a background run while it is still live. */
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

/**
 * How a registered run is consumed.
 *
 * - `"background"` (default) — the start_task / `background: true` surface:
 *   counted against the per-session concurrency cap, deduplicated by
 *   `originToolCallId` (idempotent retries), and bounded by the max-runtime
 *   watchdog.
 * - `"blocking"` — a blocking worker tool call that registers its run and
 *   awaits settle inline. Blocking runs are visible on the board but are
 *   cap-exempt (they were never capped), never deduplicated by tool-call id
 *   (each execute must run fresh), and have no max-runtime watchdog (the
 *   tool-call signal owns their lifetime via {@link StartAsyncTaskArgs.externalSignal}).
 */
export type MmrAsyncTaskRunMode = "background" | "blocking";

/** Arguments accepted by {@link MmrAsyncTaskRegistry.startTask}. */
export interface StartAsyncTaskArgs {
  sessionKey: string;
  /** Originating Pi tool-call id; used for at-most-once idempotency. */
  originToolCallId: string;
  /** Consumption mode; see {@link MmrAsyncTaskRunMode}. Default `"background"`. */
  runMode?: MmrAsyncTaskRunMode;
  /**
   * Signal adapter decoupling task abort from the tool-call signal: when the
   * external signal aborts while the task is non-terminal, the registry
   * requests cancellation (status `cancelling` + worker abort) exactly as
   * `cancelTask` would. The registry's own `AbortController` remains the only
   * signal handed to the run thunk, so a background task's cancellation never
   * depends on a live tool call, while a blocking call's abort still cancels
   * its registered task.
   */
  externalSignal?: AbortSignal;
  /**
   * Per-run projection from the raw terminal {@link MmrWorkerResult} to the
   * final tool result. When the run thunk settles with a raw worker result,
   * the registry materializes `finalToolResult` through this (best-effort)
   * so every consumer — the blocking register-and-await path, task_poll's
   * terminal projection, and task_cancel — reads ONE projected result.
   * Ignored for run thunks that already return a tool-run result.
   */
  projectResult?: (result: MmrWorkerResult) => AgentToolResult<unknown>;
  /** User-facing worker kind launched by start_task (Task, finder, librarian). */
  agent?: string;
  description: string;
  prompt: string;
  cwd: string;
  resolvedModel?: string;
  contextWindow?: number;
  workerTools: readonly string[];
  capabilityProfile?: string;
  /**
   * Nonzero-exit output policy declared by the worker's subagent profile
   * (see `MmrSubagentPartialOutputPolicy` in mmr-core). Read by the
   * registry when it classifies a raw `MmrWorkerResult` into a terminal
   * outcome, so the policy bit has one source of truth (the profile)
   * across the blocking and background surfaces. Only run thunks that
   * return raw worker results (the Task agent today) need it; omitted
   * tasks classify under the `"fail-on-nonzero"` default.
   */
  partialOutputPolicy?: MmrSubagentPartialOutputPolicy;
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

/** Start outcome: a snapshot, or a concurrency-cap rejection. */
export type StartAsyncTaskResult =
  | { ok: true; deduplicated: boolean; snapshot: MmrAsyncTaskInternalSnapshot }
  | { ok: false; reason: "concurrency-cap"; runningCount: number; cap: number };

/** Outcome of a blocking wait on a single task. */
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
  /** Consumption mode the run registered under; see {@link MmrAsyncTaskRunMode}. */
  runMode: MmrAsyncTaskRunMode;
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
  /** Consumption mode the run registered under; see {@link MmrAsyncTaskRunMode}. */
  runMode: MmrAsyncTaskRunMode;
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

/** One row of the session task board ({@link MmrAsyncTaskBoard}). */
export interface MmrAsyncTaskBoardEntry {
  taskId: string;
  status: MmrAsyncTaskStatus;
  freshness: MmrAsyncTaskFreshness;
  terminalFreshness?: MmrAsyncTaskTerminalFreshness;
  /** Consumption mode the run registered under; see {@link MmrAsyncTaskRunMode}. */
  runMode: MmrAsyncTaskRunMode;
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

/** Copy-on-read board of the tasks in a session, bucketed by liveness. */
export interface MmrAsyncTaskBoard {
  version: 1;
  generatedAtMs: number;
  counts: { active: number; stalled: number; finished: number };
  active: MmrAsyncTaskBoardEntry[];
  stalled: MmrAsyncTaskBoardEntry[];
  finished: MmrAsyncTaskBoardEntry[];
}

/** Aggregate lifecycle status of a task group (fleet). */
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

/** Copy-on-read view of a task group and its child counts. */
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

/** Outcome of a blocking wait on a task group. */
export interface WaitForAsyncTaskGroupResult {
  found: boolean;
  timedOut: boolean;
  snapshot?: MmrAsyncTaskGroupSnapshot;
}

/** Arguments accepted by {@link MmrAsyncTaskRegistry.openGroup}. */
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

/** Batch of claimed terminal-delivery descriptors plus overflow metadata. */
export interface MmrAsyncTerminalDeliveryClaim {
  items: MmrAsyncTerminalDeliveryItem[];
  hasMore: boolean;
  claimedAtMs?: number;
}

/** At-most-once completion notifier for a task group. */
export type MmrAsyncTaskGroupNotifier = (
  snapshot: MmrAsyncTaskGroupSnapshot,
) => void | Promise<void>;

/** Best-effort lifecycle hook fired after a group reaches a terminal state. */
export type MmrAsyncTaskGroupSettleCallback = (
  snapshot: MmrAsyncTaskGroupSnapshot,
) => void | Promise<void>;

/** Session-scoped registry API for background async tasks and groups. */
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
  /**
   * Await a task's terminal state with NO timeout (unlike `waitForTask`,
   * which is bounded by `MAX_TASK_WAIT_TIMEOUT_MS`). The blocking
   * register-and-await path uses this: the call consumes the result inline,
   * so the settled task is marked observed. Resolves immediately for an
   * already-terminal task and `undefined` for an unknown id.
   */
  waitForSettle(sessionKey: string, taskId: string): Promise<MmrAsyncTaskInternalSnapshot | undefined>;
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

/** Injectable dependencies and tuning knobs for a registry instance. */
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
