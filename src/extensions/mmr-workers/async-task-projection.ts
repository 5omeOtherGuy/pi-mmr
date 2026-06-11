import {
  isTerminalStatus,
  latestToolFromProgress,
  normalizeGroupLabel,
  type MmrAsyncTaskGroupRecord,
  type MmrAsyncTaskRecord,
} from "./async-task-internal.js";
import { projectCompletionPush } from "./async-task-delivery.js";
import type {
  MmrAsyncTaskBoardEntry,
  MmrAsyncTaskFreshness,
  MmrAsyncTaskGroupSnapshot,
  MmrAsyncTaskGroupStatus,
  MmrAsyncTaskInternalSnapshot,
  MmrAsyncTaskSnapshot,
  MmrAsyncTerminalDeliveryItem,
} from "./async-task-registry.js";

/**
 * Pure, read-only projection of registry records to snapshots/board/group/
 * delivery DTOs. Given a record (and any caller-resolved children) plus the
 * current clock and freshness config, these functions never touch registry
 * state. The class keeps thin method wrappers that call these with
 * `this.nowMs()`, `this.groupChildren(...)`, and the configured TTL/grace
 * values, so the public interface is unchanged.
 *
 * This module is a leaf at runtime: it imports values only from
 * `./async-task-internal.js` and `./async-task-delivery.js`. The `import type`
 * references back to `./async-task-registry.js` are erased and create no
 * runtime cycle.
 */

/** Freshness thresholds resolved from registry deps. */
export interface FreshnessConfig {
  stalledAfterMs: number;
  cancelDeadAfterMs: number;
}

export function freshnessOf(
  record: MmrAsyncTaskRecord,
  now: number,
  cfg: FreshnessConfig,
): MmrAsyncTaskFreshness {
  if (isTerminalStatus(record.status)) return "terminal";
  // A declared-but-not-launched task has no worker yet: it is never stalled or
  // dead by wall time until launchTask starts its clock.
  if (record.status === "ready") return "healthy";
  if (
    record.cancelRequestedAtMs !== undefined &&
    now - record.cancelRequestedAtMs > cfg.cancelDeadAfterMs
  ) {
    return "dead";
  }
  if (now > record.maxRuntimeAtMs + cfg.cancelDeadAfterMs) return "dead";
  const observedAt = record.lastProgressAtMs ?? record.startedAtMs ?? record.createdAtMs;
  if (now - observedAt > cfg.stalledAfterMs) return "stalled";
  return "healthy";
}

export function snapshotOf(
  record: MmrAsyncTaskRecord,
  now: number,
  cfg: FreshnessConfig,
): MmrAsyncTaskInternalSnapshot {
  const lastProgressAt = record.lastProgressAtMs;
  return {
    taskId: record.taskId,
    status: record.status,
    freshness: freshnessOf(record, now, cfg),
    ...(record.terminalFreshness !== undefined ? { terminalFreshness: record.terminalFreshness } : {}),
    runMode: record.runMode,
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
    runtimeMs: record.status === "ready" ? 0 : (record.completedAtMs ?? now) - record.startedAtMs,
    ...(lastProgressAt !== undefined ? { lastProgressAgeMs: now - lastProgressAt } : {}),
    completionPush: projectCompletionPush(record),
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

export function boardEntryOf(
  record: MmrAsyncTaskRecord,
  now: number,
  cfg: FreshnessConfig,
): MmrAsyncTaskBoardEntry {
  const lastProgressAt = record.lastProgressAtMs;
  const progress = record.latestProgress;
  const latestTool = latestToolFromProgress(progress);
  const toolCount = progress?.trail.filter((item) => item.type === "tool").length;
  return {
    taskId: record.taskId,
    status: record.status,
    freshness: freshnessOf(record, now, cfg),
    ...(record.terminalFreshness !== undefined ? { terminalFreshness: record.terminalFreshness } : {}),
    runMode: record.runMode,
    agent: record.agent,
    description: record.description,
    createdAtMs: record.createdAtMs,
    startedAtMs: record.startedAtMs,
    updatedAtMs: record.updatedAtMs,
    ...(record.completedAtMs !== undefined ? { completedAtMs: record.completedAtMs } : {}),
    runtimeMs: record.status === "ready" ? 0 : (record.completedAtMs ?? now) - record.startedAtMs,
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
    ...(record.deferredLaunch ? { deferredLaunch: true } : {}),
    completionPush: projectCompletionPush(record),
    ...(record.errorMessage !== undefined ? { errorMessage: record.errorMessage } : {}),
  };
}

export function groupStatusOf(
  children: readonly MmrAsyncTaskRecord[],
): MmrAsyncTaskGroupStatus {
  // A fleet declared but not yet launched: every child is still `ready`.
  if (children.length > 0 && children.every((child) => child.status === "ready")) return "ready";
  if (children.length === 0 || children.some((child) => !isTerminalStatus(child.status))) return "running";
  if (children.some((child) => child.status === "failed" || child.terminalFreshness === "dead")) return "failed";
  if (children.some((child) => child.status === "cancelled")) return "cancelled";
  if (children.some((child) => child.terminalOutcome === "partial")) return "partial";
  return "completed";
}

/**
 * Resolve the single-source-of-truth group label: the explicit label set at
 * open time, else the description of the earliest-created child (so the widget
 * header and the future settlement card stay consistent).
 */
export function resolveGroupLabelOf(
  group: MmrAsyncTaskGroupRecord,
  children: readonly MmrAsyncTaskRecord[],
): string | undefined {
  if (group.label !== undefined) return group.label;
  let earliest: MmrAsyncTaskRecord | undefined;
  for (const child of children) {
    if (!earliest || child.createdAtMs < earliest.createdAtMs) earliest = child;
  }
  return normalizeGroupLabel(earliest?.description);
}

export function groupSnapshotOf(
  group: MmrAsyncTaskGroupRecord,
  children: readonly MmrAsyncTaskRecord[],
  now: number,
): MmrAsyncTaskGroupSnapshot {
  const status = groupStatusOf(children);
  const label = resolveGroupLabelOf(group, children);
  return {
    groupId: group.groupId,
    status,
    ...(label !== undefined ? { label } : {}),
    generatedAtMs: now,
    createdAtMs: group.createdAtMs,
    updatedAtMs: group.updatedAtMs,
    ...(group.completedAtMs !== undefined ? { completedAtMs: group.completedAtMs } : {}),
    completionPush: projectCompletionPush(group),
    taskIds: children.map((child) => child.taskId),
    counts: {
      running: children.filter((child) => !isTerminalStatus(child.status)).length,
      succeeded: children.filter((child) => child.status === "succeeded" && child.terminalOutcome !== "partial").length,
      failed: children.filter((child) => child.status === "failed").length,
      cancelled: children.filter((child) => child.status === "cancelled").length,
      partial: children.filter((child) => child.terminalOutcome === "partial").length,
      total: children.length,
    },
  };
}

export function terminalDeliveryItemForTaskOf(
  record: MmrAsyncTaskRecord,
): MmrAsyncTerminalDeliveryItem {
  return {
    kind: "task",
    id: record.taskId,
    status: record.status,
    description: record.description,
    ...(record.completedAtMs !== undefined ? { completedAtMs: record.completedAtMs } : {}),
    ...(record.terminalOutcome !== undefined ? { terminalOutcome: record.terminalOutcome } : {}),
    ...(record.errorMessage !== undefined ? { errorMessage: record.errorMessage } : {}),
  };
}

export function terminalDeliveryItemForGroupOf(
  group: MmrAsyncTaskGroupRecord,
  groupSnapshot: MmrAsyncTaskGroupSnapshot,
): MmrAsyncTerminalDeliveryItem {
  return {
    kind: "group",
    id: group.groupId,
    status: groupSnapshot.status,
    description: `group ${group.groupId}`,
    ...(group.completedAtMs !== undefined ? { completedAtMs: group.completedAtMs } : {}),
    childTaskIds: groupSnapshot.taskIds,
    counts: groupSnapshot.counts,
  };
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
    runMode: snapshot.runMode,
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
