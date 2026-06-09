/**
 * Persistent bottom-of-window widget for async background subagents.
 *
 * The async task tools (`start_task` / `task_poll` / `task_wait` /
 * `task_cancel`) register a background run in the in-memory registry and
 * return immediately. Their per-call transcript output is intentionally
 * minimal; the live, at-a-glance state of every background agent is shown
 * here too — pinned above the editor with `ctx.ui.setWidget(...)`, kept
 * ABOVE the `task_list` todo widget (which also lives above the editor) via
 * {@link reassertLowerAboveEditorWidgets}.
 *
 * The row/header/glyph vocabulary and the loader animation clock live in
 * {@link ./background-task-view.ts}; the inline transcript card renders the
 * SAME rows from there. This module owns only the widget lifecycle: TUI
 * gating, per-group bucketing with a finished-retention window, the visible
 * row cap, and the animation/clear timers. The widget is a pure UI mirror of
 * the registry board; it owns no state.
 */

import { updateAboveEditorDashboardSlot } from "../mmr-core/above-editor-dashboard.js";
import { reassertLowerAboveEditorWidgets } from "../mmr-core/above-editor-order.js";
import type { MmrAsyncTaskBoard } from "./async-task-registry.js";
import {
  advanceLoaderFrame,
  compareRows,
  currentLoaderFrame,
  makeSafeFg,
  PI_LOADER_INTERVAL_MS,
  renderRowLine,
  renderSectionHeader,
  revealedRows,
  synthesizeGroup,
  toRow,
  truncateWidgetLines,
  type BackgroundViewTheme,
  type MmrWidgetGroupResolver,
  type WidgetRow,
  type WidgetSection,
} from "./background-task-view.js";

export type { MmrWidgetGroupResolver } from "./background-task-view.js";

/**
 * Stable widget id used with `ctx.ui.setWidget(...)`. Process-wide unique to
 * mmr-subagents so it never collides with the mmr-toolbox task-list widget.
 */
export const BACKGROUND_TASK_WIDGET_ID = "pi-mmr-background-tasks";

/** Cap visible lines (group headers + rows) so a long backlog never pushes the editor off-screen. */
const WIDGET_MAX_ROWS = 8;

/**
 * How long a finished task lingers in its group section before dropping off the
 * live widget. The registry retains terminal records far longer (for the result
 * card); this is purely the brief "show the wave settle in place" window so a
 * completed group flips to ✓/✕ for a beat before the section disappears. The
 * eventual task_poll/wait card remains the durable record of the outcome.
 */
const WIDGET_FINISHED_RETENTION_MS = 8_000;

/** Minimal view of the live Pi TUI the widget factory needs to animate. */
interface WidgetTuiLike {
  requestRender?(force?: boolean): void;
}

type WidgetFactory = (tui: WidgetTuiLike, theme: BackgroundViewTheme) => {
  render(width: number): string[];
  invalidate(): void;
  dispose?(): void;
};

interface WidgetUILike {
  setWidget(
    id: string,
    value: readonly string[] | WidgetFactory | undefined,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  theme?: BackgroundViewTheme;
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

/**
 * Bucket the board into per-group sections in display order: groups first
 * (earliest-launched group on top, mirroring how parallel waves stack), then a
 * trailing ungrouped bucket. In-flight rows (active + stalled) always show;
 * finished rows show only while within `WIDGET_FINISHED_RETENTION_MS` of
 * completion, so a settled wave lingers briefly in place before dropping.
 */
function boardSections(
  board: MmrAsyncTaskBoard,
  resolveGroup: MmrWidgetGroupResolver | undefined,
  nowMs: number,
): WidgetSection[] {
  const retainedFinished = board.finished.filter(
    (entry) =>
      typeof entry.completedAtMs === "number" &&
      Number.isFinite(entry.completedAtMs) &&
      nowMs - entry.completedAtMs <= WIDGET_FINISHED_RETENTION_MS,
  );
  const entries = [...board.active, ...board.stalled, ...retainedFinished];

  const order: (string | undefined)[] = [];
  const buckets = new Map<string | undefined, WidgetRow[]>();
  for (const entry of entries) {
    const key = entry.groupId;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
      order.push(key);
    }
    bucket.push(toRow(entry, board.generatedAtMs));
  }

  const grouped: { section: WidgetSection; minCreated: number }[] = [];
  let ungrouped: WidgetSection | undefined;
  for (const key of order) {
    const rows = buckets.get(key)!.slice().sort(compareRows);
    if (key === undefined) {
      ungrouped = { groupId: undefined, rows };
      continue;
    }
    const resolved = resolveGroup?.(key);
    const group = resolved
      ? {
          status: resolved.status,
          counts: resolved.counts,
          ...(resolved.label !== undefined ? { label: resolved.label } : {}),
        }
      : synthesizeGroup(rows);
    const minCreated = rows.reduce((min, r) => Math.min(min, r.createdAtMs), Number.POSITIVE_INFINITY);
    grouped.push({ section: { groupId: key, group, rows }, minCreated });
  }
  grouped.sort((a, b) => a.minCreated - b.minCreated);

  const sections = grouped.map((g) => g.section);
  if (ungrouped) sections.push(ungrouped);
  return sections;
}

function finishedOnlyClearDelayMs(board: MmrAsyncTaskBoard): number | undefined {
  const delays = board.finished.flatMap((entry) => {
    if (
      typeof entry.completedAtMs !== "number" ||
      !Number.isFinite(entry.completedAtMs)
    ) {
      return [];
    }
    const remainingMs = entry.completedAtMs + WIDGET_FINISHED_RETENTION_MS - board.generatedAtMs;
    return remainingMs >= 0 ? [remainingMs] : [];
  });
  if (delays.length === 0) return undefined;
  return Math.max(0, Math.min(...delays));
}

/**
 * Stage each section by its reveal cadence (see {@link revealedRows}). `nowMs`
 * is read fresh every frame so the reveal advances on the animation interval. A
 * section that reveals no rows is omitted ENTIRELY (header included) during its
 * prep window; otherwise only the revealed rows render, in section display
 * order. `revealedRows` reveals every row immediately when the section has no
 * active worker (no animation clock is guaranteed to tick it again), so a
 * finished-only section never gets stuck blank. The clear decision and timer
 * selection upstream stay based on the ACTUAL registry rows, never on this
 * staged view, so the animation interval keeps driving frames throughout the
 * reveal.
 */
function revealSections(sections: readonly WidgetSection[], nowMs: number): WidgetSection[] {
  const out: WidgetSection[] = [];
  for (const section of sections) {
    const rows = revealedRows(section.rows, nowMs);
    if (rows.length === 0) continue;
    out.push({ ...section, rows });
  }
  return out;
}

/**
 * Flatten sections into widget lines: each group prints a header then its
 * indented rows. A lone ungrouped section prints headerless and flush-left, so
 * non-grouped Task usage renders exactly as before. `WIDGET_MAX_ROWS` counts
 * headers + rows together and never splits a group across the cut — whole
 * trailing sections drop and collapse into `… N more`.
 */
function renderWidgetLines(
  sections: readonly WidgetSection[],
  theme: BackgroundViewTheme | undefined,
  activeFrame: string | undefined,
): string[] {
  const safeFg = makeSafeFg(theme);
  const hasGroups = sections.some((s) => s.groupId !== undefined);

  // Build each section as a self-contained block of lines so truncation can
  // drop whole sections rather than orphaning rows under a header.
  const blocks = sections.map((section) => {
    const showHeader = section.groupId !== undefined || hasGroups;
    const indent = showHeader ? "  " : "";
    const lines: string[] = [];
    if (showHeader) lines.push(renderSectionHeader(section, theme));
    for (const row of section.rows) lines.push(renderRowLine(row, theme, activeFrame, { indent }));
    return { lines, rowCount: section.rows.length };
  });

  const out: string[] = [];
  let omittedRows = 0;
  let used = 0;
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    const remainingLineTotal = blocks.slice(i).reduce((sum, b) => sum + b.lines.length, 0);
    if (used + remainingLineTotal <= WIDGET_MAX_ROWS) {
      for (let j = i; j < blocks.length; j += 1) out.push(...blocks[j].lines);
      break;
    }

    const reserveOverflowLineLimit = WIDGET_MAX_ROWS - 1;
    if (used + block.lines.length <= reserveOverflowLineLimit) {
      out.push(...block.lines);
      used += block.lines.length;
      continue;
    }

    if (out.length === 0) {
      // First section alone exceeds the cap: show as many of its lines as fit
      // (header + leading rows) while still reserving the final overflow line.
      const slice = block.lines.slice(0, reserveOverflowLineLimit);
      out.push(...slice);
      used += slice.length;
      const shownRows = Math.max(0, slice.length - (block.lines.length - block.rowCount));
      omittedRows += block.rowCount - shownRows;
    } else {
      omittedRows += block.rowCount;
    }
    for (let j = i + 1; j < blocks.length; j += 1) omittedRows += blocks[j].rowCount;
    break;
  }
  if (omittedRows > 0) out.push(safeFg("dim", `… ${omittedRows} more`));
  return out;
}

/**
 * Project the current registry board onto Pi's persistent widget. Non-TUI
 * surfaces are no-ops; the widget is a UI mirror, not a state source. The
 * widget clears itself when no background agents remain.
 */
export function refreshBackgroundTaskWidget(
  ctx: WidgetCtxLike | undefined,
  board: MmrAsyncTaskBoard,
  resolveGroup?: MmrWidgetGroupResolver,
): void {
  if (!isTuiWidgetSurface(ctx) || !ctx?.ui) return;
  try {
    const sections = boardSections(board, resolveGroup, board.generatedAtMs);
    const rowTotal = sections.reduce((sum, s) => sum + s.rows.length, 0);
    if (rowTotal === 0) {
      updateAboveEditorDashboardSlot(ctx, "right", BACKGROUND_TASK_WIDGET_ID, undefined);
      return;
    }
    const hasActive = board.active.length > 0 || board.stalled.length > 0;
    const clearDelayMs = hasActive ? undefined : finishedOnlyClearDelayMs(board);
    updateAboveEditorDashboardSlot(ctx, "right", BACKGROUND_TASK_WIDGET_ID, (tui, theme) => {
      // Animate running rows with Pi's loader cadence by advancing the shared
      // loader frame (read by the inline card too) and re-rendering the whole
      // tree. Finished-only rows use a one-shot clear timer so the drop-off
      // window expires even when no active worker remains to drive future
      // widget refreshes.
      let timer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout> | undefined;
      let timerKind: "interval" | "timeout" | undefined;
      if (hasActive && typeof tui?.requestRender === "function") {
        timerKind = "interval";
        timer = setInterval(() => {
          advanceLoaderFrame();
          try {
            tui.requestRender?.();
          } catch {
            if (timer !== undefined) {
              clearInterval(timer);
              timer = undefined;
              timerKind = undefined;
            }
          }
        }, PI_LOADER_INTERVAL_MS);
        (timer as { unref?: () => void }).unref?.();
      } else if (clearDelayMs !== undefined) {
        timerKind = "timeout";
        timer = setTimeout(() => {
          timer = undefined;
          timerKind = undefined;
          updateAboveEditorDashboardSlot(ctx, "right", BACKGROUND_TASK_WIDGET_ID, undefined);
        }, clearDelayMs);
        (timer as { unref?: () => void }).unref?.();
      }
      return {
        render: (width) =>
          // Read a fresh Date.now() each frame so the staged reveal advances on
          // the animation interval, mirroring currentLoaderFrame()'s clock.
          truncateWidgetLines(
            renderWidgetLines(
              revealSections(sections, Date.now()),
              theme,
              hasActive ? currentLoaderFrame() : undefined,
            ),
            width,
          ),
        invalidate: () => {},
        dispose: () => {
          if (timer !== undefined) {
            if (timerKind === "interval") clearInterval(timer);
            else clearTimeout(timer);
            timer = undefined;
            timerKind = undefined;
          }
        },
      };
    });
    // The background widget must stay ABOVE the task_list widget. Both live in
    // the aboveEditor stack and Pi re-appends the just-set widget to the
    // bottom, so re-emit any lower-priority widgets to push them back below.
    reassertLowerAboveEditorWidgets(ctx);
  } catch {
    // Best-effort: a widget failure must never demote a successful tool call.
  }
}
