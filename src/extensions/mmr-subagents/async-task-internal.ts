import { randomBytes } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type {
  MmrAsyncTerminalOutcome,
  MmrWorkerProgressSnapshot,
  MmrWorkerResult,
  MmrWorkerTrailItem,
} from "./runner.js";
import type {
  MmrAsyncTaskGroupNotifier,
  MmrAsyncTaskGroupSettleCallback,
  MmrAsyncTaskNotifier,
  MmrAsyncTaskRun,
  MmrAsyncTaskRunResult,
  MmrAsyncTaskSettleCallback,
  MmrAsyncTaskStatus,
  MmrAsyncTaskTerminalFreshness,
  MmrAsyncTaskToolRunResult,
} from "./async-task-registry.js";

/**
 * Pure, state-free guards/factories and the private record/group shapes used by
 * the async-task registry. This module is a leaf: at runtime it imports only
 * `node:crypto` and `./runner.js`. The `import type` references back to
 * `./async-task-registry.js` above are erased by the compiler, so they do not
 * create a runtime import cycle; the entry file imports this module, never the
 * reverse at value level.
 */

/**
 * Internal idle-wake transport status. Distinct from the public
 * `MmrAsyncTaskCompletionPushState`, which is projected from the timestamp/
 * opt-in fields plus this transport status by `projectCompletionPush`.
 */
export type MmrAsyncTaskPushOutcome = "sending" | "sent" | "failed" | "suppressed";

/** Cap on a stored group label so a pathological input can't bloat the header. */
export const ASYNC_TASK_GROUP_LABEL_MAX_LEN = 120;

export function isTerminalStatus(status: MmrAsyncTaskStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

// The lowercase-hex id shape is contractually tied to the validators and
// JSON-schema patterns below (`isValidAsyncTaskGroupId` / `^group_[a-f0-9]{6,}$`
// and the async-task tool schemas). `crypto.randomUUID()` is intentionally NOT
// used: its hyphenated form would fail those patterns. If stronger uniqueness
// is ever needed, widen to `randomBytes(8)` (still hex, still matches `{6,}`).
export function defaultIdFactory(): string {
  return `task_${randomBytes(6).toString("hex")}`;
}

export function defaultGroupIdFactory(): string {
  return `group_${randomBytes(6).toString("hex")}`;
}

export function isValidAsyncTaskGroupId(groupId: string): boolean {
  return /^group_[a-f0-9]{6,}$/.test(groupId);
}

export function assertValidGroupId(groupId: string): void {
  if (!isValidAsyncTaskGroupId(groupId)) {
    throw new Error(`Invalid async task group id "${groupId}"; expected group_<hex>.`);
  }
}

export function isAgentToolResult(value: unknown): value is AgentToolResult<unknown> {
  return typeof value === "object"
    && value !== null
    && Array.isArray((value as { content?: unknown }).content);
}

export function isToolRunResult(value: MmrAsyncTaskRunResult): value is MmrAsyncTaskToolRunResult {
  return typeof value === "object"
    && value !== null
    && "toolResult" in value
    && isAgentToolResult((value as { toolResult?: unknown }).toolResult);
}

export function latestToolFromProgress(
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

export function normalizeGroupLabel(label: string | undefined): string | undefined {
  if (typeof label !== "string") return undefined;
  const trimmed = label.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > ASYNC_TASK_GROUP_LABEL_MAX_LEN
    ? trimmed.slice(0, ASYNC_TASK_GROUP_LABEL_MAX_LEN)
    : trimmed;
}

export interface MmrAsyncTaskRecord {
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
  terminalAnnouncedAtMs?: number;
  deliveryOptIn: boolean;
  pushOutcome?: MmrAsyncTaskPushOutcome;
  terminalFreshness?: MmrAsyncTaskTerminalFreshness;
  expiredByWatchdog: boolean;
  controller: AbortController;
  /**
   * Declared by the fleet form and launched on a deferred tick. Stays `true`
   * through `ready`→`running`→terminal so both surfaces always reveal the row
   * (it was committed to the card before launch) and animate it in place.
   */
  deferredLaunch?: boolean;
  /**
   * Run thunk held while `status === "ready"` (manual launch). Consumed once by
   * {@link MmrAsyncTaskRegistry.launchTask}, then cleared. Absent for an
   * immediate start, which invokes its run thunk at creation.
   */
  pendingRun?: MmrAsyncTaskRun;
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
  waiters: Set<() => void>;
  promise?: Promise<void>;
}

export interface MmrAsyncTaskGroupRecord {
  groupId: string;
  sessionKey: string;
  label?: string;
  createdAtMs: number;
  updatedAtMs: number;
  completedAtMs?: number;
  finalObservedAtMs?: number;
  terminalAnnouncedAtMs?: number;
  deliveryOptIn: boolean;
  pushOutcome?: MmrAsyncTaskPushOutcome;
  notify?: MmrAsyncTaskGroupNotifier;
  onSettle?: MmrAsyncTaskGroupSettleCallback;
  waiters: Set<() => void>;
  taskIds: Set<string>;
}
