import { Type, type Static, type TSchema } from "typebox";
import { checkMmrToolParams, MmrToolParamsError } from "../mmr-core/tool-params.js";
import {
  MAX_TASK_WAIT_TIMEOUT_MS,
  type MmrAsyncTaskBoard,
  type MmrAsyncTaskGroupSnapshot,
  type MmrAsyncTaskInternalSnapshot,
  type MmrAsyncTaskStatus,
} from "./async-task-registry.js";
import {
  START_TASK_AGENT_EXAMPLES,
  START_TASK_GROUP_FANOUT_GUIDANCE,
  START_TASK_SELECTION_GUIDANCE,
} from "../mmr-subagents/tool-guidance.js";

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

export const PULL_NOTICE_MAX_ITEMS = 12;
export const PULL_NOTICE_LABEL_LIMIT = 120;
export type AsyncTaskAgentName = typeof ASYNC_TASK_AGENT_NAMES[number];

/**
 * Run the shared TypeBox validator and return a structured outcome instead of
 * throwing, so each async tool can surface its own deterministic validation
 * result. The shared helper's `"<tool>: invalid parameters: <msg>"` prefix is
 * stripped here because the per-tool result wrappers re-add it.
 */
export function validateAsyncToolParams<T extends TSchema>(
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

/** One declared fleet member, rendered as a row in its group card. */
export interface AsyncTaskFleetRow {
  taskId: string;
  agent: AsyncTaskAgentName;
  description: string;
  resolvedModel?: string;
  capabilityProfile?: string;
}

/** One declared fleet group: its minted id, label, and member rows in order. */
export interface AsyncTaskFleetGroupDetails {
  groupId: string;
  label?: string;
  taskIds: string[];
  rows: AsyncTaskFleetRow[];
}

/**
 * Frozen declaration of a fleet, carried on the `start_task` result so the
 * inline card can render every group up front and so a replayed transcript
 * (no live registry) still shows the declared rows. The live registry board is
 * the source of truth once workers launch; this is the ordering/replay anchor.
 */
export interface AsyncTaskFleetDetails {
  version: 1;
  totalTasks: number;
  groups: AsyncTaskFleetGroupDetails[];
}

/** Discriminated details for the async task tools' results. */
export interface AsyncTaskToolDetails {
  worker: "mmr-subagents.async-task";
  tool: (typeof ASYNC_TASK_TOOL_NAMES)[number];
  agent?: AsyncTaskAgentName;
  taskId?: string;
  groupId?: string;
  /** True on the start_task call that opened the group (renders the group card). */
  groupOpener?: boolean;
  /** Registry partition key; renderer-only, lets the inline card read live state. */
  sessionKey?: string;
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
  /** Present on a fleet declaration (`start_task.fleet`); renders all group cards up front. */
  fleet?: AsyncTaskFleetDetails;
  errorMessage?: string;
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
    "Optional legacy worker-group id for adding a single worker to a group incrementally. Use group_id:'new' to mint one group, or a previously returned concrete group id to add a later sibling to it. For same-step fan-out, prefer start_task.fleet instead of group_id. Concrete ids look like group_<hex>.",
});

const GROUP_LABEL_SCHEMA = Type.String({
  maxLength: 256,
  description:
    "Optional human-readable label for the worker group, shown on the orchestration widget header. Honored only on the opening call (group_id:'new'); ignored when joining an existing group. Defaults to the first worker's description when omitted.",
});

const FLEET_MEMBER_SCHEMA = Type.Object(
  {
    agent: Type.Optional(START_TASK_AGENT_SCHEMA),
    params: Type.Optional(
      Type.Object(
        {},
        {
          additionalProperties: true,
          description:
            "Parameters for this worker's agent. For Task use {prompt, description}; for finder use {query}; for librarian use {query, context?}.",
        },
      ),
    ),
    prompt: Type.Optional(
      Type.String({ description: "Shortcut prompt/query when params is omitted (Task prompt, or finder/librarian query)." }),
    ),
    description: Type.Optional(Type.String({ description: "Short display label for this worker." })),
    capabilityProfile: Type.Optional(TASK_CAPABILITY_PROFILE_SCHEMA),
  },
  {
    additionalProperties: false,
    description:
      "One fleet worker. Do not set a group id here — the runtime mints group ids for the fleet.",
  },
);

const FLEET_GROUP_SCHEMA = Type.Object(
  {
    group_label: Type.Optional(GROUP_LABEL_SCHEMA),
    members: Type.Array(FLEET_MEMBER_SCHEMA, {
      minItems: 1,
      description: "Workers that make up this group; each renders as one row in the group card.",
    }),
  },
  { additionalProperties: false, description: "One worker group in the fleet." },
);

const FLEET_SCHEMA = Type.Object(
  {
    groups: Type.Array(FLEET_GROUP_SCHEMA, {
      minItems: 1,
      description: "The worker groups to declare; each renders as its own group card.",
    }),
  },
  {
    additionalProperties: false,
    description:
      "Declare a whole fan-out in one call: every group and member is created up front and rendered as a ready card before any worker launches, then all launch together. Omit group_id inside fleet (the runtime mints ids), and do not combine fleet with the single-task fields (agent/params/prompt/group_id).",
  },
);

export const START_TASK_PARAMETERS = Type.Object(
  {
    agent: Type.Optional(START_TASK_AGENT_SCHEMA),
    fleet: Type.Optional(FLEET_SCHEMA),
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
    group_label: Type.Optional(GROUP_LABEL_SCHEMA),
    notify: Type.Optional(
      Type.Boolean({
        description:
          "Automatic completion delivery. ON by default: during an active agent loop, finished work is surfaced before a later model step; when idle, a completion push may wake the session. Pass false to opt out and pull the result explicitly with task_poll/task_wait.",
      }),
    ),
  },
  { additionalProperties: false },
);

export const TASK_POLL_PARAMETERS = Type.Object(
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

export const TASK_WAIT_PARAMETERS = Type.Object(
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

export const TASK_CANCEL_PARAMETERS = Type.Object(
  {
    task_id: Type.Optional(Type.String({ description: "Opaque id returned by start_task.", maxLength: 256 })),
    group_id: Type.Optional(Type.String({ maxLength: 256, pattern: "^group_[a-f0-9]{6,}$", description: "Opaque worker group id. Mutually exclusive with task_id; cancels all non-terminal children." })),
    reason: Type.Optional(Type.String({ description: "Short cancellation reason for diagnostics.", maxLength: 512 })),
  },
  { additionalProperties: false },
);

export const START_TASK_DESCRIPTION = [
  "Start a bounded subagent worker in the background and return an opaque task_id immediately, so you can keep working while it runs.",
  "",
  "Use start_task only for independent work that can proceed while you do other things (long analysis, broad search, a self-contained implementation unit).",
  "Set agent to choose the background worker: Task (default), finder, or librarian. Use params for the selected tool's normal input shape. Oracle cannot run in the background; it is always blocking.",
  START_TASK_SELECTION_GUIDANCE,
  "With notify enabled, completed background work is surfaced automatically: during an active agent loop it appears at the start of a later model step, and when idle it may wake the session.",
  "Use task_poll/task_wait for legitimate fleet orchestration: coordinating multiple parallel workers, checking a group, or collecting child results. A task_wait timeout is not a failure and does not stop the worker.",
  "To launch several workers at once, pass fleet.groups[] (each group lists its members) in one call: the runtime mints the group ids, renders every group card up front in a ready state, and launches them together. Omit group_id inside fleet, and do not combine fleet with the single-task fields.",
  "group_id is the legacy incremental path: use group_id:'new' to mint a group on one call and a returned concrete group id to add a later sibling. The opening call controls the single grouped notification; sibling tasks in the group do not send individual completion notifications. Prefer fleet for same-step fan-out.",
  START_TASK_GROUP_FANOUT_GUIDANCE,
  "For Task workers only, capabilityProfile can narrow tools to read-only or read-write (narrowing only; never widens the default Task surface).",
  "By default a background task notifies you once it finishes; pass notify:false to opt out and make task_poll/task_wait the only retrieval path.",
  "",
  "Background tasks are in-memory and session-scoped: they are lost if the Pi process exits, and they cannot spawn further background tasks.",
].join("\n");

export const ASYNC_TASK_GUIDELINES: readonly string[] = [
  START_TASK_SELECTION_GUIDANCE,
  "With notify enabled, completed background work is surfaced automatically: during an active agent loop it appears at the start of a later model step, and when idle it may wake the session. Do not poll only to discover whether a single task completed.",
  "Use task_poll or task_wait for legitimate fleet orchestration: coordinating multiple parallel workers, checking a group, or collecting child results. A task_wait timeout is not a failure and does not stop the worker.",
  "Treat a terminal task_poll/task_wait result as consumed. Do not poll the same task again unless you intentionally need to re-read the same result.",
  "If a task-notification, task-group-notification, or background-tasks-finished notice appears for a task/group whose terminal result is already present in the transcript, treat it as stale; do not call tools or rewrite your answer solely because of it.",
  "Call task_poll with no task_id to list this session's background tasks and their delivery state during fallback checks or multi-worker orchestration.",
  "To fan out several workers at once, declare them with start_task({ fleet: { groups: [...] } }) in a single call; the runtime mints the group ids and renders all group cards up front. Use group_id only to add a worker to a group incrementally across separate calls, then wait/poll/cancel with group_id. When the group finishes, retrieve each needed child output once with task_poll({ task_id }) for the ids the group result lists.",
  START_TASK_GROUP_FANOUT_GUIDANCE,
  "Use task_cancel to stop a duplicate, obsolete, or wrongly-scoped background task or group.",
  "Do not start multiple code-writing background tasks unless their file targets are clearly disjoint.",
  "Pass start_task({ notify: false }) to opt out of automatic delivery and pull the result explicitly with task_poll/task_wait.",
  ...START_TASK_AGENT_EXAMPLES,
];
