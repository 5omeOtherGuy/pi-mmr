/**
 * Shared presentation primitives for background subagents.
 *
 * Both surfaces that draw background agents render the SAME rows from here:
 *   - the pinned belowEditor board ({@link ./background-task-widget.ts})
 *   - the inline transcript group/row card ({@link ./progress-rendering.ts})
 *
 * Keeping the glyph/colour/label vocabulary, the row + group-header formatters,
 * and the loader animation clock in one module is the single source of truth
 * the two surfaces agree on — the widget owns lifecycle (placement, retention,
 * the row cap) and the card owns its inline framing, but neither re-implements
 * how a background row looks. This module owns no session state; callers pass
 * the live board/group snapshots in.
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
 * Minimal theme shape both surfaces share: foreground colouring + bold. The
 * widget passes Pi's live theme; the inline card passes the subagent theme.
 */
export interface BackgroundViewTheme {
  fg(name: string, value: string): string;
  bold(value: string): string;
}

/**
 * Resolves a group's live snapshot (status + counts + label) for its header.
 * Supplied by the caller, which holds the registry. When absent — or when it
 * returns `undefined` — a header is synthesized from the rows on hand instead.
 */
export type MmrWidgetGroupResolver = (
  groupId: string,
) => MmrAsyncTaskGroupSnapshot | undefined;

/**
 * Pi's native streaming loader frames (see `@earendil-works/pi-tui` `Loader`).
 * Mirrored here so running background agents animate with the same braille
 * spinner the rest of Pi uses. Public-safe constant; pi-tui does not export its
 * frame array.
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

/** Frame interval matching Pi's native loader cadence. */
export const PI_LOADER_INTERVAL_MS = 80;

// Module-global loader frame, advanced by the belowEditor widget's animation
// interval and read by BOTH surfaces. Nested transcript components cannot own a
// timer (the host renders them with a no-op TUI), so they piggyback the widget's
// re-render cadence: every widget tick advances this frame and re-renders the
// whole tree, so an inline running card animates in lockstep with the board.
let loaderFrameIndex = 0;

/** Advance the shared loader frame. Called once per widget animation tick. */
export function advanceLoaderFrame(): void {
  loaderFrameIndex = (loaderFrameIndex + 1) % PI_LOADER_FRAMES.length;
}

/** Current shared loader frame glyph. */
export function currentLoaderFrame(): string {
  return PI_LOADER_FRAMES[loaderFrameIndex];
}

/** Width cap for the group label shown in a group header. */
export const WIDGET_GROUP_LABEL_LIMIT = 40;

/** A flattened board entry both surfaces render, in display order. */
export interface WidgetRow {
  taskId: string;
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
 * synthetic ungrouped bucket has `groupId === undefined` and no `group`.
 */
export interface WidgetSection {
  groupId: string | undefined;
  group?: Pick<MmrAsyncTaskGroupSnapshot, "status" | "counts" | "label">;
  rows: WidgetRow[];
}

export function backgroundStatusColor(status: string): string {
  if (status === "running" || status === "cancelling") return "warning";
  if (status === "succeeded") return "success";
  if (status === "failed") return "error";
  // cancelled / unknown: neutral. A user-initiated cancel is not an error.
  return "muted";
}

export function groupStatusColor(status: MmrAsyncTaskGroupStatus): string {
  if (status === "running") return "warning";
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  if (status === "partial") return "warning";
  // cancelled / unknown: neutral, mirroring a row-level cancel.
  return "muted";
}

/**
 * Status glyph for a row. Running/cancelling resolve to `activeFrame` when one
 * is supplied (the live animated frame), else the first loader frame as a
 * resting glyph. ✓ succeeded, ✕ failed, – cancelled.
 */
export function backgroundStatusGlyph(status: string, activeFrame?: string): string {
  if (status === "running" || status === "cancelling") {
    return activeFrame ?? PI_LOADER_FRAMES[0];
  }
  if (status === "succeeded") return "✓";
  if (status === "failed") return "✕";
  if (status === "cancelled") return "–";
  return "•";
}

/**
 * Short status word for a background row/group. The placement ("background") is
 * conveyed elsewhere, so the word does not repeat it ("running", not "running in
 * background"). `succeeded` reads as "completed" to match the blocking subagent
 * label vocabulary.
 */
export function backgroundStatusWord(status: string | undefined): string {
  if (status === "running") return "running";
  if (status === "cancelling") return "cancelling";
  if (status === "succeeded" || status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  if (status === "failed") return "failed";
  if (status === "partial") return "partial";
  return status ?? "background";
}

export function compactOneLine(value: string, limit: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= limit) return compact;
  return `${compact.slice(0, Math.max(0, limit - 1))}…`;
}

export function formatElapsed(ms: number): string | undefined {
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

/**
 * Row metadata chips. `"full"` is the board's rich set (elapsed, model,
 * profile, latest tool, turns, tools, ctx%); `"minimal"` keeps just elapsed +
 * model so the inline card stays GROK-compact; `"none"` omits them.
 */
export type RowMetadataLevel = "full" | "minimal" | "none";

function widgetMetadataParts(row: WidgetRow, level: RowMetadataLevel): string[] {
  if (level === "none") return [];
  const parts: string[] = [];
  const elapsed = formatElapsed(row.runtimeMs);
  if (elapsed) parts.push(elapsed);
  const model = stripMmrWorkerModelProvider(row.resolvedModel);
  if (model) parts.push(model);
  if (level === "minimal") return parts;
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

export function toRow(entry: MmrAsyncTaskBoardEntry): WidgetRow {
  return {
    taskId: entry.taskId,
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

export function isTerminalRowStatus(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

/** Non-terminal rows sort above settled ones; ties break by launch order. */
export function compareRows(a: WidgetRow, b: WidgetRow): number {
  const rank = (r: WidgetRow) => (isTerminalRowStatus(r.status) ? 1 : 0);
  return rank(a) - rank(b) || a.createdAtMs - b.createdAtMs;
}

/**
 * Synthesize a section header when no live group snapshot is available (the
 * resolver is absent or the group has already been pruned from the registry).
 * Status/counts are derived from the rows on hand.
 */
export function synthesizeGroup(rows: readonly WidgetRow[]): Pick<MmrAsyncTaskGroupSnapshot, "status" | "counts" | "label"> {
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
  // Mirror the registry's earliest-child fallback so a synthesized header still
  // carries a label when no live snapshot is available.
  let earliest: WidgetRow | undefined;
  for (const r of rows) {
    if (!earliest || r.createdAtMs < earliest.createdAtMs) earliest = r;
  }
  const label = earliest?.description?.trim();
  return { status, counts, ...(label ? { label } : {}) };
}

export function makeSafeFg(theme: BackgroundViewTheme | undefined) {
  return (name: string, value: string): string => {
    if (!theme) return value;
    try {
      return theme.fg(name, value);
    } catch {
      return value;
    }
  };
}

/**
 * One background row: `<glyph> <agent> <desc> · <metadata> [fresh]`. `indent`
 * prefixes grouped rows; `activeFrame` animates running rows when supplied.
 */
export function renderRowLine(
  row: WidgetRow,
  theme: BackgroundViewTheme | undefined,
  activeFrame: string | undefined,
  options: { indent?: string; metadata?: RowMetadataLevel } = {},
): string {
  const indent = options.indent ?? "";
  const metadataLevel = options.metadata ?? "full";
  const safeFg = makeSafeFg(theme);
  const color = backgroundStatusColor(row.status);
  const glyph = safeFg(color, backgroundStatusGlyph(row.status, activeFrame));
  const agent = safeFg("accent", row.agent);
  const desc = row.description
    ? ` ${safeFg("muted", compactOneLine(row.description, 60))}`
    : "";
  const metadataParts = widgetMetadataParts(row, metadataLevel);
  const metadata = metadataParts.length > 0
    ? ` ${safeFg("dim", `· ${metadataParts.join(" · ")}`)}`
    : "";
  const fresh = row.freshness === "stalled" || row.freshness === "dead"
    ? ` ${safeFg(row.freshness === "dead" ? "error" : "warning", `[${row.freshness}]`)}`
    : "";
  return `${indent}${glyph} ${agent}${desc}${metadata}${fresh}`;
}

/**
 * `▸ Explore order services · group_94f0d2  ● completed · 3/4` when the group
 * has a resolved label (label muted, id dim); `▸ group_94f0d2  ● …` when it has
 * none. Status dot+word in the group colour; settled/total in dim.
 */
export function renderSectionHeader(
  section: WidgetSection,
  theme: BackgroundViewTheme | undefined,
): string {
  const safeFg = makeSafeFg(theme);
  if (section.groupId === undefined) return safeFg("dim", "▸ ungrouped");
  const marker = safeFg("dim", "▸");
  const id = safeFg("dim", section.groupId);
  const group = section.group;
  const label = group?.label ? compactOneLine(group.label, WIDGET_GROUP_LABEL_LIMIT) : undefined;
  // Label leads, id trails as the dim disambiguator: `▸ <label> · <id>`.
  const head = label !== undefined
    ? `${marker} ${safeFg("muted", label)} ${safeFg("dim", "·")} ${id}`
    : `${marker} ${id}`;
  if (!group) return head;
  const color = groupStatusColor(group.status);
  const dot = safeFg(color, "●");
  const word = safeFg(color, group.status);
  const { succeeded, failed, cancelled, partial, total } = group.counts;
  const settled = succeeded + failed + cancelled + partial;
  const count = safeFg("dim", `${settled}/${total}`);
  return `${head}  ${dot} ${word} ${safeFg("dim", "·")} ${count}`;
}

export function truncateWidgetLines(lines: readonly string[], width: number): string[] {
  if (!Number.isFinite(width)) return [...lines];
  if (width <= 0) return lines.map(() => "");
  return lines.map((line) =>
    visibleWidth(line) > width ? truncateToWidth(line, width) : line,
  );
}

/**
 * All members of `groupId` across the board (active + stalled + finished),
 * sorted with running rows first. Unlike the widget's `boardSections`, this
 * ignores the finished-retention window — the inline card shows every member so
 * a settled group reads as a complete checklist.
 */
export function groupMembersFromBoard(board: MmrAsyncTaskBoard, groupId: string): WidgetRow[] {
  const entries = [...board.active, ...board.stalled, ...board.finished];
  return entries
    .filter((entry) => entry.groupId === groupId)
    .map(toRow)
    .sort(compareRows);
}

/** The single board row for `taskId`, if it is still present on the board. */
export function singleRowFromBoard(board: MmrAsyncTaskBoard, taskId: string): WidgetRow | undefined {
  const entry = [...board.active, ...board.stalled, ...board.finished].find(
    (candidate) => candidate.taskId === taskId,
  );
  return entry ? toRow(entry) : undefined;
}
