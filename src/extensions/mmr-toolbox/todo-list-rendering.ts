/**
 * Shared static line/glyph helpers and result-visible text formatting for the
 * session-local `task_list` todo tool.
 *
 * Extracted from `todo-list-tool.ts` as a focused leaf module. These helpers
 * are shared by the pinned widget (`todo-list-widget.ts`), the model-visible
 * tool result text, and the TUI `renderResult` path, so they live in the
 * lowest module: the widget imports from here, not the other way around. The
 * glyph language and result text are behavior and must not change.
 */

import type { TaskListItem, TaskListSubtask, TodoStatus } from "./todo-list.js";

/**
 * Pi's native streaming loader frames (see `@earendil-works/pi-tui` `Loader`).
 * Mirrored here so the pinned task-list widget animates `in_progress` rows
 * with the same braille spinner the rest of Pi uses, instead of a static
 * glyph. Public-safe constant; pi-tui does not export its frame array. Shared
 * with `todo-list-widget.ts` (animation) and the static `statusGlyph` below
 * (resting `in_progress` frame), so it lives in this lower module to keep the
 * import graph acyclic.
 */
export const PI_LOADER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;

// Static, Pi-native status glyphs. `in_progress` resolves to the first loader
// frame for non-animated surfaces (model-visible tool result text and the
// resting widget frame); the live widget overrides it with the current
// braille frame. Aligns the task list with Pi's working indicator instead of
// the previous checkbox-like round glyphs.
function widgetStatusGlyph(status: TodoStatus): string {
  switch (status) {
    case "in_progress":
      return PI_LOADER_FRAMES[0];
    case "pending":
      return "–";
    case "completed":
      return "✓";
  }
}

export function taskLabel(task: TaskListItem): string {
  return task.status === "in_progress" ? task.activeForm : task.content;
}

export function subtaskLabel(subtask: TaskListSubtask): string {
  return subtask.status === "in_progress"
    ? (subtask.activeForm ?? subtask.content)
    : subtask.content;
}

export function statusGlyph(status: TodoStatus): string {
  return widgetStatusGlyph(status);
}

/**
 * Canonical static status glyph shared with secondary task-list surfaces
 * (slash-command output, injected context block) so every place renders the
 * same Pi-native glyph language.
 */
export { statusGlyph as taskStatusGlyph };

export function renderTaskLines(
  tasks: readonly TaskListItem[],
  formatLine: (status: TodoStatus, text: string) => string,
  glyphFor: (status: TodoStatus) => string = statusGlyph,
): string[] {
  const lines: string[] = [];
  for (const task of tasks) {
    lines.push(formatLine(task.status, `${glyphFor(task.status)} ${taskLabel(task)}`));
    const subtasks = task.subtasks ?? [];
    for (let i = 0; i < subtasks.length; i += 1) {
      const subtask = subtasks[i];
      const branch = i === subtasks.length - 1 ? "└─" : "├─";
      lines.push(
        formatLine(
          subtask.status,
          `  ${branch} ${glyphFor(subtask.status)} ${subtaskLabel(subtask)}`,
        ),
      );
    }
  }
  return lines;
}

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

function formatTaskVisibleLine(task: TaskListItem): string {
  return renderTaskLines([task], (_status, text) => text).join("\n");
}

const PREVIOUS_LIST_VISIBLE_LIMIT = 5;

export function formatPreviousListLines(tasks: readonly TaskListItem[]): string[] {
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

export function formatVisibleText(details: TodoListDetails): string {
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
