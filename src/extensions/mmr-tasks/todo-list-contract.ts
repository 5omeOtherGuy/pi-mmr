/**
 * Schema, strict defense-in-depth validation, and model-visible contract text
 * for the session-local `task_list` todo tool.
 *
 * Extracted from `todo-list-tool.ts` as a focused leaf module. Text is
 * behavior: `TASK_LIST_DESCRIPTION`, `TASK_LIST_PROMPT_GUIDELINES`,
 * `TASK_LIST_PROMPT_SNIPPET`, and the schema field descriptions are
 * model-visible and must not change without a coordinated migration.
 */

import { Type, type Static } from "typebox";
import type { TaskListItem, TaskListSubtask, TodoStatus } from "./todo-list.js";

// ---------------------------------------------------------------------------
// Parameter schema (declarative; Pi's host validates against this)
// ---------------------------------------------------------------------------

const TASK_LIST_SUBTASK = Type.Object(
  {
    content: Type.String({
      minLength: 1,
      description: "Imperative form of the child todo.",
    }),
    activeForm: Type.Optional(Type.String({
      minLength: 1,
      description:
        "Optional present-continuous form shown while the subtask is in_progress.",
    })),
    status: Type.Union(
      [
        Type.Literal("pending"),
        Type.Literal("in_progress"),
        Type.Literal("completed"),
      ],
      { description: "One of pending | in_progress | completed." },
    ),
  },
  { additionalProperties: false },
);

const TASK_LIST_ITEM = Type.Object(
  {
    content: Type.String({
      minLength: 1,
      description: "Imperative form of the todo (e.g. 'Run tests').",
    }),
    activeForm: Type.String({
      minLength: 1,
      description:
        "Present-continuous form shown while the item is in_progress (e.g. 'Running tests').",
    }),
    status: Type.Union(
      [
        Type.Literal("pending"),
        Type.Literal("in_progress"),
        Type.Literal("completed"),
      ],
      { description: "One of pending | in_progress | completed." },
    ),
    subtasks: Type.Optional(Type.Array(TASK_LIST_SUBTASK, {
      description:
        "Optional child todos. Use this for real subtasks instead of encoding subtasks in content text.",
    })),
  },
  { additionalProperties: false },
);

export const TASK_LIST_PARAMS = Type.Object(
  {
    tasks: Type.Array(TASK_LIST_ITEM, {
      description:
        "The full todo list. Whole-list replacement: what you submit becomes the new list.",
    }),
  },
  { additionalProperties: false },
);

export type TaskListParams = Static<typeof TASK_LIST_PARAMS>;

// ---------------------------------------------------------------------------
// Defense-in-depth validation (TypeBox is declarative; some hosts skip it)
// ---------------------------------------------------------------------------

export class TodoValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TodoValidationError";
  }
}

const ALLOWED_TOP_KEYS: ReadonlySet<string> = new Set(["tasks"]);
const ALLOWED_ITEM_KEYS: ReadonlySet<string> = new Set([
  "content",
  "activeForm",
  "status",
  "subtasks",
]);
const ALLOWED_SUBTASK_KEYS: ReadonlySet<string> = new Set([
  "content",
  "activeForm",
  "status",
]);
const ALLOWED_STATUSES: ReadonlySet<TodoStatus> = new Set([
  "pending",
  "in_progress",
  "completed",
]);

function validateTaskListSubtask(
  value: unknown,
  taskIndex: number,
  subtaskIndex: number,
): TaskListSubtask {
  const path = `tasks[${taskIndex}].subtasks[${subtaskIndex}]`;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TodoValidationError(`${path} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!ALLOWED_SUBTASK_KEYS.has(key)) {
      throw new TodoValidationError(
        `${path}: unknown field "${key}" (allowed: content, activeForm, status)`,
      );
    }
  }
  const subtask = value as {
    content?: unknown;
    activeForm?: unknown;
    status?: unknown;
  };
  if (typeof subtask.content !== "string" || subtask.content.length === 0) {
    throw new TodoValidationError(`${path}.content must be a non-empty string`);
  }
  if (
    subtask.activeForm !== undefined
    && (typeof subtask.activeForm !== "string" || subtask.activeForm.length === 0)
  ) {
    throw new TodoValidationError(`${path}.activeForm must be a non-empty string when provided`);
  }
  if (typeof subtask.status !== "string" || !ALLOWED_STATUSES.has(subtask.status as TodoStatus)) {
    throw new TodoValidationError(
      `${path}.status must be one of pending|in_progress|completed (got: ${String(subtask.status)})`,
    );
  }
  return {
    content: subtask.content,
    ...(subtask.activeForm !== undefined ? { activeForm: subtask.activeForm } : {}),
    status: subtask.status as TodoStatus,
  };
}

function validateTaskListItem(value: unknown, index: number): TaskListItem {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TodoValidationError(`tasks[${index}] must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!ALLOWED_ITEM_KEYS.has(key)) {
      throw new TodoValidationError(
        `tasks[${index}]: unknown field "${key}" (allowed: content, activeForm, status, subtasks)`,
      );
    }
  }
  const item = value as {
    content?: unknown;
    activeForm?: unknown;
    status?: unknown;
    subtasks?: unknown;
  };
  if (typeof item.content !== "string" || item.content.length === 0) {
    throw new TodoValidationError(
      `tasks[${index}].content must be a non-empty string`,
    );
  }
  if (typeof item.activeForm !== "string" || item.activeForm.length === 0) {
    throw new TodoValidationError(
      `tasks[${index}].activeForm must be a non-empty string`,
    );
  }
  if (typeof item.status !== "string" || !ALLOWED_STATUSES.has(item.status as TodoStatus)) {
    throw new TodoValidationError(
      `tasks[${index}].status must be one of pending|in_progress|completed (got: ${String(item.status)})`,
    );
  }
  let subtasks: TaskListSubtask[] | undefined;
  if (item.subtasks !== undefined) {
    if (!Array.isArray(item.subtasks)) {
      throw new TodoValidationError(`tasks[${index}].subtasks must be an array`);
    }
    subtasks = item.subtasks.map((subtask, subtaskIndex) =>
      validateTaskListSubtask(subtask, index, subtaskIndex),
    );
  }
  return {
    content: item.content,
    activeForm: item.activeForm,
    status: item.status as TodoStatus,
    ...(subtasks && subtasks.length > 0 ? { subtasks } : {}),
  };
}

export function validateTodoParams(params: unknown): { tasks: TaskListItem[] } {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new TodoValidationError("params must be an object");
  }
  for (const key of Object.keys(params)) {
    if (!ALLOWED_TOP_KEYS.has(key)) {
      throw new TodoValidationError(
        `unknown parameter "${key}" (allowed: tasks)`,
      );
    }
  }
  const candidate = params as { tasks?: unknown };
  if (!Array.isArray(candidate.tasks)) {
    throw new TodoValidationError("tasks must be an array");
  }
  const tasks: TaskListItem[] = [];
  for (let i = 0; i < candidate.tasks.length; i += 1) {
    tasks.push(validateTaskListItem(candidate.tasks[i], i));
  }
  return { tasks };
}

// ---------------------------------------------------------------------------
// Description / prompt copy
// ---------------------------------------------------------------------------

export const TASK_LIST_DESCRIPTION = `Manage a session-local todo list.

Use \`task_list\` to plan and track multi-step work within the current Pi
session. Each call submits the complete list — what you send becomes the
new list (whole-list replacement, no merge).

## Item shape

Every item has three required fields and one optional child-list field:

- \`content\` — the imperative form, e.g. \`"Run the gate"\`.
- \`activeForm\` — the present-continuous form shown while the item is
  in progress, e.g. \`"Running the gate"\`.
- \`status\` — one of: pending | in_progress | completed.
- \`subtasks\` — optional child todos. Each subtask has \`content\`, optional
  \`activeForm\`, and \`status\`; subtasks are rendered indented below their
  parent.

## Usage cues

- Mark an item \`in_progress\` when you start it, and \`completed\` the moment
  you finish so the pinned widget reflects reality.
- Use \`subtasks\` for real child work; do not encode subtasks in \`content\`
  text such as \`"parent — subtask: child"\`.
- Advance subtask \`status\` the same way: mark a subtask \`in_progress\` when
  you start it and \`completed\` the moment it is done. Otherwise subtasks
  sit at \`pending\` and the pinned widget cannot show which child step is
  currently being worked on.
- Keep at most one item \`in_progress\` at a time. This is advisory guidance,
  not enforced: lists with multiple \`in_progress\` items are still accepted.
- Update task status in real time as work progresses: mark the current task
  \`in_progress\` before beginning that step, and mark it \`completed\`
  immediately after finishing. Do not batch status updates at the end.
- Use the list proactively for complex work (roughly three or more distinct
  steps), multiple user requirements, or new instructions that change the
  plan. Skip it for single trivial actions or purely informational answers.
- Only mark a task \`completed\` when the work is fully done. If tests fail,
  verification is missing, implementation is partial, or required files /
  dependencies cannot be found, keep the task active or add a blocking
  follow-up instead.
- When the entire submitted list is \`completed\`, the stored list is cleared
  on the next call; the tool result still echoes the list you submitted.
- Do not submit \`tasks: []\` unless the user explicitly asks to clear the
  todo list; empty-list submission persists an empty list immediately.

## State scope

The list is scoped to the current Pi session. It is persisted on the
session log and does not survive across sessions or coordinate with other
agents.
`;

export const TASK_LIST_PROMPT_GUIDELINES = [
  "Use task_list to plan and track multi-step work in the current session: complex work with roughly three or more distinct steps, multiple user requirements, explicit todo-list requests, or new instructions that change the plan. Skip it for single trivial actions or purely informational answers.",
  "Submit the full list every call (whole-list replacement). Each item must include content (imperative), activeForm (present-continuous), and status (pending|in_progress|completed); items may include subtasks with content, optional activeForm, and status.",
  "Use subtasks for real child work; do not encode subtasks in content text such as 'parent — subtask: child'.",
  "Do not submit `tasks: []` unless the user explicitly asks to clear the task_list; empty-list submission persists an empty list immediately.",
  "Mark items in_progress before starting that work and completed immediately after finishing it; do not batch completions at the end. Keep at most one item in_progress at a time.",
  "Advance subtask status the same way as top-level items: mark each subtask in_progress when you start it and completed when it is done, so the pinned widget shows which child step is currently being worked on.",
  "Only mark a task completed when it is fully accomplished. If tests fail, verification is missing, implementation is partial, or required files/dependencies cannot be found, keep the task active or add a blocking follow-up instead.",
  "Before sending a final response after using task_list, update task_list first: if the final response completes the active work, submit the full list with that item marked completed; do not leave an item in_progress unless the response is explicitly an interim/status update that says what remains.",
] as const;

export const TASK_LIST_PROMPT_SNIPPET = "Plan and track work as a session-local todo list";
