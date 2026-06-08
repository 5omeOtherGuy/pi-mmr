import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { MmrWorkerTrailItem } from "./worker-trail.js";
import {
  buildTaskFinalResult,
  buildTaskProgressResult,
  type TaskDetailsContext,
} from "./task.js";
import {
  isValidAsyncTaskGroupId,
  type MmrAsyncTaskBoard,
  type MmrAsyncTaskGroupSnapshot,
  type MmrAsyncTaskInternalSnapshot,
  type MmrAsyncTaskStatus,
  type MmrAsyncTerminalDeliveryClaim,
  type MmrAsyncTerminalDeliveryItem,
} from "./async-task-registry.js";
import {
  PULL_NOTICE_LABEL_LIMIT,
  START_TASK_TOOL_NAME,
  type AsyncTaskAgentName,
  type AsyncTaskToolDetails,
} from "./async-task-tool-schemas.js";

export function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function compactOneLine(value: string, limit = 220): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= limit) return compact;
  return `${compact.slice(0, Math.max(0, limit - 1))}…`;
}

function withPeriod(value: string): string {
  return /[.!?…]$/.test(value) ? value : `${value}.`;
}

export function detailsContextFromSnapshot(snapshot: MmrAsyncTaskInternalSnapshot): TaskDetailsContext {
  return {
    prompt: snapshot.prompt,
    description: snapshot.description,
    cwd: snapshot.cwd,
    workerTools: snapshot.workerTools,
    ...(snapshot.resolvedModel !== undefined ? { resolvedModel: snapshot.resolvedModel } : {}),
    ...(snapshot.contextWindow !== undefined ? { contextWindow: snapshot.contextWindow } : {}),
  };
}

function isTerminal(status: MmrAsyncTaskStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

/** Read the first text part from a tool-result content array. */
function firstText(content: AgentToolResult<unknown>["content"]): string | undefined {
  for (const part of content) {
    if (part.type === "text" && typeof part.text === "string") return part.text;
  }
  return undefined;
}

function workerResultReason(result: MmrAsyncTaskInternalSnapshot["finalResult"]): string | undefined {
  if (!result) return undefined;
  if (result.spawnError) return `spawn failed: ${result.spawnError}`;
  if (result.subagentActivationError) return `subagent activation failed: ${result.subagentActivationError}`;
  if (result.errorMessage) return result.errorMessage;
  if (result.aborted) return "worker was cancelled before producing a result";
  if (result.signal) return `worker exited after signal ${result.signal}`;
  if (typeof result.exitCode === "number" && result.exitCode !== 0) return `worker exited with code ${result.exitCode}`;
  return undefined;
}

export function nonNormalOutcomeText(snapshot: MmrAsyncTaskInternalSnapshot): string | undefined {
  if (snapshot.status === "succeeded") return undefined;
  if (snapshot.status !== "failed" && snapshot.status !== "cancelled") return undefined;
  const toolText = snapshot.finalToolResult ? firstText(snapshot.finalToolResult.content) : undefined;
  const cancellationReason = snapshot.status === "cancelled" ? snapshot.cancelReason : undefined;
  const reason = snapshot.errorMessage
    ?? cancellationReason
    ?? workerResultReason(snapshot.finalResult)
    ?? toolText
    ?? (snapshot.status === "failed" ? "worker did not complete successfully" : "worker was cancelled before producing a result");
  return `${snapshot.status} — ${withPeriod(compactOneLine(reason))}`;
}

export function createAsyncTaskDeliveryMessage(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function formatCounts(counts: MmrAsyncTerminalDeliveryItem["counts"]): string {
  if (!counts) return "0 task(s): 0 succeeded, 0 failed, 0 cancelled, 0 partial";
  return `${counts.total} task(s): ${counts.succeeded} succeeded, ${counts.failed} failed, ${counts.cancelled} cancelled, ${counts.partial} partial`;
}

function formatAsyncTaskDeliveryItem(item: MmrAsyncTerminalDeliveryItem): string {
  if (item.kind === "group") {
    return `- group ${item.id} — ${item.status} (${formatCounts(item.counts)}). Use task_poll({group_id:"${item.id}"}) once to list child task_ids, then task_poll({task_id}) once per child output you still need.`;
  }
  const label = compactOneLine(item.description, PULL_NOTICE_LABEL_LIMIT);
  const outcome = item.terminalOutcome === "partial" ? " partial" : "";
  const error = item.errorMessage ? ` ${escapeXmlAttr(compactOneLine(item.errorMessage, PULL_NOTICE_LABEL_LIMIT))}` : "";
  return `- task ${item.id} "${escapeXmlAttr(label)}" — ${item.status}${outcome}.${error} Use task_poll({task_id:"${item.id}"}) once if you need the final result.`;
}

function formatAsyncTaskDeliveryNotice(claim: MmrAsyncTerminalDeliveryClaim): string {
  const count = claim.items.length;
  const lines = [
    `<background-tasks-finished count="${count}">`,
    `${count} background task(s)/group(s) finished since your last model step. Retrieve only results that are not already present in this transcript.`,
    ...claim.items.map(formatAsyncTaskDeliveryItem),
    "If task_poll/task_wait already returned a terminal result for one of these ids, it is consumed; do not re-poll or rewrite solely because of this notice.",
  ];
  if (claim.hasMore) {
    lines.push("More finished background work may be pending; continue useful work or call task_poll with no arguments to inspect the board.");
  }
  lines.push("</background-tasks-finished>");
  return lines.join("\n");
}

export function formatAsyncTaskDeliveryNoticeSafely(claim: MmrAsyncTerminalDeliveryClaim): string {
  try {
    return formatAsyncTaskDeliveryNotice(claim);
  } catch {
    const ids = claim.items.map((item) => `${item.kind} ${item.id}`).join(", ");
    return [
      `<background-tasks-finished count="${claim.items.length}">`,
      `Background worker completion notice formatting failed, but these ids were marked announced: ${ids}. Use task_poll once for any id whose result is not already present.`,
      "</background-tasks-finished>",
    ].join("\n");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeAgent(raw: unknown): AsyncTaskAgentName | undefined {
  if (raw === undefined) return "Task";
  if (typeof raw !== "string") return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "task" || normalized === "task-subagent") return "Task";
  if (normalized === "finder") return "finder";
  if (normalized === "librarian") return "librarian";
  return undefined;
}

function firstParamString(params: unknown, key: string): string | undefined {
  if (!isRecord(params)) return undefined;
  const value = params[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function summarizeInput(agent: AsyncTaskAgentName, params: unknown): string {
  const value = agent === "Task"
    ? firstParamString(params, "prompt")
    : firstParamString(params, "query");
  if (value) return value;
  try {
    return JSON.stringify(params);
  } catch {
    return String(params);
  }
}

function shortDescription(agent: AsyncTaskAgentName, params: unknown, explicit: unknown): string {
  if (typeof explicit === "string" && explicit.trim().length > 0) return explicit.trim();
  const summary = summarizeInput(agent, params).replace(/\s+/g, " ").trim();
  const clipped = summary.length > 80 ? `${summary.slice(0, 77)}…` : summary;
  return `${agent}: ${clipped || "background run"}`;
}

export function inferToolRunStatus(result: AgentToolResult<unknown>, signal: AbortSignal): MmrAsyncTaskStatus {
  const details = isRecord(result.details) ? result.details : {};
  const status = details.status;
  if (signal.aborted || status === "aborted" || details.aborted === true) return "cancelled";
  if (status === "success") return "succeeded";
  if (typeof status === "string") {
    if (
      status === "no-agent-start"
      || status === "empty-output"
      || status.includes("error")
      || status.includes("gated")
      || status.includes("exhausted")
    ) return "failed";
  }
  if (typeof details.exitCode === "number" && details.exitCode !== 0) return "failed";
  if (typeof details.spawnError === "string" || typeof details.subagentActivationError === "string") return "failed";
  return "succeeded";
}

export function inferToolErrorMessage(result: AgentToolResult<unknown>): string | undefined {
  const details = isRecord(result.details) ? result.details : {};
  return typeof details.errorMessage === "string" && details.errorMessage.length > 0
    ? details.errorMessage
    : undefined;
}

export function extractTrailFromToolResult(result: AgentToolResult<unknown> | undefined): readonly MmrWorkerTrailItem[] | undefined {
  const details = isRecord(result?.details) ? result.details : undefined;
  const trail = details?.trail;
  return Array.isArray(trail) ? trail as MmrWorkerTrailItem[] : undefined;
}

function freshnessNote(snapshot: MmrAsyncTaskInternalSnapshot): string {
  if (snapshot.freshness === "stalled") {
    return " (no recent progress — the worker may be on a long step; it has not been stopped)";
  }
  if (snapshot.freshness === "dead") {
    return " (no longer responding; it will be finalized as failed)";
  }
  return "";
}

export function summarizeTrail(trail: readonly MmrWorkerTrailItem[] | undefined): string {
  if (!trail || trail.length === 0) return "No tool activity was recorded.";
  const tools = trail.filter((t): t is Extract<MmrWorkerTrailItem, { type: "tool" }> => t.type === "tool");
  const completed = tools.filter((t) => t.status === "completed").length;
  const failed = tools.filter((t) => t.status === "failed").length;
  const running = tools.filter((t) => t.status === "running");
  const parts: string[] = [];
  if (completed > 0) parts.push(`${completed} tool call(s) completed`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (running.length > 0) parts.push(`${running.length} in progress (${running.map((t) => t.toolName).join(", ")})`);
  return parts.length > 0 ? `Work observed: ${parts.join("; ")}.` : "No tool work was completed.";
}

/** Project a non-terminal snapshot into a progress-style tool result. */
function projectRunning(
  tool: AsyncTaskToolDetails["tool"],
  snapshot: MmrAsyncTaskInternalSnapshot,
  opts: { timedOut?: boolean } = {},
): AgentToolResult<AsyncTaskToolDetails> {
  const progressText = snapshot.latestToolResult
    ? firstText(snapshot.latestToolResult.content)
    : snapshot.latestProgress
      ? firstText(buildTaskProgressResult(snapshot.latestProgress, detailsContextFromSnapshot(snapshot)).content)
      : undefined;
  // Carry the latest projected subagent details so the renderer can show the
  // worker model and any partial trail while the task is still running.
  const progressDetails = snapshot.latestToolResult
    ? snapshot.latestToolResult.details
    : snapshot.latestProgress
      ? buildTaskProgressResult(snapshot.latestProgress, detailsContextFromSnapshot(snapshot)).details
      : undefined;
  const groupText = snapshot.groupId ? ` (group ${snapshot.groupId})` : "";
  const header = `${tool}: ${snapshot.agent} task ${snapshot.taskId}${groupText} is ${snapshot.status}${freshnessNote(snapshot)}.`;
  const waitHint = opts.timedOut ? " Wait timed out; the worker is still running. No final result was consumed, and the timeout did not cancel the worker." : "";
  const body = progressText && progressText.trim().length > 0 ? `\n\n${progressText}` : "";
  return {
    content: [{ type: "text", text: `${header}${waitHint}${body}` }],
    details: {
      worker: "mmr-subagents.async-task",
      tool,
      agent: snapshot.agent as AsyncTaskAgentName,
      taskId: snapshot.taskId,
      ...(snapshot.groupId !== undefined ? { groupId: snapshot.groupId } : {}),
      status: snapshot.status,
      ...(snapshot.terminalOutcome !== undefined ? { terminalOutcome: snapshot.terminalOutcome } : {}),
      freshness: snapshot.freshness,
      description: snapshot.description,
      prompt: snapshot.prompt,
      ...(snapshot.resolvedModel !== undefined ? { resolvedModel: snapshot.resolvedModel } : {}),
      ...(snapshot.contextWindow !== undefined ? { contextWindow: snapshot.contextWindow } : {}),
      ...(progressDetails !== undefined ? { final: progressDetails } : {}),
      ...(opts.timedOut !== undefined ? { timedOut: opts.timedOut } : {}),
    },
  };
}

/** Project a terminal snapshot into a final tool result (reuses Task shaping). */
function projectTerminal(
  tool: AsyncTaskToolDetails["tool"],
  snapshot: MmrAsyncTaskInternalSnapshot,
): AgentToolResult<AsyncTaskToolDetails> {
  const outcomeText = snapshot.terminalOutcome === "partial" ? " (partial result)" : "";
  const groupText = snapshot.groupId ? ` (group ${snapshot.groupId})` : "";
  const statusLine = `${tool}: ${snapshot.agent} task ${snapshot.taskId}${groupText} ${snapshot.status}${outcomeText}.`;
  let finalOutput = snapshot.errorMessage;
  let final: unknown;
  if (snapshot.finalToolResult) {
    final = snapshot.finalToolResult.details;
    const text = firstText(snapshot.finalToolResult.content);
    if (text && text.trim().length > 0) finalOutput = text.trim();
  } else if (snapshot.finalResult) {
    const projected = buildTaskFinalResult(snapshot.finalResult, detailsContextFromSnapshot(snapshot));
    final = projected.details;
    const text = firstText(projected.content);
    if (text && text.trim().length > 0) finalOutput = text.trim();
  }
  const consumedNote = `\n\nFinal result retrieved by this tool result. Do not call task_poll for ${snapshot.taskId} again unless you intentionally need to re-read the same result. If a later background-task notification mentions ${snapshot.taskId}, treat it as stale and take no action.`;
  const body = finalOutput ? `\n\n${finalOutput}${consumedNote}` : consumedNote;
  return {
    content: [{ type: "text", text: `${statusLine}${body}` }],
    details: {
      worker: "mmr-subagents.async-task",
      tool,
      agent: snapshot.agent as AsyncTaskAgentName,
      taskId: snapshot.taskId,
      ...(snapshot.groupId !== undefined ? { groupId: snapshot.groupId } : {}),
      status: snapshot.status,
      ...(snapshot.terminalOutcome !== undefined ? { terminalOutcome: snapshot.terminalOutcome } : {}),
      freshness: snapshot.freshness,
      description: snapshot.description,
      prompt: snapshot.prompt,
      ...(snapshot.resolvedModel !== undefined ? { resolvedModel: snapshot.resolvedModel } : {}),
      ...(snapshot.contextWindow !== undefined ? { contextWindow: snapshot.contextWindow } : {}),
      ...(finalOutput !== undefined ? { finalOutput } : {}),
      ...(final !== undefined ? { final } : {}),
      ...(snapshot.errorMessage !== undefined ? { errorMessage: snapshot.errorMessage } : {}),
    },
  };
}

export function notFoundResult(
  tool: AsyncTaskToolDetails["tool"],
  taskId: string,
): AgentToolResult<AsyncTaskToolDetails> {
  const message =
    `${tool}: no background task with id "${taskId}" in this session. ` +
    "It may have finished and been pruned, was cancelled long ago, or never existed.";
  return {
    content: [{ type: "text", text: message }],
    details: { worker: "mmr-subagents.async-task", tool, taskId, errorMessage: message },
  };
}

export function projectSnapshot(
  tool: AsyncTaskToolDetails["tool"],
  snapshot: MmrAsyncTaskInternalSnapshot,
  opts: { timedOut?: boolean } = {},
): AgentToolResult<AsyncTaskToolDetails> {
  return isTerminal(snapshot.status)
    ? projectTerminal(tool, snapshot)
    : projectRunning(tool, snapshot, opts);
}

export interface ParsedStartParams {
  agent: AsyncTaskAgentName;
  params: unknown;
  description: string;
  promptSummary: string;
  wantsNotify: boolean;
  capabilityProfile?: string;
  groupId?: string;
  groupLabel?: string;
}

export function parseStartParams(rawParams: unknown): ParsedStartParams | { error: string } {
  if (!isRecord(rawParams)) {
    return { error: "start_task expects an object." };
  }
  // Structural validation (unknown keys, types, capabilityProfile enum,
  // group_id pattern, notify boolean) is enforced by checkMmrToolParams in
  // execute(); this parser only performs agent-specific normalization and the
  // semantic rules the schema cannot express.
  const agent = normalizeAgent(rawParams.agent);
  if (!agent) {
    return { error: "start_task.agent must be one of: Task, finder, librarian. Oracle is always blocking and cannot run in the background." };
  }
  let params: unknown = rawParams.params;
  if (params === undefined) {
    if (agent === "Task") {
      params = { prompt: rawParams.prompt, description: rawParams.description };
    } else if (typeof rawParams.prompt === "string") {
      params = { query: rawParams.prompt };
    } else {
      return { error: `start_task.params is required when agent is ${agent}.` };
    }
  } else if (agent === "Task" && isRecord(params) && params.description === undefined && rawParams.description !== undefined) {
    params = { ...params, description: rawParams.description };
  }
  if (!isRecord(params)) {
    return { error: "start_task.params must be an object." };
  }
  // Schema already constrained capabilityProfile to the read-only|read-write
  // enum; only the Task-agent restriction is a semantic rule the schema cannot
  // express.
  const capabilityProfile = typeof rawParams.capabilityProfile === "string" ? rawParams.capabilityProfile : undefined;
  if (capabilityProfile !== undefined) {
    if (agent !== "Task") return { error: "start_task.capabilityProfile is only supported for the Task agent." };
    params = { ...params, capabilityProfile };
  }
  // Schema constrained group_id to 'new' | group_<hex>; normalize to a string.
  const groupId = typeof rawParams.group_id === "string" ? rawParams.group_id : undefined;
  // Schema constrained group_label to a string; honored only when opening a
  // group (group_id:'new'), mirroring how capabilityProfile is Task-only.
  const groupLabel = typeof rawParams.group_label === "string" ? rawParams.group_label : undefined;
  return {
    agent,
    params,
    description: shortDescription(agent, params, rawParams.description),
    promptSummary: summarizeInput(agent, params),
    // Schema guarantees notify is boolean when present; default is notify-on,
    // opt out only on an explicit false.
    wantsNotify: rawParams.notify !== false,
    ...(capabilityProfile !== undefined ? { capabilityProfile } : {}),
    ...(groupId !== undefined ? { groupId } : {}),
    ...(groupLabel !== undefined ? { groupLabel } : {}),
  };
}

export function validationResult(message: string): AgentToolResult<AsyncTaskToolDetails> {
  return {
    content: [{ type: "text", text: `start_task: invalid parameters: ${message}` }],
    details: { worker: "mmr-subagents.async-task", tool: START_TASK_TOOL_NAME, errorMessage: message },
  };
}

export function renderBoard(board: MmrAsyncTaskBoard): string {
  const lines: string[] = [
    `task_poll: ${board.counts.active} active, ${board.counts.stalled} stalled, ${board.counts.finished} finished.`,
  ];
  const section = (title: string, entries: MmrAsyncTaskBoard["active"]) => {
    if (entries.length === 0) return;
    lines.push(`${title}:`);
    for (const e of entries) {
      const fresh = e.freshness !== "healthy" && e.freshness !== "terminal" ? ` [${e.freshness}]` : "";
      const delivery = isTerminal(e.status) ? `, delivery: ${e.completionPush}` : "";
      lines.push(`  - ${e.taskId} (${e.status}${fresh}, ${e.agent}${delivery}) "${e.description}"`);
    }
  };
  section("Active", board.active);
  section("Stalled", board.stalled);
  section("Finished", board.finished);
  if (board.counts.active + board.counts.stalled + board.counts.finished === 0) {
    lines.push("No background tasks in this session.");
  }
  return lines.join("\n");
}

function renderGroup(tool: AsyncTaskToolDetails["tool"], group: MmrAsyncTaskGroupSnapshot, timedOut?: boolean): string {
  const wait = timedOut ? " Wait timed out; the group is still running. No final result was consumed, and the timeout did not cancel children." : "";
  const head = `${tool}: group ${group.groupId} ${group.status} (${group.counts.total} task(s): ${group.counts.succeeded} succeeded, ${group.counts.failed} failed, ${group.counts.cancelled} cancelled, ${group.counts.partial} partial).${wait}`;
  if (group.taskIds.length === 0) return head;
  const ids = group.taskIds.join(", ");
  const retrieve = group.status === "running"
    ? ` Child task_ids: ${ids}.`
    : ` Group status observed. This does not include child final outputs. Retrieve each needed child once with task_poll({task_id}): ${ids}. If a later group notification appears, treat it as stale.`;
  return `${head}${retrieve}`;
}

export function groupResult(
  tool: AsyncTaskToolDetails["tool"],
  group: MmrAsyncTaskGroupSnapshot,
  timedOut?: boolean,
  sessionKey?: string,
): AgentToolResult<AsyncTaskToolDetails> {
  return {
    content: [{ type: "text", text: renderGroup(tool, group, timedOut) }],
    details: {
      worker: "mmr-subagents.async-task",
      tool,
      groupId: group.groupId,
      group,
      // Renderer-only: lets the consolidated group card read live member rows.
      // Not consumed by the model (which reads `content`).
      ...(sessionKey !== undefined ? { sessionKey } : {}),
      ...(timedOut !== undefined ? { timedOut } : {}),
    },
  };
}

export function invalidAsyncControlResult(
  tool: AsyncTaskToolDetails["tool"],
  message: string,
): AgentToolResult<AsyncTaskToolDetails> {
  return {
    content: [{ type: "text", text: `${tool}: invalid parameters: ${message}` }],
    details: { worker: "mmr-subagents.async-task", tool, errorMessage: message },
  };
}

export function groupNotFoundResult(
  tool: AsyncTaskToolDetails["tool"],
  groupId: string,
): AgentToolResult<AsyncTaskToolDetails> {
  const message = `${tool}: no background task group with id "${groupId}" in this session.`;
  return {
    content: [{ type: "text", text: message }],
    details: { worker: "mmr-subagents.async-task", tool, groupId, errorMessage: message },
  };
}

export function parseTaskOrGroupControl(
  rawParams: unknown,
): { taskId?: string; groupId?: string; error?: string } {
  const params = isRecord(rawParams) ? rawParams : {};
  const taskId = typeof params.task_id === "string" && params.task_id.length > 0 ? params.task_id : undefined;
  const groupId = typeof params.group_id === "string" && params.group_id.length > 0 ? params.group_id : undefined;
  if (taskId && groupId) return { error: "task_id and group_id are mutually exclusive." };
  if (groupId && !isValidAsyncTaskGroupId(groupId)) return { error: "group_id must be shaped like group_<hex>." };
  return { ...(taskId !== undefined ? { taskId } : {}), ...(groupId !== undefined ? { groupId } : {}) };
}
