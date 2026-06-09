/**
 * Pi tool registration for the session-local `task_list` todo list.
 *
 * Persistence is via the active Pi session log: each accepted call appends
 * one `mmr-tasks.todo-state` `CustomEntry` carrying the full submitted
 * list, and reads use `findLatestPersistedTodoState(...)` to recover the
 * most recent valid entry. There is no workspace store, no claim/lease,
 * and no cross-session coordination — those concerns are parked on
 * `archive/task-list-coordination-prototype-v1` for the future Task agent.
 *
 * This entry file is a thin compatibility shell: schema/validation/contract
 * text live in `todo-list-contract.ts`, shared line/glyph helpers and
 * result-visible formatting live in `todo-list-rendering.ts`, and the pinned
 * TUI widget lives in `todo-list-widget.ts`. Every previously-exported symbol
 * is re-exported here so existing importers are unchanged.
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
 * - Only one item should be `in_progress` at a time — advisory contract only,
 *   not enforced by this tool. Lists with multiple `in_progress` items (for
 *   example a parent and a subtask both in progress) are accepted and stored
 *   unchanged; this rule is model guidance, not a validated invariant.
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  findLatestPersistedTodoState,
  toPersistedTodoState,
  TODO_STATE_ENTRY,
  type TaskListItem,
} from "./todo-list.js";
import {
  TASK_LIST_DESCRIPTION,
  TASK_LIST_PARAMS,
  TASK_LIST_PROMPT_GUIDELINES,
  TASK_LIST_PROMPT_SNIPPET,
  validateTodoParams,
  type TaskListParams,
} from "./todo-list-contract.js";
import {
  formatPreviousListLines,
  formatVisibleText,
  renderTaskLines,
  type TodoListDetails,
  type TodoListErrorDetails,
} from "./todo-list-rendering.js";
import {
  refreshTodoWidget,
  type RefreshTodoWidgetOptions,
  type WidgetCtxLike,
} from "./todo-list-widget.js";

// Re-export the moved public surface so existing importers
// (`task-list-wiring.ts`, package root `index.ts`, tests) keep importing
// every symbol through this entry module unchanged.
export {
  TASK_LIST_DESCRIPTION,
  TASK_LIST_PARAMS,
  TASK_LIST_PROMPT_GUIDELINES,
  TASK_LIST_PROMPT_SNIPPET,
  TodoValidationError,
} from "./todo-list-contract.js";
export { taskStatusGlyph } from "./todo-list-rendering.js";
export type {
  TodoListDetails,
  TodoListErrorDetails,
} from "./todo-list-rendering.js";
export {
  isTuiWidgetSurface,
  refreshTodoWidget,
  TASK_LIST_WIDGET_ID,
} from "./todo-list-widget.js";
export type { RefreshTodoWidgetOptions } from "./todo-list-widget.js";

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
