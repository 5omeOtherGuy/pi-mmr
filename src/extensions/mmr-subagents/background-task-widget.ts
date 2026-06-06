/**
 * Persistent bottom-of-window widget for async background subagents.
 *
 * The async task tools (`start_task` / `task_poll` / `task_wait` /
 * `task_cancel`) register a background run in the in-memory registry and
 * return immediately. Their per-call transcript output is intentionally
 * minimal; the live, at-a-glance state of every background agent is shown
 * here instead — pinned below the editor with `ctx.ui.setWidget(...)`, away
 * from the above-editor `task_list` todo widget.
 *
 * This keeps background agents off the transcript as repeated cards (a raw
 * `task_<id>` per launch) and gives them one animated status board, mirroring
 * how Pi's working indicator / task list communicate in-flight work. The
 * widget is a pure UI mirror of the registry board; it owns no state.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type {
  MmrAsyncTaskBoard,
  MmrAsyncTaskBoardEntry,
  MmrAsyncTaskGroupSnapshot,
  MmrAsyncTaskGroupStatus,
} from "./async-task-registry.js";
import {
  formatMmrWorkerTokens,
  stripMmrWorkerModelProvider,
} from "./worker-usage-format.js";

/**
 * Resolves a group's live snapshot (status + counts) for its section header.
 * Supplied by the caller, which holds the registry. Optional: when absent —
 * or when it returns `undefined` — the section header is synthesized from the
 * rows on hand instead. The widget owns no state, so it never reads a registry
 * directly.
 */
export type MmrWidgetGroupResolver = (
  groupId: string,
) => MmrAsyncTaskGroupSnapshot | undefined;

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
    options?: { placement?: "aboveEditor" | "belowEditor" },
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
  runtimeMs: number;
  createdAtMs: number;
  resolvedModel?: string;
  contextWindow?: number;
  usage?: MmrAsyncTaskBoardEntry["usage"];
  latestToolName?: string;
  latestToolStatus?: MmrAsyncTaskBoardEntry["latestToolStatus"];
  toolCount?: number;
  terminalOutcome?: MmrAsyncTaskBoardEntry["terminalOutcome"];
  capabilityProfile?: string;
  groupId?: string;
}

/**
 * One group's worth of rows plus the snapshot that labels its header. The
 * synthetic ungrouped bucket has `groupId === undefined` and no `group`; it is
 * rendered headerless when it is the only section (so non-grouped Task usage is
 * byte-identical to the pre-grouping widget).
 */
interface WidgetSection {
  groupId: string | undefined;
  group?: Pick<MmrAsyncTaskGroupSnapshot, "status" | "counts">;
  rows: WidgetRow[];
}

function backgroundStatusColor(status: string): string {
  if (status === "running" || status === "cancelling") return "warning";
  if (status === "succeeded") return "success";
  if (status === "failed") return "error";
  // cancelled / unknown: neutral. A user-initiated cancel is not an error.
  return "muted";
}

function groupStatusColor(status: MmrAsyncTaskGroupStatus): string {
  if (status === "running") return "warning";
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  if (status === "partial") return "warning";
  // cancelled / unknown: neutral, mirroring a row-level cancel.
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

function formatElapsed(ms: number): string | undefined {
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  if (hours > 0) return `${hours}h${minutes > 0 ? `${minutes}m` : ""}`;
  if (minutes > 0) return `${minutes}m${remainingSeconds > 0 ? `${remainingSeconds}s` : ""}`;
  return `${remainingSeconds}s`;
}

function formatContextUsage(row: WidgetRow): string | undefined {
  const contextWindow = row.contextWindow;
  const contextTokens = row.usage?.contextTokens;
  if (
    typeof contextWindow !== "number" ||
    !Number.isFinite(contextWindow) ||
    contextWindow <= 0 ||
    typeof contextTokens !== "number" ||
    !Number.isFinite(contextTokens) ||
    contextTokens <= 0
  ) {
    return undefined;
  }
  return `${((contextTokens / contextWindow) * 100).toFixed(1)}% ctx`;
}

function widgetMetadataParts(row: WidgetRow): string[] {
  const parts: string[] = [];
  const elapsed = formatElapsed(row.runtimeMs);
  if (elapsed) parts.push(elapsed);
  const model = stripMmrWorkerModelProvider(row.resolvedModel);
  if (model) parts.push(model);
  // Capability profile (e.g. `read-only` / `read-write`) shown verbatim as the
  // worker's lane. The group id is NOT a row chip — it labels the section header.
  if (row.capabilityProfile) parts.push(row.capabilityProfile);
  if (row.latestToolName) {
    const suffix = row.latestToolStatus === "running" ? "…" : "";
    parts.push(`${row.latestToolName}${suffix}`);
  }
  const turns = row.usage?.turns ?? 0;
  if (turns > 0) parts.push(`${turns} turn${turns === 1 ? "" : "s"}`);
  if (typeof row.toolCount === "number" && Number.isFinite(row.toolCount) && row.toolCount > 0) {
    parts.push(`${formatMmrWorkerTokens(row.toolCount)} tool${row.toolCount === 1 ? "" : "s"}`);
  }
  if (row.terminalOutcome === "partial") parts.push("partial");
  const context = formatContextUsage(row);
  if (context) parts.push(context);
  return parts;
}

function toRow(entry: MmrAsyncTaskBoardEntry): WidgetRow {
  return {
    status: entry.status,
    freshness: entry.freshness,
    agent: entry.agent,
    description: entry.description,
    runtimeMs: entry.runtimeMs,
    createdAtMs: entry.createdAtMs,
    ...(entry.resolvedModel !== undefined ? { resolvedModel: entry.resolvedModel } : {}),
    ...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
    ...(entry.usage !== undefined ? { usage: entry.usage } : {}),
    ...(entry.latestToolName !== undefined ? { latestToolName: entry.latestToolName } : {}),
    ...(entry.latestToolStatus !== undefined ? { latestToolStatus: entry.latestToolStatus } : {}),
    ...(entry.toolCount !== undefined ? { toolCount: entry.toolCount } : {}),
    ...(entry.terminalOutcome !== undefined ? { terminalOutcome: entry.terminalOutcome } : {}),
    ...(entry.capabilityProfile !== undefined ? { capabilityProfile: entry.capabilityProfile } : {}),
    ...(entry.groupId !== undefined ? { groupId: entry.groupId } : {}),
  };
}

function isTerminalRowStatus(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

/** Non-terminal rows sort above settled ones; ties break by launch order. */
function compareRows(a: WidgetRow, b: WidgetRow): number {
  const rank = (r: WidgetRow) => (isTerminalRowStatus(r.status) ? 1 : 0);
  return rank(a) - rank(b) || a.createdAtMs - b.createdAtMs;
}

/**
 * Synthesize a section header when no live group snapshot is available (the
 * resolver is absent or the group has already been pruned from the registry).
 * Status/counts are derived from the rows on hand, so the total may undercount
 * members that have already aged out — acceptable for a best-effort header.
 */
function synthesizeGroup(rows: readonly WidgetRow[]): Pick<MmrAsyncTaskGroupSnapshot, "status" | "counts"> {
  const counts = { running: 0, succeeded: 0, failed: 0, cancelled: 0, partial: 0, total: rows.length };
  for (const r of rows) {
    if (r.status === "succeeded") r.terminalOutcome === "partial" ? counts.partial++ : counts.succeeded++;
    else if (r.status === "failed") counts.failed++;
    else if (r.status === "cancelled") counts.cancelled++;
    else counts.running++;
  }
  const status: MmrAsyncTaskGroupStatus =
    counts.running > 0 ? "running"
    : counts.failed > 0 ? "failed"
    : counts.partial > 0 ? "partial"
    : counts.succeeded > 0 ? "completed"
    : "cancelled";
  return { status, counts };
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
    bucket.push(toRow(entry));
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
      ? { status: resolved.status, counts: resolved.counts }
      : synthesizeGroup(rows);
    const minCreated = rows.reduce((min, r) => Math.min(min, r.createdAtMs), Number.POSITIVE_INFINITY);
    grouped.push({ section: { groupId: key, group, rows }, minCreated });
  }
  grouped.sort((a, b) => a.minCreated - b.minCreated);

  const sections = grouped.map((g) => g.section);
  if (ungrouped) sections.push(ungrouped);
  return sections;
}

function makeSafeFg(theme: WidgetThemeLike | undefined) {
  return (name: string, value: string): string => {
    if (!theme) return value;
    try {
      return theme.fg(name, value);
    } catch {
      return value;
    }
  };
}

function renderRowLine(
  row: WidgetRow,
  theme: WidgetThemeLike | undefined,
  activeFrame: string | undefined,
  indent = "",
): string {
  const safeFg = makeSafeFg(theme);
  const color = backgroundStatusColor(row.status);
  const glyph = safeFg(color, backgroundStatusGlyph(row.status, activeFrame));
  const agent = safeFg("accent", row.agent);
  const desc = row.description
    ? ` ${safeFg("muted", compactOneLine(row.description, 60))}`
    : "";
  const metadataParts = widgetMetadataParts(row);
  const metadata = metadataParts.length > 0
    ? ` ${safeFg("dim", `· ${metadataParts.join(" · ")}`)}`
    : "";
  const fresh = row.freshness === "stalled" || row.freshness === "dead"
    ? ` ${safeFg(row.freshness === "dead" ? "error" : "warning", `[${row.freshness}]`)}`
    : "";
  return `${indent}${glyph} ${agent}${desc}${metadata}${fresh}`;
}

/** `▸ group_94f0d2  ● completed · 3/4` — id dim, status dot+word in group colour. */
function renderSectionHeader(
  section: WidgetSection,
  theme: WidgetThemeLike | undefined,
): string {
  const safeFg = makeSafeFg(theme);
  if (section.groupId === undefined) return safeFg("dim", "▸ ungrouped");
  const marker = safeFg("dim", "▸");
  const id = safeFg("dim", section.groupId);
  const group = section.group;
  if (!group) return `${marker} ${id}`;
  const color = groupStatusColor(group.status);
  const dot = safeFg(color, "●");
  const word = safeFg(color, group.status);
  const { succeeded, failed, cancelled, partial, total } = group.counts;
  const settled = succeeded + failed + cancelled + partial;
  const count = safeFg("dim", `${settled}/${total}`);
  return `${marker} ${id}  ${dot} ${word} ${safeFg("dim", "·")} ${count}`;
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
  theme: WidgetThemeLike | undefined,
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
    for (const row of section.rows) lines.push(renderRowLine(row, theme, activeFrame, indent));
    return { lines, rowCount: section.rows.length };
  });

  const out: string[] = [];
  let omittedRows = 0;
  let used = 0;
  for (const block of blocks) {
    if (used + block.lines.length <= WIDGET_MAX_ROWS) {
      out.push(...block.lines);
      used += block.lines.length;
    } else if (out.length === 0) {
      // First section alone exceeds the cap: show as many of its lines as fit
      // (header + leading rows) rather than rendering an empty widget.
      const slice = block.lines.slice(0, WIDGET_MAX_ROWS);
      out.push(...slice);
      used += slice.length;
      const shownRows = Math.max(0, slice.length - (block.lines.length - block.rowCount));
      omittedRows += block.rowCount - shownRows;
    } else {
      omittedRows += block.rowCount;
    }
  }
  if (omittedRows > 0) out.push(safeFg("dim", `… ${omittedRows} more`));
  return out;
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
  resolveGroup?: MmrWidgetGroupResolver,
): void {
  if (!isTuiWidgetSurface(ctx) || !ctx?.ui) return;
  try {
    const sections = boardSections(board, resolveGroup, board.generatedAtMs);
    const rowTotal = sections.reduce((sum, s) => sum + s.rows.length, 0);
    if (rowTotal === 0) {
      ctx.ui.setWidget(BACKGROUND_TASK_WIDGET_ID, undefined, { placement: "belowEditor" });
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
            renderWidgetLines(sections, theme, hasActive ? PI_LOADER_FRAMES[frame] : undefined),
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
    }, { placement: "belowEditor" });
  } catch {
    // Best-effort: a widget failure must never demote a successful tool call.
  }
}
