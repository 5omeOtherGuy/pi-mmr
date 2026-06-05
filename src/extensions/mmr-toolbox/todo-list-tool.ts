/**
 * Pi tool registration for the session-local `task_list` todo list.
 *
 * Persistence is via the active Pi session log: each accepted call appends
 * one `mmr-toolbox.todo-state` `CustomEntry` carrying the full submitted
 * list, and reads use `findLatestPersistedTodoState(...)` to recover the
 * most recent valid entry. There is no workspace store, no claim/lease,
 * and no cross-session coordination — those concerns are parked on
 * `archive/task-list-coordination-prototype-v1` for the future Task agent.
 *
 * Invariants:
 *
 * - Schema is strict: `{ tasks: [{ content, activeForm, status, subtasks? }] }`.
 *   Defense-in-depth `validateTodoParams` mirrors the TypeBox declaration
 *   inside `execute` because tests (and any host that skips Pi's schema
 *   validator) reach execute with raw params.
 * - Whole-list replacement. The submitted list becomes the new list; items
 *   omitted from the new submission disappear.
 * - When every submitted item has status `completed`, the *stored* list is
 *   cleared to `[]` immediately. The tool result still echoes the submitted
 *   list and surfaces `details.allCompleted: true` so callers/UI can react.
 * - Only one item should be `in_progress` at a time — documented contract,
 *   not enforced by this tool.
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
  findLatestPersistedTodoState,
  toPersistedTodoState,
  TODO_STATE_ENTRY,
  type TaskListItem,
  type TaskListSubtask,
  type TodoStatus,
} from "./todo-list.js";

// ---------------------------------------------------------------------------
// Persistent UI widget
// ---------------------------------------------------------------------------

/**
 * Stable widget id used with `ctx.ui.setWidget(...)` so the active task
 * list is pinned above the input editor. Process-wide unique to
 * mmr-toolbox so other extensions never accidentally clobber it.
 */
export const TASK_LIST_WIDGET_ID = "pi-mmr-task-list";

/** Cap the pinned widget so a long backlog does not push the editor off-screen. */
const TASK_LIST_WIDGET_MAX_ROWS = 12;

interface WidgetThemeLike {
  fg(name: string, value: string): string;
  bold(value: string): string;
}
type WidgetFactory = (tui: unknown, theme: WidgetThemeLike) => {
  render(width: number): string[];
  invalidate(): void;
};

/**
 * Clip each rendered widget line to the TUI render width so a long todo
 * `content` (or `activeForm`) cannot overflow the editor frame or crash Pi
 * during startup hydration. Mirrors the same helper in the archived
 * task-list widget renderer (`fix(task-list): truncate pinned widget rows`).
 */
function truncateWidgetLines(lines: readonly string[], width: number): string[] {
  // Tests and older harnesses may invoke render() without the TUI width. In
  // that case preserve the existing output shape; real Pi TUI render calls
  // always pass a finite terminal width, and every returned line must fit it.
  if (!Number.isFinite(width)) return [...lines];
  if (width <= 0) return lines.map(() => "");
  return lines.map((line) =>
    visibleWidth(line) > width ? truncateToWidth(line, width) : line,
  );
}
interface WidgetUILike {
  setWidget(
    id: string,
    value: readonly string[] | WidgetFactory | undefined,
  ): void;
  theme?: WidgetThemeLike;
}
interface WidgetCtxLike {
  hasUI?: boolean;
  /**
   * Pi 0.78+ run mode (`"tui" | "rpc" | "json" | "print"`). Read as an
   * optional string so the toolbox compiles and runs against both the
   * 0.77 context (no `mode`) and 0.78+ contexts within our supported peer
   * range. See {@link isTuiWidgetSurface}.
   */
  mode?: string;
  ui?: WidgetUILike;
}

/**
 * Whether `ctx` is a terminal UI that can host Pi's pinned custom widget.
 *
 * The task-list widget is a TUI-only custom component: Pi's RPC surface
 * ignores widget factory functions, and Pi's guidance is to guard
 * terminal-only components with `mode === "tui"`. We feature-detect `mode`
 * so this stays correct across our `>=0.77.0 <0.79.0` peer range:
 * - 0.78+: gate strictly on `mode === "tui"` (so RPC/JSON/print get no
 *   widget traffic, not even clear-only calls).
 * - 0.77 (no `mode`): fall back to the previous `hasUI` behavior so
 *   existing terminal sessions still render the widget unchanged.
 */
export function isTuiWidgetSurface(ctx: WidgetCtxLike | undefined): boolean {
  if (!ctx?.ui) return false;
  if (typeof ctx.mode === "string") return ctx.mode === "tui";
  return ctx.hasUI === true;
}

function widgetStatusGlyph(status: TodoStatus): string {
  switch (status) {
    case "in_progress":
      return "◐";
    case "pending":
      return "○";
    case "completed":
      return "●";
  }
}

function taskLabel(task: TaskListItem): string {
  return task.status === "in_progress" ? task.activeForm : task.content;
}

function subtaskLabel(subtask: TaskListSubtask): string {
  return subtask.status === "in_progress"
    ? (subtask.activeForm ?? subtask.content)
    : subtask.content;
}

function renderTaskLines(
  tasks: readonly TaskListItem[],
  formatLine: (status: TodoStatus, text: string) => string,
): string[] {
  const lines: string[] = [];
  for (const task of tasks) {
    lines.push(formatLine(task.status, `${statusGlyph(task.status)} ${taskLabel(task)}`));
    const subtasks = task.subtasks ?? [];
    for (let i = 0; i < subtasks.length; i += 1) {
      const subtask = subtasks[i];
      const branch = i === subtasks.length - 1 ? "└─" : "├─";
      lines.push(
        formatLine(
          subtask.status,
          `  ${branch} ${statusGlyph(subtask.status)} ${subtaskLabel(subtask)}`,
        ),
      );
    }
  }
  return lines;
}

function renderTodoWidgetLines(
  tasks: readonly TaskListItem[],
  theme: WidgetThemeLike | undefined,
): string[] {
  const safeFg = (name: string, value: string): string => {
    if (!theme) return value;
    try {
      return theme.fg(name, value);
    } catch {
      return value;
    }
  };
  const safeBold = (value: string): string => {
    if (!theme) return value;
    try {
      return theme.bold(value);
    } catch {
      return value;
    }
  };

  // Preserve submission order: the model's ordering is the source of truth
  // for display, and the widget mirrors that.
  const taskLines = renderTaskLines(tasks, (status, text) => {
    const glyph = statusGlyph(status);
    const coloredGlyph = status === "in_progress"
      ? safeFg("warning", glyph)
      : safeFg("muted", glyph);
    const line = text.replace(glyph, coloredGlyph);
    return status === "completed" ? safeFg("muted", line) : line;
  });
  const visible = taskLines.slice(0, TASK_LIST_WIDGET_MAX_ROWS);
  const remaining = taskLines.length - visible.length;

  const lines: string[] = [safeFg("accent", safeBold("Tasks"))];
  lines.push(...visible);
  if (remaining > 0) {
    lines.push(safeFg("dim", `… ${remaining} more`));
  }
  return lines;
}

export interface RefreshTodoWidgetOptions {
  /** When this returns true, the refresh is a no-op. */
  isHidden?: () => boolean;
}

/**
 * Project the current session-local todo list onto Pi's persistent widget.
 * Non-TUI surfaces are no-ops (see {@link isTuiWidgetSurface}); the widget
 * is a UI mirror of the just-persisted session entry, not a state source.
 */
export function refreshTodoWidget(
  ctx: WidgetCtxLike | undefined,
  tasks: readonly TaskListItem[],
  options: RefreshTodoWidgetOptions = {},
): void {
  if (!isTuiWidgetSurface(ctx) || !ctx?.ui) return;
  if (options.isHidden?.()) return;
  try {
    if (tasks.length === 0) {
      ctx.ui.setWidget(TASK_LIST_WIDGET_ID, undefined);
      return;
    }
    // Factory form: Pi re-invokes the factory when the active theme
    // changes so the pinned widget recolors with the rest of the UI.
    const snapshot = tasks.map((task) => ({ ...task }));
    ctx.ui.setWidget(TASK_LIST_WIDGET_ID, (_tui, theme) => ({
      render: (width) => truncateWidgetLines(renderTodoWidgetLines(snapshot, theme), width),
      invalidate: () => {},
    }));
  } catch {
    // Best-effort: a render/setWidget failure must never demote a
    // successful tool call to an error result.
  }
}

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

type TaskListParams = Static<typeof TASK_LIST_PARAMS>;

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

function validateTodoParams(params: unknown): { tasks: TaskListItem[] } {
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
- Keep at most one item \`in_progress\` at a time.
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

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export interface TodoListDetails {
  oldTasks: TaskListItem[];
  newTasks: TaskListItem[];
  allCompleted: boolean;
  verificationNudgeNeeded?: boolean;
}

export interface TodoListErrorDetails {
  error: string;
}

function statusGlyph(status: TodoStatus): string {
  return widgetStatusGlyph(status);
}

function formatTaskVisibleLine(task: TaskListItem): string {
  return renderTaskLines([task], (_status, text) => text).join("\n");
}

const PREVIOUS_LIST_VISIBLE_LIMIT = 5;

function formatPreviousListLines(tasks: readonly TaskListItem[]): string[] {
  if (tasks.length === 0) return [];
  const visible = tasks.slice(0, PREVIOUS_LIST_VISIBLE_LIMIT);
  const remaining = tasks.length - visible.length;
  const lines = [
    `Previous list (${tasks.length} item(s)):`,
    ...visible.flatMap((task) => formatTaskVisibleLine(task).split("\n")),
  ];
  if (remaining > 0) {
    lines.push(`… ${remaining} more previous item(s)`);
  }
  return lines;
}

function formatVisibleText(details: TodoListDetails): string {
  const previousLines = formatPreviousListLines(details.oldTasks);
  const withPrevious = (lines: string[]): string => {
    if (previousLines.length === 0) return lines.join("\n");
    return [...lines, "", ...previousLines].join("\n");
  };

  if (details.newTasks.length === 0) {
    return withPrevious(["Todo list cleared."]);
  }
  if (details.allCompleted) {
    return withPrevious([
      `All ${details.newTasks.length} item(s) completed. Todo list cleared.`,
    ]);
  }
  const lines = renderTaskLines(details.newTasks, (_status, text) => text);
  return withPrevious([`${details.newTasks.length} item(s):`, ...lines]);
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export interface CreateTodoListToolOptions {
  /** Pi extension API. Captured so execute() can call `pi.appendEntry(...)`. */
  pi: ExtensionAPI;
  /** Optional hook used by wiring to reset stale-update reminder counters. */
  onAcceptedWrite?: () => void;
  /**
   * Optional predicate invoked before each post-action widget refresh. When
   * it returns true the refresh is suppressed, so a hidden widget stays
   * hidden across subsequent mutations. Mutations themselves are not
   * affected — only the UI projection is.
   */
  getIsHidden?: () => boolean;
}

interface SessionEntriesLike {
  getEntries?(): readonly unknown[];
}

interface ToolCtxLike extends WidgetCtxLike {
  sessionManager?: SessionEntriesLike;
}

function readOldTasks(ctx: ToolCtxLike | undefined): TaskListItem[] {
  try {
    const getEntries = ctx?.sessionManager?.getEntries;
    if (typeof getEntries !== "function") return [];
    const entries = getEntries.call(ctx?.sessionManager);
    if (!Array.isArray(entries)) return [];
    const latest = findLatestPersistedTodoState(entries);
    return latest ? latest.tasks.slice() : [];
  } catch {
    return [];
  }
}

function isAllCompleted(tasks: readonly TaskListItem[]): boolean {
  return tasks.length > 0 && tasks.every((t) => t.status === "completed");
}

const VERIFICATION_TASK_PATTERN = /verif|test|check|lint|typecheck|(?:run|npm run|pnpm run|yarn)\s+build|build\s+check/i;

function taskLooksLikeVerification(task: TaskListItem): boolean {
  if (VERIFICATION_TASK_PATTERN.test(task.content)) return true;
  if (VERIFICATION_TASK_PATTERN.test(task.activeForm)) return true;
  return (task.subtasks ?? []).some((subtask) =>
    VERIFICATION_TASK_PATTERN.test(subtask.content)
    || (subtask.activeForm !== undefined
      && VERIFICATION_TASK_PATTERN.test(subtask.activeForm)),
  );
}

function needsVerificationNudge(
  tasks: readonly TaskListItem[],
  allCompleted: boolean,
): boolean {
  return allCompleted && tasks.length >= 3 && !tasks.some(taskLooksLikeVerification);
}

export function createTodoListTool(
  options: CreateTodoListToolOptions,
): ToolDefinition<typeof TASK_LIST_PARAMS> {
  const { pi, onAcceptedWrite } = options;
  const refreshOpts: RefreshTodoWidgetOptions = options.getIsHidden
    ? { isHidden: options.getIsHidden }
    : {};
  return {
    name: "task_list",
    label: "task_list",
    description: TASK_LIST_DESCRIPTION,
    promptSnippet: TASK_LIST_PROMPT_SNIPPET,
    promptGuidelines: [...TASK_LIST_PROMPT_GUIDELINES],
    parameters: TASK_LIST_PARAMS,
    // Session-state-mutating tool: whole-list replacement means two
    // concurrent task_list calls in one assistant turn would race the
    // stored list, so force sequential scheduling.
    executionMode: "sequential",
    async execute(_toolCallId, params: TaskListParams, _signal, _onUpdate, ctx) {
      // Defense-in-depth validation: TypeBox declares the shape for Pi's
      // host validator, but tests and any host that skips schema validation
      // hit execute() with raw params. Re-validate before persisting.
      let validated: { tasks: TaskListItem[] };
      try {
        validated = validateTodoParams(params);
      } catch (err) {
        if ((err as { name?: string } | null)?.name === "TodoValidationError") {
          const message = (err as Error).message;
          const errorDetails: TodoListErrorDetails = { error: message };
          return {
            isError: true,
            content: [{ type: "text", text: `task_list rejected: ${message}` }],
            details: errorDetails,
          };
        }
        throw err;
      }

      const submitted = validated.tasks;
      const oldTasks = readOldTasks(ctx as ToolCtxLike | undefined);
      const allCompleted = isAllCompleted(submitted);
      const verificationNudgeNeeded = needsVerificationNudge(submitted, allCompleted);
      // All-completed submission clears the stored list immediately; the
      // result still echoes the submitted list so the model sees what it
      // sent.
      const persisted: TaskListItem[] = allCompleted ? [] : submitted;

      // Persist via pi.appendEntry. Errors here propagate: a persistence
      // failure is not a user-correctable validation issue, so Pi should
      // surface it as a tool crash rather than a silent isError result.
      pi.appendEntry(TODO_STATE_ENTRY, toPersistedTodoState(persisted));

      onAcceptedWrite?.();
      refreshTodoWidget(ctx as ToolCtxLike | undefined, persisted, refreshOpts);

      const details: TodoListDetails = {
        oldTasks,
        newTasks: submitted,
        allCompleted,
        ...(verificationNudgeNeeded ? { verificationNudgeNeeded } : {}),
      };
      const text = [
        formatVisibleText(details),
        "Continue updating task_list as work progresses.",
        ...(verificationNudgeNeeded
          ? [
              "Reminder: this closed a 3+ item task_list without an explicit verification/check step. Before the final response, run or report the strongest practical verification.",
            ]
          : []),
      ].join("\n\n");
      return {
        content: [{ type: "text", text }],
        details,
      };
    },
    renderCall(args, theme) {
      const count = Array.isArray((args as { tasks?: unknown[] } | undefined)?.tasks)
        ? ((args as { tasks: unknown[] }).tasks.length)
        : 0;
      let head: string;
      try {
        head = theme.fg("toolTitle", theme.bold("Todo List"));
      } catch {
        head = "Todo List";
      }
      const tail = ` (${count} item${count === 1 ? "" : "s"})`;
      return new Text(`${head}${tail}`, 1, 0);
    },
    renderResult(result, _options, theme, context) {
      const safeFg = (name: "accent" | "muted" | "error", value: string): string => {
        try {
          return theme.fg(name, value);
        } catch {
          return value;
        }
      };
      if (context.isError) {
        const details = result.details as TodoListErrorDetails | undefined;
        const message = details?.error
          ?? result.content
            .map((c) => (c.type === "text" && c.text ? c.text : ""))
            .filter(Boolean)
            .join("\n");
        return new Text(safeFg("error", message), 1, 0);
      }
      const details = result.details as TodoListDetails | undefined;
      if (!details) {
        return new Text(
          result.content
            .map((c) => (c.type === "text" && c.text ? c.text : ""))
            .filter(Boolean)
            .join("\n"),
          1,
          0,
        );
      }
      const previousRows = formatPreviousListLines(details.oldTasks);
      const appendPreviousRows = (rows: string[]): string[] => {
        if (previousRows.length === 0) return rows;
        return [...rows, "", ...previousRows.map((line) => safeFg("muted", line))];
      };
      if (details.newTasks.length === 0) {
        return new Text(
          appendPreviousRows([safeFg("muted", "Todo list cleared.")]).join("\n"),
          1,
          0,
        );
      }
      const rows = renderTaskLines(details.newTasks, (status, text) =>
        status === "completed" ? safeFg("muted", text) : text,
      );
      if (details.allCompleted) {
        rows.push(safeFg("muted", "(all completed — stored list cleared)"));
      }
      return new Text(appendPreviousRows(rows).join("\n"), 1, 0);
    },
  } satisfies ToolDefinition<typeof TASK_LIST_PARAMS>;
}
