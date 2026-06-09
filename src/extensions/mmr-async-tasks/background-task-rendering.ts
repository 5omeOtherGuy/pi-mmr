import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { isRecord } from "../mmr-core/internal/json.js";
import type {
  MmrAsyncTaskBoard,
  MmrAsyncTaskBoardEntry,
} from "./async-task-registry.js";
import {
  backgroundStatusColor,
  backgroundStatusGlyph,
  backgroundStatusWord,
} from "./background-task-view.js";
import {
  compactOneLine,
  formatTitle,
  type BackgroundTaskDetails,
  type RenderStatus,
  type SubagentProgressDetails,
  type SubagentTheme,
} from "../mmr-subagents/subagent-render-format.js";

export function backgroundTaskRenderStatus(status: string | undefined): RenderStatus | undefined {
  if (status === "running" || status === "cancelling") return "running";
  if (status === "succeeded") return "succeeded";
  if (status === "failed" || status === "cancelled") return "failed";
  return undefined;
}

export function backgroundStatusBgFn(
  status: string | undefined,
  theme: SubagentTheme,
): (text: string) => string {
  if (status === "succeeded") return (text) => theme.bg?.("toolSuccessBg", text) ?? text;
  if (status === "failed") return (text) => theme.bg?.("toolErrorBg", text) ?? text;
  if (status === "running" || status === "cancelling") {
    return (text) => theme.bg?.("toolPendingBg", text) ?? text;
  }
  // cancelled / unknown: neutral background so an intentional cancel never
  // reads as a hard failure.
  return (text) => text;
}

export function backgroundStatusBadge(
  status: string | undefined,
  theme: SubagentTheme,
): string {
  // The shared glyph/colour helpers expect a concrete status; an unknown one
  // resolves to the neutral `•`/muted pair, matching the prior local behavior.
  const concrete = status ?? "";
  const color = backgroundStatusColor(concrete);
  return `${theme.fg(color, backgroundStatusGlyph(concrete))} ${theme.fg(color, backgroundStatusWord(status))}`;
}

export function backgroundTaskHeaderLine(
  details: BackgroundTaskDetails,
  model: string | undefined,
  theme: SubagentTheme,
): string {
  const title = formatTitle(details.agent ?? "background task", model, theme);
  const badge = theme.fg("muted", "background");
  const outcome = details.terminalOutcome === "partial" ? ` ${theme.fg("warning", "partial")}` : "";
  return `${title} ${theme.fg("muted", "•")} ${badge}  ${backgroundStatusBadge(details.status, theme)}${outcome}`;
}

export function backgroundTaskDisplayText(
  details: BackgroundTaskDetails,
  subDetails: SubagentProgressDetails,
  startDisplay: { collapsed?: string; expanded?: string } | undefined,
): { collapsed?: string; expanded?: string } {
  const expanded = details.prompt
    ?? startDisplay?.expanded
    ?? subDetails.query
    ?? subDetails.prompt
    ?? subDetails.task
    ?? subDetails.description
    ?? details.description;
  const collapsed = details.description
    ?? startDisplay?.collapsed
    ?? subDetails.description
    ?? subDetails.query
    ?? subDetails.task
    ?? subDetails.prompt
    ?? expanded;
  return { collapsed, expanded };
}

const BACKGROUND_STATUS_VALUES: ReadonlySet<string> = new Set([
  "ready",
  "running",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
]);
const BACKGROUND_FRESHNESS_VALUES: ReadonlySet<string> = new Set([
  "healthy",
  "stalled",
  "dead",
  "terminal",
]);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

// Validate only the fields the board renderer reads. The producer always emits
// the full entry; this localized narrowing keeps a malformed/replayed payload
// from reaching the row formatter (which would mis-render or throw).
function isBackgroundTaskBoardEntry(value: unknown): value is MmrAsyncTaskBoardEntry {
  return (
    isRecord(value) &&
    typeof value.taskId === "string" &&
    typeof value.agent === "string" &&
    typeof value.description === "string" &&
    typeof value.status === "string" &&
    BACKGROUND_STATUS_VALUES.has(value.status) &&
    typeof value.freshness === "string" &&
    BACKGROUND_FRESHNESS_VALUES.has(value.freshness)
  );
}

function isBackgroundTaskBoard(value: unknown): value is MmrAsyncTaskBoard {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.counts)) return false;
  const counts = value.counts;
  if (
    !isFiniteNumber(counts.active) ||
    !isFiniteNumber(counts.stalled) ||
    !isFiniteNumber(counts.finished)
  ) {
    return false;
  }
  return (
    Array.isArray(value.active) && value.active.every(isBackgroundTaskBoardEntry) &&
    Array.isArray(value.stalled) && value.stalled.every(isBackgroundTaskBoardEntry) &&
    Array.isArray(value.finished) && value.finished.every(isBackgroundTaskBoardEntry)
  );
}

function backgroundBoardEntryLine(entry: MmrAsyncTaskBoardEntry, theme: SubagentTheme): string {
  const color = backgroundStatusColor(entry.status);
  const glyph = theme.fg(color, backgroundStatusGlyph(entry.status));
  const id = theme.fg("accent", entry.taskId);
  const agent = theme.fg("muted", entry.agent);
  const desc = entry.description
    ? ` ${theme.fg("muted", `"${compactOneLine(entry.description, 60)}"`)}`
    : "";
  const fresh = entry.freshness !== "healthy" && entry.freshness !== "terminal"
    ? ` ${theme.fg(entry.freshness === "dead" ? "error" : "warning", `[${entry.freshness}]`)}`
    : "";
  const group = entry.groupId ? ` ${theme.fg("dim", entry.groupId)}` : "";
  const partial = entry.terminalOutcome === "partial" ? ` ${theme.fg("warning", "[partial]")}` : "";
  return `  ${glyph} ${id} ${agent}${desc}${group}${partial}${fresh}`;
}

/**
 * Compact grouped board for `task_poll` with no task id. Renders the same
 * structured counts/sections the model receives, but as a glyph-led TUI board
 * instead of a plain-text dump. Returns undefined for malformed/legacy board
 * payloads so the caller can fall back to the text content.
 */
export function renderBackgroundTaskBoard(value: unknown, theme: SubagentTheme): Component | undefined {
  if (!isBackgroundTaskBoard(value)) return undefined;
  const board = value;
  const container = new Container();
  const total = board.counts.active + board.counts.stalled + board.counts.finished;
  const headGlyph = board.counts.active > 0
    ? theme.fg("warning", backgroundStatusGlyph("running"))
    : theme.fg("muted", "•");
  const counts = theme.fg(
    "muted",
    `${board.counts.active} active • ${board.counts.stalled} stalled • ${board.counts.finished} finished`,
  );
  container.addChild(
    new Text(`${theme.fg("toolTitle", theme.bold("background tasks"))}  ${headGlyph} ${counts}`, 1, 0),
  );
  if (total === 0) {
    container.addChild(new Text(theme.fg("muted", "No background tasks in this session."), 1, 0));
    return container;
  }
  const section = (title: string, entries: readonly MmrAsyncTaskBoardEntry[]): void => {
    if (entries.length === 0) return;
    container.addChild(new Text(theme.fg("dim", title), 1, 0));
    for (const entry of entries) {
      container.addChild(new Text(backgroundBoardEntryLine(entry, theme), 1, 0));
    }
  };
  section("Active", board.active);
  section("Stalled", board.stalled);
  section("Finished", board.finished);
  return container;
}
