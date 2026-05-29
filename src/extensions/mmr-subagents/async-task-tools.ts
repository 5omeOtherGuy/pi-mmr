import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerMmrOwnedTool } from "../mmr-core/owned-tools.js";
import { getMmrSessionIdentitySnapshot } from "../mmr-core/runtime.js";
import type { MmrWorkerTrailItem } from "./worker-trail.js";
import {
  buildSpawnErrorWorkerResult,
  buildTaskFinalResult,
  buildTaskProgressResult,
  prepareTaskRun,
  type TaskDetails,
  type TaskDetailsContext,
  type TaskToolDeps,
} from "./task.js";
import {
  getMmrAsyncTaskRegistry,
  MAX_TASK_WAIT_TIMEOUT_MS,
  type MmrAsyncTaskBoard,
  type MmrAsyncTaskRegistry,
  type MmrAsyncTaskInternalSnapshot,
  type MmrAsyncTaskStatus,
} from "./async-task-registry.js";

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

/** Discriminated details for the async task tools' results. */
export interface AsyncTaskToolDetails {
  worker: "mmr-subagents.async-task";
  tool: (typeof ASYNC_TASK_TOOL_NAMES)[number];
  taskId?: string;
  status?: MmrAsyncTaskStatus;
  freshness?: MmrAsyncTaskInternalSnapshot["freshness"];
  timedOut?: boolean;
  /** Final projected Task details when a polled/awaited task is terminal. */
  final?: TaskDetails;
  /** Board snapshot for `task_poll` list mode. */
  board?: MmrAsyncTaskBoard;
  errorMessage?: string;
}

export interface AsyncTaskToolDeps extends TaskToolDeps {
  /** Registry seam; defaults to the process singleton. */
  registry?: MmrAsyncTaskRegistry;
  /** Deterministic session key override for tests. */
  sessionKey?: string;
  /**
   * Enable the at-most-once completion push. Default OFF (pull-only):
   * an injected `nextTurn` message can trigger an extra turn while the
   * parent is mid-work, so completion push is opt-in.
   */
  enableCompletionPush?: boolean;
}

const START_TASK_PARAMETERS = Type.Object(
  {
    prompt: Type.String({
      description:
        "The bounded task prompt for the background worker. Include goal, scope, context, constraints, validation, and expected result shape.",
    }),
    description: Type.String({ description: "Short display label for the background task." }),
  },
  { additionalProperties: false },
);

const TASK_POLL_PARAMETERS = Type.Object(
  {
    task_id: Type.Optional(
      Type.String({
        maxLength: 256,
        description:
          "Opaque id returned by start_task. Omit to list all background tasks for the current session.",
      }),
    ),
  },
  { additionalProperties: false },
);

const TASK_WAIT_PARAMETERS = Type.Object(
  {
    task_id: Type.String({ description: "Opaque id returned by start_task.", maxLength: 256 }),
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
    task_id: Type.String({ description: "Opaque id returned by start_task.", maxLength: 256 }),
    reason: Type.Optional(Type.String({ description: "Short cancellation reason for diagnostics.", maxLength: 512 })),
  },
  { additionalProperties: false },
);

const START_TASK_DESCRIPTION = [
  "Start a bounded subagent worker in the background and return an opaque task_id immediately, so you can keep working while it runs.",
  "",
  "Use start_task only for independent work that can proceed while you do other things (long analysis, broad search, a self-contained implementation unit).",
  "Prefer the blocking Task tool when you need the result before your next reasoning step.",
  "Always follow start_task with task_poll or task_wait before relying on the result; the parent remains responsible for integration and the final answer.",
  "",
  "Background tasks are in-memory and session-scoped: they are lost if the Pi process exits, and they cannot spawn further background tasks.",
].join("\n");

const ASYNC_TASK_GUIDELINES: readonly string[] = [
  "Use start_task only for independent work that can run while you continue; prefer blocking Task when you need the result immediately.",
  "After start_task, use task_poll (with the task_id) or task_wait to check on the worker; a task_wait timeout is not a failure and does not stop the worker.",
  "Call task_poll with no task_id to list this session's background tasks (active, stalled, finished).",
  "Use task_cancel to stop a duplicate, obsolete, or wrongly-scoped background task.",
  "Do not start multiple code-writing background tasks unless their file targets are clearly disjoint.",
];

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
function firstText(content: AgentToolResult<TaskDetails>["content"]): string | undefined {
  for (const part of content) {
    if (part.type === "text" && typeof part.text === "string") return part.text;
  }
  return undefined;
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
  const progressText = snapshot.latestProgress
    ? firstText(buildTaskProgressResult(snapshot.latestProgress, detailsContextFromSnapshot(snapshot)).content)
    : undefined;
  const header = `${tool}: task ${snapshot.taskId} is ${snapshot.status}${freshnessNote(snapshot)}.`;
  const waitHint = opts.timedOut ? " Wait timed out; the worker is still running. Poll or wait again." : "";
  const body = progressText && progressText.trim().length > 0 ? `\n\n${progressText}` : "";
  return {
    content: [{ type: "text", text: `${header}${waitHint}${body}` }],
    details: {
      worker: "mmr-subagents.async-task",
      tool,
      taskId: snapshot.taskId,
      status: snapshot.status,
      freshness: snapshot.freshness,
      ...(opts.timedOut !== undefined ? { timedOut: opts.timedOut } : {}),
    },
  };
}

/** Project a terminal snapshot into a final tool result (reuses Task shaping). */
function projectTerminal(
  tool: AsyncTaskToolDetails["tool"],
  snapshot: MmrAsyncTaskInternalSnapshot,
): AgentToolResult<AsyncTaskToolDetails> {
  const statusLine = `${tool}: task ${snapshot.taskId} ${snapshot.status}.`;
  let body = snapshot.errorMessage ? `\n\n${snapshot.errorMessage}` : "";
  let final: TaskDetails | undefined;
  if (snapshot.finalResult) {
    const projected = buildTaskFinalResult(snapshot.finalResult, detailsContextFromSnapshot(snapshot));
    final = projected.details;
    const text = firstText(projected.content);
    if (text && text.trim().length > 0) body = `\n\n${text}`;
  }
  return {
    content: [{ type: "text", text: `${statusLine}${body}` }],
    details: {
      worker: "mmr-subagents.async-task",
      tool,
      taskId: snapshot.taskId,
      status: snapshot.status,
      freshness: snapshot.freshness,
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
    sendMessage(
      {
        customType: "mmr-subagents.async-task-completion",
        content:
          `<task-notification task_id="${escapeXmlAttr(snapshot.taskId)}" status="${snapshot.status}">\n` +
          `Background task "${escapeXmlAttr(snapshot.description)}" ${snapshot.status}. ` +
          `Use task_poll({task_id:"${escapeXmlAttr(snapshot.taskId)}"}) to read the result.\n` +
          `</task-notification>`,
        display: true,
        details: {
          version: 1,
          kind: "mmr-subagents.async-task-completion",
          taskId: snapshot.taskId,
          status: snapshot.status,
        },
      },
      { deliverAs: "nextTurn", triggerTurn: true },
    );
  };
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
    async execute(toolCallId, rawParams, _signal, _onUpdate, ctx): Promise<AgentToolResult<AsyncTaskToolDetails>> {
      // Reuse the blocking Task validation/routing path. A pre-spawn
      // failure returns the same shaped result and creates no record.
      const prep = prepareTaskRun(rawParams, ctx, deps);
      if (!prep.ok) {
        return {
          content: prep.result.content,
          details: {
            worker: "mmr-subagents.async-task",
            tool: START_TASK_TOOL_NAME,
            errorMessage: prep.result.details?.errorMessage,
          },
        };
      }
      const { params, cwd, detailsContext, runnerOptionsBase, runner } = prep.prepared;
      const sessionKey = resolveSessionKey(ctx, deps);
      const notify = deps.enableCompletionPush ? buildCompletionNotifier(deps.pi) : undefined;
      const started = registry.startTask({
        sessionKey,
        originToolCallId: toolCallId,
        description: params.description,
        prompt: params.prompt,
        cwd,
        ...(detailsContext.resolvedModel !== undefined ? { resolvedModel: detailsContext.resolvedModel } : {}),
        ...(detailsContext.contextWindow !== undefined ? { contextWindow: detailsContext.contextWindow } : {}),
        workerTools: detailsContext.workerTools,
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
        ...(notify !== undefined ? { notify } : {}),
      });
      if (!started.ok) {
        const message =
          `start_task: cannot start; ${started.runningCount} background task(s) already running ` +
          `(cap ${started.cap}). Wait for one to finish (task_wait) or stop one (task_cancel) first.`;
        return {
          content: [{ type: "text", text: message }],
          details: { worker: "mmr-subagents.async-task", tool: START_TASK_TOOL_NAME, errorMessage: message },
        };
      }
      const snapshot = started.snapshot;
      const dedupNote = started.deduplicated ? " (existing task for this call)" : "";
      const message =
        `start_task: started background worker ${snapshot.taskId}${dedupNote} ("${snapshot.description}"). ` +
        `Use task_poll({task_id:"${snapshot.taskId}"}) to check progress, task_wait to block briefly, ` +
        `or task_cancel to stop it. Background tasks are in-memory and lost if the session ends.`;
      return {
        content: [{ type: "text", text: message }],
        details: {
          worker: "mmr-subagents.async-task",
          tool: START_TASK_TOOL_NAME,
          taskId: snapshot.taskId,
          status: snapshot.status,
          freshness: snapshot.freshness,
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
      lines.push(`  - ${e.taskId} (${e.status}${fresh}) "${e.description}"`);
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
    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx): Promise<AgentToolResult<AsyncTaskToolDetails>> {
      const sessionKey = resolveSessionKey(ctx, deps);
      const taskId = (rawParams as { task_id?: unknown })?.task_id;
      if (typeof taskId !== "string" || taskId.length === 0) {
        const board = registry.listTasks(sessionKey);
        return {
          content: [{ type: "text", text: renderBoard(board) }],
          details: { worker: "mmr-subagents.async-task", tool: TASK_POLL_TOOL_NAME, board },
        };
      }
      const snapshot = registry.getTask(sessionKey, taskId);
      if (!snapshot) return notFoundResult(TASK_POLL_TOOL_NAME, taskId);
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
    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx): Promise<AgentToolResult<AsyncTaskToolDetails>> {
      const sessionKey = resolveSessionKey(ctx, deps);
      const params = rawParams as { task_id?: unknown; timeout_ms?: unknown };
      const taskId = typeof params?.task_id === "string" ? params.task_id : "";
      if (taskId.length === 0) return notFoundResult(TASK_WAIT_TOOL_NAME, "");
      const timeoutMs = typeof params?.timeout_ms === "number" ? params.timeout_ms : undefined;
      const result = await registry.waitForTask({
        sessionKey,
        taskId,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
      if (!result.found || !result.snapshot) return notFoundResult(TASK_WAIT_TOOL_NAME, taskId);
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
    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx): Promise<AgentToolResult<AsyncTaskToolDetails>> {
      const sessionKey = resolveSessionKey(ctx, deps);
      const params = rawParams as { task_id?: unknown; reason?: unknown };
      const taskId = typeof params?.task_id === "string" ? params.task_id : "";
      if (taskId.length === 0) return notFoundResult(TASK_CANCEL_TOOL_NAME, "");
      const reason = typeof params?.reason === "string" ? params.reason : undefined;
      const snapshot = await registry.cancelTask({
        sessionKey,
        taskId,
        ...(reason !== undefined ? { reason } : {}),
      });
      if (!snapshot) return notFoundResult(TASK_CANCEL_TOOL_NAME, taskId);
      const trail = snapshot.finalResult?.trail ?? snapshot.latestProgress?.trail;
      const summary = summarizeTrail(trail);
      const settledNote =
        snapshot.status === "cancelling"
          ? " The worker has not stopped yet; poll task_poll to confirm it terminates."
          : "";
      return {
        content: [
          { type: "text", text: `task_cancel: task ${snapshot.taskId} ${snapshot.status}. ${summary}${settledNote}` },
        ],
        details: {
          worker: "mmr-subagents.async-task",
          tool: TASK_CANCEL_TOOL_NAME,
          taskId: snapshot.taskId,
          status: snapshot.status,
          freshness: snapshot.freshness,
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
  return definitions;
}
