import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TSchema } from "typebox";
import { checkMmrToolParams, MmrToolParamsError } from "../mmr-core/tool-params.js";
import { registerMmrOwnedTool } from "../mmr-core/owned-tools.js";
import { getMmrSessionIdentitySnapshot } from "../mmr-core/runtime.js";
import type { MmrWorkerTrailItem } from "./worker-trail.js";
import {
  buildSpawnErrorWorkerResult,
  buildTaskFinalResult,
  buildTaskProgressResult,
  prepareTaskRun,
  type TaskDetailsContext,
  type TaskToolDeps,
} from "./task.js";
import {
  createFinderTool,
  FINDER_PARAMETERS_SCHEMA,
  FINDER_TOOL_NAME,
  FINDER_WORKER_TOOLS,
  type FinderToolDeps,
} from "./finder.js";
import {
  createLibrarianTool,
  LIBRARIAN_PARAMETERS_SCHEMA,
  LIBRARIAN_TOOL_NAME,
  LIBRARIAN_WORKER_TOOLS,
  type LibrarianToolDeps,
} from "./librarian.js";
import {
  ASYNC_TASK_COMPLETION_CUSTOM_TYPE,
  type AsyncTaskCompletionDetails,
  renderAsyncTaskCompletionMessage,
  renderMmrBackgroundTaskCall,
  renderMmrBackgroundTaskResult,
} from "./progress-rendering.js";
import {
  getMmrAsyncTaskRegistry,
  MAX_TASK_WAIT_TIMEOUT_MS,
  isValidAsyncTaskGroupId,
  type MmrAsyncTaskBoard,
  type MmrAsyncTaskGroupSnapshot,
  type MmrAsyncTaskRegistry,
  type MmrAsyncTaskInternalSnapshot,
  type MmrAsyncTaskStatus,
} from "./async-task-registry.js";
import { refreshBackgroundTaskWidget } from "./background-task-widget.js";

export const START_TASK_TOOL_NAME = "start_task";
export const TASK_POLL_TOOL_NAME = "task_poll";
export const TASK_WAIT_TOOL_NAME = "task_wait";
export const TASK_CANCEL_TOOL_NAME = "task_cancel";

export const ASYNC_TASK_TOOL_NAMES = [
  START_TASK_TOOL_NAME,
  TASK_POLL_TOOL_NAME,
  TASK_WAIT_TOOL_NAME,
  TASK_CANCEL_TOOL_NAME,
] as const;

// Oracle is intentionally excluded: it is always blocking and can never run
// as a background agent. The blocking `oracle` tool is unchanged.
export const ASYNC_TASK_AGENT_NAMES = ["Task", "finder", "librarian"] as const;
export type AsyncTaskAgentName = typeof ASYNC_TASK_AGENT_NAMES[number];

/**
 * Run the shared TypeBox validator and return a structured outcome instead of
 * throwing, so each async tool can surface its own deterministic validation
 * result. The shared helper's `"<tool>: invalid parameters: <msg>"` prefix is
 * stripped here because the per-tool result wrappers re-add it.
 */
function validateAsyncToolParams<T extends TSchema>(
  tool: string,
  schema: T,
  raw: unknown,
): { ok: true; value: Static<T> } | { ok: false; message: string } {
  try {
    return { ok: true, value: checkMmrToolParams(tool, schema, raw) };
  } catch (err) {
    if (err instanceof MmrToolParamsError) {
      const prefix = `${tool}: invalid parameters: `;
      const message = err.message.startsWith(prefix) ? err.message.slice(prefix.length) : err.message;
      return { ok: false, message };
    }
    throw err;
  }
}

/** Discriminated details for the async task tools' results. */
export interface AsyncTaskToolDetails {
  worker: "mmr-subagents.async-task";
  tool: (typeof ASYNC_TASK_TOOL_NAMES)[number];
  agent?: AsyncTaskAgentName;
  taskId?: string;
  groupId?: string;
  status?: MmrAsyncTaskStatus;
  terminalOutcome?: MmrAsyncTaskInternalSnapshot["terminalOutcome"];
  freshness?: MmrAsyncTaskInternalSnapshot["freshness"];
  /** Provider-stripped by the renderer; used for the subagent-style header. */
  resolvedModel?: string;
  contextWindow?: number;
  /** User-facing invocation label for the background-task renderer. */
  description?: string;
  /** Full worker prompt/query, rendered as the background card's Markdown body. */
  prompt?: string;
  /** Clean terminal worker output for the background-task renderer. */
  finalOutput?: string;
  timedOut?: boolean;
  /** Final projected subagent details when a polled/awaited task is terminal. */
  final?: unknown;
  /** Board snapshot for `task_poll` list mode. */
  board?: MmrAsyncTaskBoard;
  group?: MmrAsyncTaskGroupSnapshot;
  errorMessage?: string;
}

export interface AsyncTaskToolDeps extends TaskToolDeps {
  /** Registry seam; defaults to the process singleton. */
  registry?: MmrAsyncTaskRegistry;
  /** Deterministic session key override for tests. */
  sessionKey?: string;
  /** Tool-specific seams used when start_task launches the finder agent. */
  finderDeps?: FinderToolDeps;
  /** Tool-specific seams used when start_task launches the librarian agent. */
  librarianDeps?: LibrarianToolDeps;
  /** Tool-specific seams used when start_task launches the Task agent. */
  taskDeps?: TaskToolDeps;
  /**
   * Session-level ceiling: whether the at-most-once completion push is
   * PERMITTED at all this session. Default ON. A caller can opt an
   * individual task out with `start_task({ notify: false })`. Wired from
   * the `MMR_SUBAGENTS_ASYNC_PUSH` environment gate in `index.ts`.
   */
  enableCompletionPush?: boolean;
}

/**
 * Environment gate (the user ceiling) for async completion push. On by
 * default; set false/0/no to force pull-only background tasks for a session.
 */
export const MMR_SUBAGENTS_ASYNC_PUSH_ENV = "MMR_SUBAGENTS_ASYNC_PUSH";

const START_TASK_AGENT_SCHEMA = Type.Union([
  Type.Literal("Task"),
  Type.Literal("finder"),
  Type.Literal("librarian"),
], {
  description:
    "Background agent to launch. Defaults to Task. Use params for agent-specific inputs: Task {prompt,description}, finder {query}, librarian {query,context?}. Oracle cannot run in the background; it is always blocking.",
});

const TASK_CAPABILITY_PROFILE_SCHEMA = Type.Union(
  [Type.Literal("read-only"), Type.Literal("read-write")],
  {
    description:
      "Optional capability profile for Task workers. Unset preserves today's Task tool surface; read-only removes file-edit and shell tools; read-write keeps file edits but removes shell. Narrowing only.",
  },
);

const GROUP_ID_SCHEMA = Type.String({
  maxLength: 256,
  pattern: "^(new|group_[a-f0-9]{6,})$",
  description:
    "Optional worker-group id. Use group_id:'new' on the first start_task call to mint a group, then reuse the returned group_id on sibling start_task calls. Concrete ids must look like group_<hex>.",
});

const START_TASK_PARAMETERS = Type.Object(
  {
    agent: Type.Optional(START_TASK_AGENT_SCHEMA),
    params: Type.Optional(
      Type.Object(
        {},
        {
          additionalProperties: true,
          description:
            "Parameters for the selected background agent. For Task use {prompt, description}; for finder use {query}; for librarian use {query, context?}.",
        },
      ),
    ),
    prompt: Type.Optional(Type.String({
      description:
        "Legacy Task prompt shortcut. Equivalent to params.prompt when agent is omitted or Task.",
    })),
    description: Type.Optional(Type.String({ description: "Short display label for the background task." })),
    capabilityProfile: Type.Optional(TASK_CAPABILITY_PROFILE_SCHEMA),
    group_id: Type.Optional(GROUP_ID_SCHEMA),
    notify: Type.Optional(
      Type.Boolean({
        description:
          "Completion notification. ON by default: when this task finishes the parent is poked once so it can consume the result. Pass false to opt out and make task_poll/task_wait the only retrieval path. The poke wakes an idle session or queues behind the active turn; it never interrupts streaming, and it is bounded per session.",
      }),
    ),
  },
  { additionalProperties: false },
);

const TASK_POLL_PARAMETERS = Type.Object(
  {
    task_id: Type.Optional(
      Type.String({
        maxLength: 256,
        description:
          "Opaque id returned by start_task. Omit task_id and group_id to list all background tasks for the current session.",
      }),
    ),
    group_id: Type.Optional(Type.String({ maxLength: 256, pattern: "^group_[a-f0-9]{6,}$", description: "Opaque group id returned by start_task when group_id:'new' opened a worker group." })),
  },
  { additionalProperties: false },
);

const TASK_WAIT_PARAMETERS = Type.Object(
  {
    task_id: Type.Optional(Type.String({ description: "Opaque id returned by start_task.", maxLength: 256 })),
    group_id: Type.Optional(Type.String({ maxLength: 256, pattern: "^group_[a-f0-9]{6,}$", description: "Opaque worker group id. Mutually exclusive with task_id; waits for all current children." })),
    timeout_ms: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: MAX_TASK_WAIT_TIMEOUT_MS,
        description: `Bounded wait in milliseconds (capped at ${MAX_TASK_WAIT_TIMEOUT_MS}). A timeout does NOT cancel the worker.`,
      }),
    ),
  },
  { additionalProperties: false },
);

const TASK_CANCEL_PARAMETERS = Type.Object(
  {
    task_id: Type.Optional(Type.String({ description: "Opaque id returned by start_task.", maxLength: 256 })),
    group_id: Type.Optional(Type.String({ maxLength: 256, pattern: "^group_[a-f0-9]{6,}$", description: "Opaque worker group id. Mutually exclusive with task_id; cancels all non-terminal children." })),
    reason: Type.Optional(Type.String({ description: "Short cancellation reason for diagnostics.", maxLength: 512 })),
  },
  { additionalProperties: false },
);

const START_TASK_DESCRIPTION = [
  "Start a bounded subagent worker in the background and return an opaque task_id immediately, so you can keep working while it runs.",
  "",
  "Use start_task only for independent work that can proceed while you do other things (long analysis, broad search, a self-contained implementation unit).",
  "Set agent to choose the background worker: Task (default), finder, or librarian. Use params for the selected tool's normal input shape. Oracle cannot run in the background; it is always blocking.",
  "Prefer the blocking Task/finder/librarian tools when you need the result before your next reasoning step.",
  "Default result path is the worker completion notification: when notify is enabled, wait for the follow-up before consuming the worker result.",
  "Use task_poll/task_wait only as an elapsed-time fallback when no notification arrives, or during fleet orchestration where multiple parallel workers need coordinated status checks.",
  "Use group_id:'new' on the first grouped start_task call to mint a worker group, then reuse the returned group_id on sibling start_task calls and task_poll/task_wait/task_cancel. The opening call controls the single grouped notification; sibling tasks in the group do not send individual completion notifications.",
  "For Task workers only, capabilityProfile can narrow tools to read-only or read-write (narrowing only; never widens the default Task surface).",
  "By default a background task notifies you once it finishes; pass notify:false to opt out and make task_poll/task_wait the only retrieval path.",
  "",
  "Background tasks are in-memory and session-scoped: they are lost if the Pi process exits, and they cannot spawn further background tasks.",
].join("\n");

const ASYNC_TASK_GUIDELINES: readonly string[] = [
  "Use start_task only for independent work that can run while you continue; prefer the blocking Task/finder/librarian tools when you need the result immediately. Oracle is always blocking and cannot be a background agent.",
  "Treat the worker completion notification as the default way to receive results; do not immediately poll just to check whether a worker completed.",
  "Use task_poll or task_wait only after a meaningful elapsed-time fallback interval with no notification, or for fleet orchestration where multiple parallel background workers need coordinated status checks; a task_wait timeout is not a failure and does not stop the worker.",
  "Call task_poll with no task_id to list this session's background tasks (active, stalled, finished) during fallback checks or multi-worker orchestration.",
  "For grouped workers, open the group with start_task({ group_id: 'new', ... }), copy the returned group_id into each sibling start_task call, then wait/poll/cancel with group_id (mutually exclusive with task_id). When the group finishes, retrieve each child result with task_poll({ task_id }) for the ids the group result lists.",
  "Use task_cancel to stop a duplicate, obsolete, or wrongly-scoped background task or group.",
  "Do not start multiple code-writing background tasks unless their file targets are clearly disjoint.",
  "A background task notifies you once when it finishes (the poke wakes an idle session or queues behind the active turn, and is bounded per session); pass start_task({ notify: false }) to opt out and pull the result with task_poll/task_wait.",
];

/**
 * Best-effort: mirror the registry board onto the pinned background-agent
 * widget. Never throws into a tool call — a widget failure must not demote a
 * successful background-task operation.
 */
function refreshAsyncTaskWidget(
  ctx: ExtensionContext | undefined,
  registry: MmrAsyncTaskRegistry,
  sessionKey: string,
): void {
  try {
    refreshBackgroundTaskWidget(ctx, registry.listTasks(sessionKey));
  } catch {
    // UI mirror only; ignore.
  }
}

function resolveCwd(ctx: ExtensionContext | undefined): string {
  const candidate = (ctx as { cwd?: unknown } | undefined)?.cwd;
  if (typeof candidate === "string" && candidate.length > 0) return candidate;
  return process.cwd();
}

function resolveSessionKey(ctx: ExtensionContext | undefined, deps: AsyncTaskToolDeps): string {
  if (deps.sessionKey) return deps.sessionKey;
  // Prefer the session id from THIS call's context so concurrent sessions in
  // one process never share a partition; fall back to the global identity
  // snapshot, then to cwd.
  try {
    const ctxId = (ctx as { sessionManager?: { getSessionId?: () => unknown } } | undefined)
      ?.sessionManager?.getSessionId?.();
    if (typeof ctxId === "string" && ctxId.length > 0) return `sid:${ctxId}`;
  } catch {
    // best-effort
  }
  try {
    const id = getMmrSessionIdentitySnapshot()?.sessionId;
    if (id) return `sid:${id}`;
  } catch {
    // identity is best-effort; fall back to cwd partitioning
  }
  return `cwd:${resolveCwd(ctx)}`;
}

function escapeXmlAttr(value: string): string {
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

function detailsContextFromSnapshot(snapshot: MmrAsyncTaskInternalSnapshot): TaskDetailsContext {
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

function nonNormalOutcomeText(snapshot: MmrAsyncTaskInternalSnapshot): string | undefined {
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

function baseToolDeps(deps: AsyncTaskToolDeps): Record<string, unknown> {
  const {
    registry: _registry,
    sessionKey: _sessionKey,
    enableCompletionPush: _enableCompletionPush,
    finderDeps: _finderDeps,
    librarianDeps: _librarianDeps,
    taskDeps: _taskDeps,
    ...base
  } = deps;
  return base as Record<string, unknown>;
}

function inferToolRunStatus(result: AgentToolResult<unknown>, signal: AbortSignal): MmrAsyncTaskStatus {
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

function inferToolErrorMessage(result: AgentToolResult<unknown>): string | undefined {
  const details = isRecord(result.details) ? result.details : {};
  return typeof details.errorMessage === "string" && details.errorMessage.length > 0
    ? details.errorMessage
    : undefined;
}

function extractTrailFromToolResult(result: AgentToolResult<unknown> | undefined): readonly MmrWorkerTrailItem[] | undefined {
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

function summarizeTrail(trail: readonly MmrWorkerTrailItem[] | undefined): string {
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
  const waitHint = opts.timedOut ? " Wait timed out; the worker is still running. Poll or wait again." : "";
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
  const body = finalOutput ? `\n\n${finalOutput}` : "";
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

function notFoundResult(
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

function projectSnapshot(
  tool: AsyncTaskToolDetails["tool"],
  snapshot: MmrAsyncTaskInternalSnapshot,
  opts: { timedOut?: boolean } = {},
): AgentToolResult<AsyncTaskToolDetails> {
  return isTerminal(snapshot.status)
    ? projectTerminal(tool, snapshot)
    : projectRunning(tool, snapshot, opts);
}

function buildCompletionNotifier(
  pi: AsyncTaskToolDeps["pi"],
): ((snapshot: MmrAsyncTaskInternalSnapshot) => void) | undefined {
  const sendMessage = (pi as { sendMessage?: ExtensionAPI["sendMessage"] } | undefined)?.sendMessage;
  if (typeof sendMessage !== "function") return undefined;
  return (snapshot) => {
    const outcomeText = nonNormalOutcomeText(snapshot);
    sendMessage(
      {
        customType: ASYNC_TASK_COMPLETION_CUSTOM_TYPE,
        content:
          `<task-notification task_id="${escapeXmlAttr(snapshot.taskId)}" status="${snapshot.status}">\n` +
          `Background task "${escapeXmlAttr(snapshot.description)}" ${snapshot.status}.\n` +
          (outcomeText ? `Non-normal outcome: ${escapeXmlAttr(outcomeText)}\n` : "") +
          `The worker result is ready. Call task_poll({task_id:"${escapeXmlAttr(snapshot.taskId)}"}) now to retrieve it. ` +
          `Polling after completion is the intended retrieval step, not premature polling.\n` +
          `</task-notification>`,
        // The persistent background-agent widget and the eventual task_poll
        // result own the human-facing surface; this push is model-facing only
        // (display:false) so a finished task is not announced twice.
        display: false,
        details: {
          version: 1,
          kind: ASYNC_TASK_COMPLETION_CUSTOM_TYPE,
          taskId: snapshot.taskId,
          status: snapshot.status,
          description: snapshot.description,
          ...(outcomeText !== undefined ? { outcomeText } : {}),
        } satisfies AsyncTaskCompletionDetails,
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  };
}

function buildGroupCompletionNotifier(
  pi: AsyncTaskToolDeps["pi"],
): ((snapshot: MmrAsyncTaskGroupSnapshot) => void) | undefined {
  const sendMessage = (pi as { sendMessage?: ExtensionAPI["sendMessage"] } | undefined)?.sendMessage;
  if (typeof sendMessage !== "function") return undefined;
  return (snapshot) => {
    sendMessage(
      {
        customType: ASYNC_TASK_COMPLETION_CUSTOM_TYPE,
        content:
          `<task-group-notification group_id="${escapeXmlAttr(snapshot.groupId)}" status="${snapshot.status}">\n` +
          `Background task group ${escapeXmlAttr(snapshot.groupId)} ${snapshot.status}.\n` +
          `Call task_poll({group_id:"${escapeXmlAttr(snapshot.groupId)}"}) to list the child task_ids, then task_poll({task_id}) for each child to retrieve its result. A wait timeout never cancels children.\n` +
          `</task-group-notification>`,
        display: false,
        details: {
          version: 1,
          kind: ASYNC_TASK_COMPLETION_CUSTOM_TYPE,
          taskId: snapshot.groupId,
          status: snapshot.status,
          description: `group ${snapshot.groupId}`,
        } satisfies AsyncTaskCompletionDetails,
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  };
}

interface ParsedStartParams {
  agent: AsyncTaskAgentName;
  params: unknown;
  description: string;
  promptSummary: string;
  wantsNotify: boolean;
  capabilityProfile?: string;
  groupId?: string;
}

function parseStartParams(rawParams: unknown): ParsedStartParams | { error: string } {
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
  };
}

function validationResult(message: string): AgentToolResult<AsyncTaskToolDetails> {
  return {
    content: [{ type: "text", text: `start_task: invalid parameters: ${message}` }],
    details: { worker: "mmr-subagents.async-task", tool: START_TASK_TOOL_NAME, errorMessage: message },
  };
}

function createSelectedTool(agent: Exclude<AsyncTaskAgentName, "Task">, deps: AsyncTaskToolDeps): ToolDefinition {
  const base = baseToolDeps(deps);
  if (agent === "finder") return createFinderTool({ ...base, ...(deps.finderDeps ?? {}) } as FinderToolDeps);
  return createLibrarianTool({ ...base, ...(deps.librarianDeps ?? {}) } as LibrarianToolDeps);
}

function workerToolsForAgent(agent: AsyncTaskAgentName, taskTools: readonly string[] = []): readonly string[] {
  if (agent === "Task") return taskTools;
  if (agent === "finder") return FINDER_WORKER_TOOLS;
  return LIBRARIAN_WORKER_TOOLS;
}

export function createStartTaskTool(deps: AsyncTaskToolDeps = {}): ToolDefinition {
  const registry = deps.registry ?? getMmrAsyncTaskRegistry();
  return {
    name: START_TASK_TOOL_NAME,
    label: START_TASK_TOOL_NAME,
    description: START_TASK_DESCRIPTION,
    promptSnippet: "Start a bounded subagent worker in the background and return an opaque task_id",
    promptGuidelines: [...ASYNC_TASK_GUIDELINES],
    parameters: START_TASK_PARAMETERS,
    renderShell: "self" as const,
    renderCall(args, theme, context) {
      return renderMmrBackgroundTaskCall(START_TASK_TOOL_NAME, args, theme, context);
    },
    renderResult(result, options, theme, context) {
      return renderMmrBackgroundTaskResult(START_TASK_TOOL_NAME, result, options, theme, context);
    },
    async execute(toolCallId, rawParams, _signal, _onUpdate, ctx): Promise<AgentToolResult<AsyncTaskToolDetails>> {
      // Semantic checks first so agent/Task-only guidance the schema cannot
      // express wins (e.g. "Oracle is always blocking"); the shared schema then
      // enforces structure (unknown keys, notify boolean, capabilityProfile
      // enum, group_id pattern).
      const parsed = parseStartParams(rawParams);
      if ("error" in parsed) return validationResult(parsed.error);
      const validated = validateAsyncToolParams(START_TASK_TOOL_NAME, START_TASK_PARAMETERS, rawParams);
      if (!validated.ok) return validationResult(validated.message);
      const sessionKey = resolveSessionKey(ctx, deps);
      const onSettle = () => refreshAsyncTaskWidget(ctx, registry, sessionKey);
      // Validate the Task payload BEFORE any registry side effect (group open)
      // so an invalid Task start cannot mint an orphan group. Reuses the
      // blocking Task validation/model-resolution path; a pre-spawn failure
      // returns the same shaped result and creates no record and no group.
      const taskPrep = parsed.agent === "Task"
        ? prepareTaskRun(parsed.params, ctx, { ...baseToolDeps(deps), ...(deps.taskDeps ?? {}) } as TaskToolDeps)
        : undefined;
      if (taskPrep && !taskPrep.ok) {
        return {
          content: taskPrep.result.content,
          details: {
            worker: "mmr-subagents.async-task",
            tool: START_TASK_TOOL_NAME,
            agent: parsed.agent,
            errorMessage: taskPrep.result.details?.errorMessage,
          },
        };
      }
      // Pre-validate selected-agent (finder/librarian) params before any
      // registry side effect too, so an invalid background finder/librarian
      // start fails closed without creating a task or minting a group — the same
      // pre-spawn contract as Task. The run thunk still validates at execution
      // time as defense.
      if (parsed.agent === "finder") {
        const v = validateAsyncToolParams(FINDER_TOOL_NAME, FINDER_PARAMETERS_SCHEMA, parsed.params);
        if (!v.ok) return validationResult(v.message);
      } else if (parsed.agent === "librarian") {
        const v = validateAsyncToolParams(LIBRARIAN_TOOL_NAME, LIBRARIAN_PARAMETERS_SCHEMA, parsed.params);
        if (!v.ok) return validationResult(v.message);
      }
      // Two-layer gate: the session ceiling must permit push AND the caller
      // must not opt this task out. The registry adds at-most-once + a
      // per-session budget on top. Delivery is `followUp` + `triggerTurn`, so a
      // push wakes an idle session or queues immediately behind the active turn
      // instead of riding the next user prompt. The pinned widget is refreshed
      // by `onSettle` on terminal transition, so it stays correct even when the
      // task opts out of (or cannot send) a completion push.
      const notify = (deps.enableCompletionPush ?? true) && parsed.wantsNotify
        ? buildCompletionNotifier(deps.pi)
        : undefined;
      const groupNotify = (deps.enableCompletionPush ?? true) && parsed.wantsNotify
        ? buildGroupCompletionNotifier(deps.pi)
        : undefined;
      // Track whether we are about to create a brand-new group, so a later
      // start rejection (e.g. concurrency cap) can roll back only a group this
      // call minted — never a pre-existing one.
      const groupPreexisted = parsed.groupId !== undefined && parsed.groupId !== "new"
        ? registry.getGroup(sessionKey, parsed.groupId) !== undefined
        : false;
      const groupSnapshot = parsed.groupId === "new"
        ? registry.openGroup({ sessionKey, ...(groupNotify !== undefined ? { notify: groupNotify } : {}), onSettle })
        : parsed.groupId !== undefined
          ? registry.openGroup({ sessionKey, groupId: parsed.groupId, onSettle })
          : undefined;
      const groupId = groupSnapshot?.groupId;
      const taskNotify = groupId === undefined ? notify : undefined;

      const started = parsed.agent === "Task"
        ? (() => {
            // Invariant: taskPrep is the ok variant here — agent === "Task"
            // implies it was computed and any failure already returned above.
            if (!taskPrep || !taskPrep.ok) throw new Error("unreachable: Task prep validated before group open");
            const { params, cwd, detailsContext, runnerOptionsBase, runner } = taskPrep.prepared;
            return {
              started: registry.startTask({
                sessionKey,
                originToolCallId: toolCallId,
                agent: "Task",
                description: params.description,
                prompt: params.prompt,
                cwd,
                ...(detailsContext.resolvedModel !== undefined ? { resolvedModel: detailsContext.resolvedModel } : {}),
                ...(detailsContext.contextWindow !== undefined ? { contextWindow: detailsContext.contextWindow } : {}),
                workerTools: detailsContext.workerTools,
                ...(params.capabilityProfile !== undefined ? { capabilityProfile: params.capabilityProfile } : {}),
                ...(groupId !== undefined ? { groupId } : {}),
                // The run thunk never throws: a spawn failure is converted into a
                // synthetic spawn-error worker result so the background task
                // finalizes with the SAME `spawn-error` status/shaping as blocking
                // Task (rather than a generic registry error).
                run: async ({ signal, onProgress }) => {
                  try {
                    return await runner.run({ ...runnerOptionsBase, signal, onProgress });
                  } catch (err) {
                    return buildSpawnErrorWorkerResult(err, { prompt: params.prompt, cwd });
                  }
                },
                ...(taskNotify !== undefined ? { notify: taskNotify } : {}),
                onSettle,
              }),
            } as const;
          })()
        : (() => {
            const agent = parsed.agent;
            const tool = createSelectedTool(agent, deps);
            const cwd = resolveCwd(ctx);
            return {
              started: registry.startTask({
                sessionKey,
                originToolCallId: toolCallId,
                agent,
                description: parsed.description,
                prompt: parsed.promptSummary,
                cwd,
                workerTools: workerToolsForAgent(agent),
                ...(groupId !== undefined ? { groupId } : {}),
                run: async ({ signal, onProgress }) => {
                  const result = await tool.execute(
                    `${toolCallId}:${agent}`,
                    parsed.params,
                    signal,
                    (update) => onProgress(update),
                    ctx,
                  );
                  const status = inferToolRunStatus(result, signal);
                  return {
                    toolResult: result,
                    status,
                    terminalOutcome: status === "succeeded" ? "success" : status === "failed" ? "failed" : undefined,
                    ...(status === "failed" ? { errorMessage: inferToolErrorMessage(result) } : {}),
                  };
                },
                ...(taskNotify !== undefined ? { notify: taskNotify } : {}),
                onSettle,
              }),
            } as const;
          })();

      if (!started.started.ok) {
        // Roll back a group this call just minted so a cap rejection cannot
        // leave an empty orphan group; dropEmptyGroup is a no-op on a group
        // that already holds tasks or that pre-existed.
        if (groupId !== undefined && !groupPreexisted) registry.dropEmptyGroup(sessionKey, groupId);
        const message =
          `start_task: cannot start; ${started.started.runningCount} background task(s) already running ` +
          `(cap ${started.started.cap}). Wait for one to finish (task_wait) or stop one (task_cancel) first.`;
        return {
          content: [{ type: "text", text: message }],
          details: { worker: "mmr-subagents.async-task", tool: START_TASK_TOOL_NAME, agent: parsed.agent, errorMessage: message },
        };
      }
      const snapshot = started.started.snapshot;
      // Surface the launched agent on the pinned bottom-of-window widget so the
      // transcript card can stay empty (see renderMmrBackgroundTaskResult).
      refreshAsyncTaskWidget(ctx, registry, sessionKey);
      const dedupNote = started.started.deduplicated ? " (existing task for this call)" : "";
      const groupNote = snapshot.groupId ? ` in group ${snapshot.groupId}` : "";
      const message =
        `start_task: started background worker ${snapshot.taskId}${dedupNote}${groupNote} ("${snapshot.description}", agent ${snapshot.agent}). ` +
        `It will notify this session on completion by default; use task_poll/task_wait only after an elapsed-time fallback ` +
        `or for multi-worker orchestration, and task_cancel to stop it. Background tasks are in-memory and lost if the session ends.`;
      return {
        content: [{ type: "text", text: message }],
        details: {
          worker: "mmr-subagents.async-task",
          tool: START_TASK_TOOL_NAME,
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
        },
      };
    },
  } satisfies ToolDefinition;
}

function renderBoard(board: MmrAsyncTaskBoard): string {
  const lines: string[] = [
    `task_poll: ${board.counts.active} active, ${board.counts.stalled} stalled, ${board.counts.finished} finished.`,
  ];
  const section = (title: string, entries: MmrAsyncTaskBoard["active"]) => {
    if (entries.length === 0) return;
    lines.push(`${title}:`);
    for (const e of entries) {
      const fresh = e.freshness !== "healthy" && e.freshness !== "terminal" ? ` [${e.freshness}]` : "";
      lines.push(`  - ${e.taskId} (${e.status}${fresh}, ${e.agent}) "${e.description}"`);
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
  const wait = timedOut ? " Wait timed out; the group is still running." : "";
  const head = `${tool}: group ${group.groupId} ${group.status} (${group.counts.total} task(s): ${group.counts.succeeded} succeeded, ${group.counts.failed} failed, ${group.counts.cancelled} cancelled, ${group.counts.partial} partial).${wait}`;
  if (group.taskIds.length === 0) return head;
  const ids = group.taskIds.join(", ");
  const retrieve = group.status === "running"
    ? ` Child task_ids: ${ids}.`
    : ` Poll each task_id to retrieve final worker outputs: ${ids}.`;
  return `${head}${retrieve}`;
}

function groupResult(
  tool: AsyncTaskToolDetails["tool"],
  group: MmrAsyncTaskGroupSnapshot,
  timedOut?: boolean,
): AgentToolResult<AsyncTaskToolDetails> {
  return {
    content: [{ type: "text", text: renderGroup(tool, group, timedOut) }],
    details: {
      worker: "mmr-subagents.async-task",
      tool,
      groupId: group.groupId,
      group,
      ...(timedOut !== undefined ? { timedOut } : {}),
    },
  };
}

function invalidAsyncControlResult(
  tool: AsyncTaskToolDetails["tool"],
  message: string,
): AgentToolResult<AsyncTaskToolDetails> {
  return {
    content: [{ type: "text", text: `${tool}: invalid parameters: ${message}` }],
    details: { worker: "mmr-subagents.async-task", tool, errorMessage: message },
  };
}

function groupNotFoundResult(
  tool: AsyncTaskToolDetails["tool"],
  groupId: string,
): AgentToolResult<AsyncTaskToolDetails> {
  const message = `${tool}: no background task group with id "${groupId}" in this session.`;
  return {
    content: [{ type: "text", text: message }],
    details: { worker: "mmr-subagents.async-task", tool, groupId, errorMessage: message },
  };
}

function parseTaskOrGroupControl(
  rawParams: unknown,
): { taskId?: string; groupId?: string; error?: string } {
  const params = isRecord(rawParams) ? rawParams : {};
  const taskId = typeof params.task_id === "string" && params.task_id.length > 0 ? params.task_id : undefined;
  const groupId = typeof params.group_id === "string" && params.group_id.length > 0 ? params.group_id : undefined;
  if (taskId && groupId) return { error: "task_id and group_id are mutually exclusive." };
  if (groupId && !isValidAsyncTaskGroupId(groupId)) return { error: "group_id must be shaped like group_<hex>." };
  return { ...(taskId !== undefined ? { taskId } : {}), ...(groupId !== undefined ? { groupId } : {}) };
}

export function createTaskPollTool(deps: AsyncTaskToolDeps = {}): ToolDefinition {
  const registry = deps.registry ?? getMmrAsyncTaskRegistry();
  return {
    name: TASK_POLL_TOOL_NAME,
    label: TASK_POLL_TOOL_NAME,
    description: [
      "Poll one background task by task_id, or omit task_id to list all background tasks for this session.",
      "Returns the latest progress for a running task or the final result for a finished one.",
    ].join("\n"),
    promptSnippet: "Poll one background task by task_id, or list all background tasks for this session",
    promptGuidelines: [...ASYNC_TASK_GUIDELINES],
    parameters: TASK_POLL_PARAMETERS,
    renderShell: "self" as const,
    renderCall(args, theme, context) {
      return renderMmrBackgroundTaskCall(TASK_POLL_TOOL_NAME, args, theme, context);
    },
    renderResult(result, options, theme, context) {
      return renderMmrBackgroundTaskResult(TASK_POLL_TOOL_NAME, result, options, theme, context);
    },
    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx): Promise<AgentToolResult<AsyncTaskToolDetails>> {
      const sessionKey = resolveSessionKey(ctx, deps);
      const validated = validateAsyncToolParams(TASK_POLL_TOOL_NAME, TASK_POLL_PARAMETERS, rawParams);
      if (!validated.ok) return invalidAsyncControlResult(TASK_POLL_TOOL_NAME, validated.message);
      const control = parseTaskOrGroupControl(rawParams);
      if (control.error) return invalidAsyncControlResult(TASK_POLL_TOOL_NAME, control.error);
      if (control.groupId) {
        const group = registry.getGroup(sessionKey, control.groupId);
        if (!group) return groupNotFoundResult(TASK_POLL_TOOL_NAME, control.groupId);
        refreshAsyncTaskWidget(ctx, registry, sessionKey);
        return groupResult(TASK_POLL_TOOL_NAME, group);
      }
      if (!control.taskId) {
        const board = registry.listTasks(sessionKey);
        refreshBackgroundTaskWidget(ctx, board);
        return {
          content: [{ type: "text", text: renderBoard(board) }],
          details: { worker: "mmr-subagents.async-task", tool: TASK_POLL_TOOL_NAME, board },
        };
      }
      const snapshot = registry.getTask(sessionKey, control.taskId);
      if (!snapshot) return notFoundResult(TASK_POLL_TOOL_NAME, control.taskId);
      refreshAsyncTaskWidget(ctx, registry, sessionKey);
      return projectSnapshot(TASK_POLL_TOOL_NAME, snapshot);
    },
  } satisfies ToolDefinition;
}

export function createTaskWaitTool(deps: AsyncTaskToolDeps = {}): ToolDefinition {
  const registry = deps.registry ?? getMmrAsyncTaskRegistry();
  return {
    name: TASK_WAIT_TOOL_NAME,
    label: TASK_WAIT_TOOL_NAME,
    description: [
      "Wait up to timeout_ms for a background task to finish, then return its current state.",
      "A timeout is NOT a failure and does NOT cancel the worker — poll or wait again.",
    ].join("\n"),
    promptSnippet: "Wait briefly for a background task to finish without cancelling it on timeout",
    promptGuidelines: [...ASYNC_TASK_GUIDELINES],
    parameters: TASK_WAIT_PARAMETERS,
    renderShell: "self" as const,
    renderCall(args, theme, context) {
      return renderMmrBackgroundTaskCall(TASK_WAIT_TOOL_NAME, args, theme, context);
    },
    renderResult(result, options, theme, context) {
      return renderMmrBackgroundTaskResult(TASK_WAIT_TOOL_NAME, result, options, theme, context);
    },
    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx): Promise<AgentToolResult<AsyncTaskToolDetails>> {
      const sessionKey = resolveSessionKey(ctx, deps);
      const validated = validateAsyncToolParams(TASK_WAIT_TOOL_NAME, TASK_WAIT_PARAMETERS, rawParams);
      if (!validated.ok) return invalidAsyncControlResult(TASK_WAIT_TOOL_NAME, validated.message);
      const control = parseTaskOrGroupControl(rawParams);
      if (control.error) return invalidAsyncControlResult(TASK_WAIT_TOOL_NAME, control.error);
      if (!control.taskId && !control.groupId) return invalidAsyncControlResult(TASK_WAIT_TOOL_NAME, "task_wait requires task_id or group_id.");
      const timeoutMs = validated.value.timeout_ms;
      if (control.groupId) {
        const result = await registry.waitForGroup({
          sessionKey,
          groupId: control.groupId,
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        });
        if (!result.found || !result.snapshot) return groupNotFoundResult(TASK_WAIT_TOOL_NAME, control.groupId);
        refreshAsyncTaskWidget(ctx, registry, sessionKey);
        return groupResult(TASK_WAIT_TOOL_NAME, result.snapshot, result.timedOut);
      }
      const taskId = control.taskId;
      if (!taskId) return invalidAsyncControlResult(TASK_WAIT_TOOL_NAME, "task_wait requires task_id or group_id.");
      const result = await registry.waitForTask({
        sessionKey,
        taskId,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
      if (!result.found || !result.snapshot) return notFoundResult(TASK_WAIT_TOOL_NAME, taskId);
      refreshAsyncTaskWidget(ctx, registry, sessionKey);
      return projectSnapshot(TASK_WAIT_TOOL_NAME, result.snapshot, { timedOut: result.timedOut });
    },
  } satisfies ToolDefinition;
}

export function createTaskCancelTool(deps: AsyncTaskToolDeps = {}): ToolDefinition {
  const registry = deps.registry ?? getMmrAsyncTaskRegistry();
  return {
    name: TASK_CANCEL_TOOL_NAME,
    label: TASK_CANCEL_TOOL_NAME,
    description: [
      "Cancel a background task by task_id. Aborts the worker process and returns its final cancellation status.",
      "Cancelling an already-finished task is a safe no-op that returns its terminal state.",
    ].join("\n"),
    promptSnippet: "Cancel a background task by task_id",
    promptGuidelines: [...ASYNC_TASK_GUIDELINES],
    parameters: TASK_CANCEL_PARAMETERS,
    renderShell: "self" as const,
    renderCall(args, theme, context) {
      return renderMmrBackgroundTaskCall(TASK_CANCEL_TOOL_NAME, args, theme, context);
    },
    renderResult(result, options, theme, context) {
      return renderMmrBackgroundTaskResult(TASK_CANCEL_TOOL_NAME, result, options, theme, context);
    },
    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx): Promise<AgentToolResult<AsyncTaskToolDetails>> {
      const sessionKey = resolveSessionKey(ctx, deps);
      const validated = validateAsyncToolParams(TASK_CANCEL_TOOL_NAME, TASK_CANCEL_PARAMETERS, rawParams);
      if (!validated.ok) return invalidAsyncControlResult(TASK_CANCEL_TOOL_NAME, validated.message);
      const control = parseTaskOrGroupControl(rawParams);
      if (control.error) return invalidAsyncControlResult(TASK_CANCEL_TOOL_NAME, control.error);
      if (!control.taskId && !control.groupId) return invalidAsyncControlResult(TASK_CANCEL_TOOL_NAME, "task_cancel requires task_id or group_id.");
      const reason = validated.value.reason;
      if (control.groupId) {
        const group = await registry.cancelGroup({
          sessionKey,
          groupId: control.groupId,
          ...(reason !== undefined ? { reason } : {}),
        });
        if (!group) return groupNotFoundResult(TASK_CANCEL_TOOL_NAME, control.groupId);
        refreshAsyncTaskWidget(ctx, registry, sessionKey);
        return groupResult(TASK_CANCEL_TOOL_NAME, group);
      }
      const taskId = control.taskId;
      if (!taskId) return invalidAsyncControlResult(TASK_CANCEL_TOOL_NAME, "task_cancel requires task_id or group_id.");
      const snapshot = await registry.cancelTask({
        sessionKey,
        taskId,
        ...(reason !== undefined ? { reason } : {}),
      });
      if (!snapshot) return notFoundResult(TASK_CANCEL_TOOL_NAME, taskId);
      refreshAsyncTaskWidget(ctx, registry, sessionKey);
      // Project the same subagent details poll/wait carry so a cancelled card
      // shows the worker model/usage/trail like a blocking subagent.
      const finalDetails = snapshot.finalToolResult
        ? snapshot.finalToolResult.details
        : snapshot.finalResult
          ? buildTaskFinalResult(snapshot.finalResult, detailsContextFromSnapshot(snapshot)).details
          : undefined;
      const trail = snapshot.finalResult?.trail
        ?? snapshot.latestProgress?.trail
        ?? extractTrailFromToolResult(snapshot.finalToolResult)
        ?? extractTrailFromToolResult(snapshot.latestToolResult);
      const summary = summarizeTrail(trail);
      const settledNote =
        snapshot.status === "cancelling"
          ? " The worker has not stopped yet; poll task_poll to confirm it terminates."
          : "";
      const finalOutput = `${summary}${settledNote}`.trim();
      return {
        content: [
          { type: "text", text: `task_cancel: ${snapshot.agent} task ${snapshot.taskId} ${snapshot.status}. ${summary}${settledNote}` },
        ],
        details: {
          worker: "mmr-subagents.async-task",
          tool: TASK_CANCEL_TOOL_NAME,
          agent: snapshot.agent as AsyncTaskAgentName,
          taskId: snapshot.taskId,
          status: snapshot.status,
          freshness: snapshot.freshness,
          description: snapshot.description,
          prompt: snapshot.prompt,
          ...(finalDetails !== undefined ? { final: finalDetails } : {}),
          ...(finalOutput.length > 0 ? { finalOutput } : {}),
        },
      };
    },
  } satisfies ToolDefinition;
}

/**
 * Register the four async task tools as MMR-owned Pi tools. Returns the
 * registered definitions for tests/inspection.
 */
export function registerAsyncTaskTools(pi: ExtensionAPI, deps: AsyncTaskToolDeps = {}): ToolDefinition[] {
  const withPi: AsyncTaskToolDeps = { ...deps, pi };
  const definitions = [
    createStartTaskTool(withPi),
    createTaskPollTool(withPi),
    createTaskWaitTool(withPi),
    createTaskCancelTool(withPi),
  ];
  for (const definition of definitions) {
    registerMmrOwnedTool(definition.name);
    pi.registerTool(definition);
  }
  // Render the async-task completion push as a compact status row instead of
  // dumping its model-facing `<task-notification>` XML into the transcript.
  // Feature-detected so headless/JSON hosts without a renderer pipeline are
  // unaffected (the message still delivers; only its TUI shape changes).
  if (typeof pi.registerMessageRenderer === "function") {
    pi.registerMessageRenderer(ASYNC_TASK_COMPLETION_CUSTOM_TYPE, renderAsyncTaskCompletionMessage);
  }
  return definitions;
}
