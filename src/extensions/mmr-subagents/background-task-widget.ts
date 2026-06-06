/**
 * Persistent bottom-of-window widget for async background subagents.
 *
 * The async task tools (`start_task` / `task_poll` / `task_wait` /
 * `task_cancel`) register a background run in the in-memory registry and
 * return immediately. Their per-call transcript output is intentionally
 * minimal; the live, at-a-glance state of every background agent is shown
 * here instead — pinned above the editor with `ctx.ui.setWidget(...)`, the
 * same surface the `task_list` todo widget uses.
 *
 * This keeps background agents off the transcript as repeated cards (a raw
 * `task_<id>` per launch) and gives them one animated status board, mirroring
 * how Pi's working indicator / task list communicate in-flight work. The
 * widget is a pure UI mirror of the registry board; it owns no state.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { MmrAsyncTaskBoard, MmrAsyncTaskBoardEntry } from "./async-task-registry.js";

/**
 * Stable widget id used with `ctx.ui.setWidget(...)`. Process-wide unique to
 * mmr-subagents so it never collides with the mmr-toolbox task-list widget.
 */
export const BACKGROUND_TASK_WIDGET_ID = "pi-mmr-background-tasks";

/** Cap visible rows so a long backlog never pushes the editor off-screen. */
const WIDGET_MAX_ROWS = 8;

/**
 * Pi's native streaming loader frames (see `@earendil-works/pi-tui` `Loader`).
 * Mirrored here so running background agents animate with the same braille
 * spinner the rest of Pi uses. Public-safe constant; pi-tui does not export
 * its frame array. Matches the mmr-toolbox task-list widget cadence.
 */
const PI_LOADER_FRAMES = [
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

interface WidgetUILike {
  setWidget(
    id: string,
    value: readonly string[] | WidgetFactory | undefined,
  ): void;
  theme?: WidgetThemeLike;
}

interface WidgetCtxLike {
  hasUI?: boolean;
  /** Pi 0.78+ run mode (`"tui" | "rpc" | "json" | "print"`). */
  mode?: string;
  ui?: WidgetUILike;
}

/**
 * Whether `ctx` is a terminal UI that can host Pi's pinned custom widget.
 * Mirrors the mmr-toolbox task-list widget gate so behavior is identical
 * across our `>=0.77.0 <0.79.0` peer range: gate strictly on `mode === "tui"`
 * when `mode` is present (0.78+), else fall back to `hasUI` (0.77).
 */
export function isTuiWidgetSurface(ctx: WidgetCtxLike | undefined): boolean {
  if (!ctx?.ui) return false;
  if (typeof ctx.mode === "string") return ctx.mode === "tui";
  return ctx.hasUI === true;
}

/** A flattened board entry the widget renders, in display order. */
interface WidgetRow {
  status: string;
  freshness: string;
  agent: string;
  description: string;
}

function backgroundStatusColor(status: string): string {
  if (status === "running" || status === "cancelling") return "warning";
  if (status === "succeeded") return "success";
  if (status === "failed") return "error";
  // cancelled / unknown: neutral. A user-initiated cancel is not an error.
  return "muted";
}

/**
 * Static status glyph for a row. Running/cancelling resolve to the first
 * loader frame for the resting frame; the live widget overrides running rows
 * with the current braille frame. ✓ succeeded, ✕ failed, – cancelled.
 */
function backgroundStatusGlyph(status: string, activeFrame?: string): string {
  if (status === "running" || status === "cancelling") {
    return activeFrame ?? PI_LOADER_FRAMES[0];
  }
  if (status === "succeeded") return "✓";
  if (status === "failed") return "✕";
  if (status === "cancelled") return "–";
  return "•";
}

function compactOneLine(value: string, limit: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= limit) return compact;
  return `${compact.slice(0, Math.max(0, limit - 1))}…`;
}

function boardRows(board: MmrAsyncTaskBoard): WidgetRow[] {
  const toRow = (entry: MmrAsyncTaskBoardEntry): WidgetRow => ({
    status: entry.status,
    freshness: entry.freshness,
    agent: entry.agent,
    description: entry.description,
  });
  // Show only in-flight work (active + stalled), mirroring Pi/Claude Code's
  // bottom indicator which surfaces running agents. A finished task drops off
  // the widget; its result is shown by the eventual task_poll/wait card, so a
  // completed agent is never displayed in two places at once.
  return [
    ...board.active.map(toRow),
    ...board.stalled.map(toRow),
  ];
}

function renderRowLine(
  row: WidgetRow,
  theme: WidgetThemeLike | undefined,
  activeFrame: string | undefined,
): string {
  const safeFg = (name: string, value: string): string => {
    if (!theme) return value;
    try {
      return theme.fg(name, value);
    } catch {
      return value;
    }
  };
  const color = backgroundStatusColor(row.status);
  const glyph = safeFg(color, backgroundStatusGlyph(row.status, activeFrame));
  const agent = safeFg("accent", row.agent);
  const desc = row.description
    ? ` ${safeFg("muted", compactOneLine(row.description, 60))}`
    : "";
  const fresh = row.freshness === "stalled" || row.freshness === "dead"
    ? ` ${safeFg(row.freshness === "dead" ? "error" : "warning", `[${row.freshness}]`)}`
    : "";
  return `${glyph} ${agent}${desc}${fresh}`;
}

function renderWidgetLines(
  rows: readonly WidgetRow[],
  theme: WidgetThemeLike | undefined,
  activeFrame: string | undefined,
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
  const visible = rows.slice(0, WIDGET_MAX_ROWS);
  const remaining = rows.length - visible.length;
  const lines: string[] = [safeFg("accent", safeBold("Background agents"))];
  for (const row of visible) lines.push(renderRowLine(row, theme, activeFrame));
  if (remaining > 0) lines.push(safeFg("dim", `… ${remaining} more`));
  return lines;
}

function truncateWidgetLines(lines: readonly string[], width: number): string[] {
  if (!Number.isFinite(width)) return [...lines];
  if (width <= 0) return lines.map(() => "");
  return lines.map((line) =>
    visibleWidth(line) > width ? truncateToWidth(line, width) : line,
  );
}

/**
 * Project the current registry board onto Pi's persistent widget. Non-TUI
 * surfaces are no-ops; the widget is a UI mirror, not a state source. The
 * widget clears itself when no background agents remain.
 */
export function refreshBackgroundTaskWidget(
  ctx: WidgetCtxLike | undefined,
  board: MmrAsyncTaskBoard,
): void {
  if (!isTuiWidgetSurface(ctx) || !ctx?.ui) return;
  try {
    const rows = boardRows(board);
    if (rows.length === 0) {
      ctx.ui.setWidget(BACKGROUND_TASK_WIDGET_ID, undefined);
      return;
    }
    const hasActive = board.active.length > 0 || board.stalled.length > 0;
    ctx.ui.setWidget(BACKGROUND_TASK_WIDGET_ID, (tui, theme) => {
      // Animate running rows with Pi's loader cadence. The interval only runs
      // while at least one row is active/stalled, so a board of only finished
      // rows never schedules needless re-renders. Pi disposes the previous
      // component on replacement/clear, which clears this timer.
      let frame = 0;
      let timer: ReturnType<typeof setInterval> | undefined;
      if (hasActive && typeof tui?.requestRender === "function") {
        timer = setInterval(() => {
          frame = (frame + 1) % PI_LOADER_FRAMES.length;
          try {
            tui.requestRender?.();
          } catch {
            if (timer !== undefined) {
              clearInterval(timer);
              timer = undefined;
            }
          }
        }, PI_LOADER_INTERVAL_MS);
        (timer as { unref?: () => void }).unref?.();
      }
      return {
        render: (width) =>
          truncateWidgetLines(
            renderWidgetLines(rows, theme, hasActive ? PI_LOADER_FRAMES[frame] : undefined),
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
    });
  } catch {
    // Best-effort: a widget failure must never demote a successful tool call.
  }
}
