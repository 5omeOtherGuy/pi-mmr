/**
 * Pi TUI pinned widget for the session-local `task_list` todo list.
 *
 * Extracted from `todo-list-tool.ts` as a focused leaf module. Renders the
 * active list above the input editor, animating `in_progress` rows with Pi's
 * native braille loader cadence. Imports the shared static line/glyph helpers
 * from `todo-list-rendering.ts`; the widget glyphs, spinner frames, and row
 * layout are behavior and must not change.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  PI_LOADER_FRAMES,
  renderTaskLines,
  statusGlyph,
} from "./todo-list-rendering.js";
import type { TaskListItem, TodoStatus } from "./todo-list.js";

/**
 * Stable widget id used with `ctx.ui.setWidget(...)` so the active task
 * list is pinned above the input editor. Process-wide unique to
 * mmr-toolbox so other extensions never accidentally clobber it.
 */
export const TASK_LIST_WIDGET_ID = "pi-mmr-task-list";

/** Cap the pinned widget so a long backlog does not push the editor off-screen. */
const TASK_LIST_WIDGET_MAX_ROWS = 12;

/** Frame interval matching Pi's native loader cadence. */
const PI_LOADER_INTERVAL_MS = 80;

interface WidgetThemeLike {
  fg(name: string, value: string): string;
  bold(value: string): string;
}
/** Minimal view of the live Pi TUI the widget factory needs to animate. */
interface WidgetTuiLike {
  requestRender?(force?: boolean): void;
}
type WidgetFactory = (tui: WidgetTuiLike, theme: WidgetThemeLike) => {
  render(width: number): string[];
  invalidate(): void;
  dispose?(): void;
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
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  theme?: WidgetThemeLike;
}
export interface WidgetCtxLike {
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

function renderTodoWidgetLines(
  tasks: readonly TaskListItem[],
  theme: WidgetThemeLike | undefined,
  activeFrame?: string,
): string[] {
  const safeFg = (name: string, value: string): string => {
    if (!theme) return value;
    try {
      return theme.fg(name, value);
    } catch {
      return value;
    }
  };
  // Preserve submission order: the model's ordering is the source of truth
  // for display, and the widget mirrors that. While a row is in_progress the
  // glyph is the live braille loader frame so it matches Pi's working
  // indicator; resting frames fall back to the static glyph.
  const glyphFor = (status: TodoStatus): string =>
    status === "in_progress" && activeFrame ? activeFrame : statusGlyph(status);
  const taskLines = renderTaskLines(
    tasks,
    (status, text) => {
      const glyph = glyphFor(status);
      const coloredGlyph = status === "in_progress"
        ? safeFg("warning", glyph)
        : safeFg("muted", glyph);
      const line = text.replace(glyph, coloredGlyph);
      return status === "completed" ? safeFg("muted", line) : line;
    },
    glyphFor,
  );
  const visible = taskLines.slice(0, TASK_LIST_WIDGET_MAX_ROWS);
  const remaining = taskLines.length - visible.length;

  const lines: string[] = [...visible];
  if (remaining > 0) {
    lines.push(safeFg("dim", `… ${remaining} more`));
  }
  return lines;
}

/**
 * Whether an in_progress row falls within the first `maxRows` flattened
 * (task + subtask) lines — i.e. the rows the widget actually shows before the
 * `… N more` overflow marker. The animation interval is gated on this so an
 * in_progress row hidden beyond the cap never schedules re-renders that would
 * not change the visible output. Mirrors `renderTaskLines`' flattening order.
 */
function hasVisibleInProgress(tasks: readonly TaskListItem[], maxRows: number): boolean {
  let row = 0;
  for (const task of tasks) {
    if (row >= maxRows) return false;
    if (task.status === "in_progress") return true;
    row += 1;
    for (const subtask of task.subtasks ?? []) {
      if (row >= maxRows) return false;
      if (subtask.status === "in_progress") return true;
      row += 1;
    }
  }
  return false;
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
      ctx.ui.setWidget(TASK_LIST_WIDGET_ID, undefined, { placement: "aboveEditor" });
      return;
    }
    // Factory form: the captured `theme` is Pi's live theme singleton, so the
    // widget recolors on theme change (Pi invalidates + re-renders without
    // re-invoking the factory). Deep-copy subtasks so later mutations to the
    // caller's array cannot bleed into the pinned snapshot.
    const snapshot = tasks.map((task) => ({
      ...task,
      subtasks: task.subtasks?.map((subtask) => ({ ...subtask })),
    }));
    const hasActive = hasVisibleInProgress(snapshot, TASK_LIST_WIDGET_MAX_ROWS);
    ctx.ui.setWidget(TASK_LIST_WIDGET_ID, (tui, theme) => {
      // Animate in_progress rows with Pi's loader cadence. The interval only
      // runs while at least one row is in_progress, so a resting list never
      // schedules needless re-renders. Pi disposes the previous component on
      // replacement/clear, which clears this timer.
      let frame = 0;
      let timer: ReturnType<typeof setInterval> | undefined;
      if (hasActive && typeof tui?.requestRender === "function") {
        timer = setInterval(() => {
          frame = (frame + 1) % PI_LOADER_FRAMES.length;
          try {
            tui.requestRender?.();
          } catch {
            // A throwing requestRender must not let an uncaught exception escape
            // the timer callback; stop animating instead.
            if (timer !== undefined) {
              clearInterval(timer);
              timer = undefined;
            }
          }
        }, PI_LOADER_INTERVAL_MS);
        // Never keep the Node event loop alive solely for the spinner.
        (timer as { unref?: () => void }).unref?.();
      }
      return {
        render: (width) =>
          truncateWidgetLines(
            renderTodoWidgetLines(
              snapshot,
              theme,
              hasActive ? PI_LOADER_FRAMES[frame] : undefined,
            ),
            width,
          ),
        invalidate: () => {},
        dispose: () => {
          if (timer !== undefined) {
            clearInterval(timer);
            timer = undefined;
          }
        },
      };
    }, { placement: "aboveEditor" });
  } catch {
    // Best-effort: a render/setWidget failure must never demote a
    // successful tool call to an error result.
  }
}
