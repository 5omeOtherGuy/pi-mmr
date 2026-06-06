#!/usr/bin/env node
/**
 * Static ANSI preview of the proposed grouped orchestration widget for
 * mmr-subagents, rendered next to the CURRENT flat widget for comparison.
 *
 * This is a MOCKUP ONLY — it hardcodes a board snapshot and reimplements the
 * row formatting with raw ANSI so reviewers can see the look without booting
 * Pi. The real widget keeps using `theme.fg(...)` over the pi-tui Box/Text
 * components; the token→colour mapping here mirrors Pi's default dark theme.
 *
 *   node scripts/preview-orchestration-widget.mjs
 *
 * Scenario mirrors the reference screenshot: a "find the p99 latency
 * regression" run with one settled wave (briefly retained) and one in-flight
 * wave, both expressed in OUR design language (braille spinner, ✓/✕/–, raw
 * capability-profile keys, group section headers).
 */

// --- token → ANSI (approximates Pi default dark theme) -----------------------
const ESC = "\x1b[";
const code = (n, s) => `${ESC}${n}m${s}${ESC}0m`;
const TOKENS = {
  accent: (s) => code("36", s), // cyan
  success: (s) => code("32", s), // green
  warning: (s) => code("33", s), // yellow
  error: (s) => code("31", s), // red
  muted: (s) => code("37", s), // light grey
  dim: (s) => code("90", s), // bright-black / faint
  bold: (s) => code("1", s),
};
const fg = (name, s) => (TOKENS[name] ? TOKENS[name](s) : s);

// --- the same constants the real widget uses --------------------------------
const PI_LOADER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function statusColor(status) {
  if (status === "running" || status === "cancelling") return "warning";
  if (status === "succeeded") return "success";
  if (status === "failed") return "error";
  return "muted"; // cancelled / unknown
}
function statusGlyph(status, frame) {
  if (status === "running" || status === "cancelling") return frame ?? PI_LOADER_FRAMES[0];
  if (status === "succeeded") return "✓";
  if (status === "failed") return "✕";
  if (status === "cancelled") return "–";
  return "•";
}
function groupStatusColor(status) {
  if (status === "running") return "warning";
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  if (status === "partial") return "warning";
  return "muted";
}

const compact = (v, n) => (v.length <= n ? v : `${v.slice(0, n - 1)}…`);
function elapsed(ms) {
  const s = Math.floor(ms / 1000);
  if (s >= 60) return `${Math.floor(s / 60)}m${s % 60 ? `${s % 60}s` : ""}`;
  return `${s}s`;
}

// Per-row metadata. NOTE the two changes vs today: capabilityProfile is now a
// chip, and groupId is REMOVED (it lives in the section header instead).
function rowMeta(row) {
  const parts = [];
  const e = elapsed(row.runtimeMs);
  if (e) parts.push(e);
  if (row.model) parts.push(row.model);
  if (row.capabilityProfile) parts.push(row.capabilityProfile);
  if (row.latestToolName) parts.push(`${row.latestToolName}${row.latestToolStatus === "running" ? "…" : ""}`);
  if (row.turns) parts.push(`${row.turns} turn${row.turns === 1 ? "" : "s"}`);
  if (row.terminalOutcome === "partial") parts.push("partial");
  return parts;
}

function renderRow(row, frame, indent = "") {
  const color = statusColor(row.status);
  const glyph = fg(color, statusGlyph(row.status, frame));
  const agent = fg("accent", row.agent);
  const desc = row.description ? ` ${fg("muted", compact(row.description, 38))}` : "";
  const meta = rowMeta(row);
  const metaStr = meta.length ? ` ${fg("dim", `· ${meta.join(" · ")}`)}` : "";
  const fresh =
    row.freshness === "stalled" || row.freshness === "dead"
      ? ` ${fg(row.freshness === "dead" ? "error" : "warning", `[${row.freshness}]`)}`
      : "";
  return `${indent}${glyph} ${agent}${desc}${metaStr}${fresh}`;
}

// NEW: a group section header. Ungrouped tasks render with no header.
function renderGroupHeader(group) {
  const marker = fg("dim", "▸");
  const id = fg("dim", group.groupId);
  const dot = fg(groupStatusColor(group.status), "●");
  const status = fg(groupStatusColor(group.status), group.status);
  const settled = group.counts.succeeded + group.counts.failed + group.counts.cancelled + group.counts.partial;
  const count = fg("dim", `${settled}/${group.counts.total}`);
  return `${marker} ${id}  ${dot} ${status} ${fg("dim", "·")} ${count}`;
}

// --- mock board (mirrors the screenshot scenario, our language) -------------
const FRAME = PI_LOADER_FRAMES[2]; // freeze "⠹" for a still image

const groups = [
  {
    groupId: "group_94f0d2",
    status: "completed",
    counts: { running: 0, succeeded: 3, failed: 0, cancelled: 0, partial: 1, total: 4 },
    retained: true, // briefly-retained settled wave
    rows: [
      { status: "succeeded", freshness: "terminal", agent: "Task", description: "Diff recent deploys", runtimeMs: 14000, model: "grok-4", capabilityProfile: "read-only", turns: 3 },
      { status: "succeeded", freshness: "terminal", agent: "Task", description: "Rank slowest endpoints", runtimeMs: 16000, model: "grok-4", capabilityProfile: "read-only", turns: 4 },
      { status: "succeeded", freshness: "terminal", agent: "Task", description: "Pull slow query plans", runtimeMs: 11000, model: "grok-4", capabilityProfile: "read-write", turns: 2 },
      { status: "succeeded", freshness: "terminal", agent: "Task", description: "Check cache hit rates", runtimeMs: 9000, model: "grok-4", capabilityProfile: "read-write", turns: 2, terminalOutcome: "partial" },
    ],
  },
  {
    groupId: "group_a1b2c3",
    status: "running",
    counts: { running: 4, succeeded: 0, failed: 0, cancelled: 0, partial: 0, total: 4 },
    retained: false,
    rows: [
      { status: "running", freshness: "healthy", agent: "Task", description: "Explore shared Go libraries", runtimeMs: 8000, model: "grok-4", capabilityProfile: "read-only", latestToolName: "Grep", latestToolStatus: "running", turns: 1 },
      { status: "running", freshness: "healthy", agent: "Task", description: "Explore order services", runtimeMs: 7000, model: "grok-4", capabilityProfile: "read-only", latestToolName: "Read", latestToolStatus: "running", turns: 1 },
      { status: "running", freshness: "stalled", agent: "Task", description: "Explore fulfillment jobs", runtimeMs: 6000, model: "grok-4", capabilityProfile: "read-only", turns: 1 },
      { status: "running", freshness: "healthy", agent: "Task", description: "Explore pricing engine", runtimeMs: 5000, model: "grok-4", capabilityProfile: "read-only", latestToolName: "Read", latestToolStatus: "running", turns: 1 },
    ],
  },
];

const ungrouped = [
  { status: "running", freshness: "healthy", agent: "finder", description: "locate feature flag config", runtimeMs: 4000, model: "grok-4-fast", capabilityProfile: "read-only", latestToolName: "Grep", latestToolStatus: "running" },
];

// --- render: CURRENT widget (flat, active+stalled only, no groups) ----------
function renderCurrent() {
  const lines = [fg("dim", "── CURRENT (background-task-widget.ts) ─────────────────────")];
  const flat = [];
  for (const g of groups) for (const r of g.rows) if (r.status === "running") flat.push({ ...r, groupId: g.groupId });
  for (const r of ungrouped) flat.push(r);
  for (const r of flat) {
    // today groupId IS a per-row chip; replicate that here
    const meta = rowMeta(r);
    if (r.groupId) meta.push(r.groupId);
    const color = statusColor(r.status);
    const glyph = fg(color, statusGlyph(r.status, FRAME));
    const agent = fg("accent", r.agent);
    const desc = ` ${fg("muted", compact(r.description, 38))}`;
    const metaStr = meta.length ? ` ${fg("dim", `· ${meta.join(" · ")}`)}` : "";
    const fresh = r.freshness === "stalled" ? ` ${fg("warning", "[stalled]")}` : "";
    lines.push(`${glyph} ${agent}${desc}${metaStr}${fresh}`);
  }
  return lines;
}

// --- render: PROPOSED widget (grouped sections + retained done rows) --------
function renderProposed() {
  const lines = [fg("dim", "── PROPOSED (grouped orchestration view) ───────────────────")];
  for (const g of groups) {
    lines.push(renderGroupHeader(g));
    for (const r of g.rows) lines.push(renderRow(r, FRAME, "  "));
  }
  if (ungrouped.length) {
    lines.push(fg("dim", "▸ ungrouped"));
    for (const r of ungrouped) lines.push(renderRow(r, FRAME, "  "));
  }
  return lines;
}

const out = [
  "",
  fg("bold", "  projects/main · subagents") + "    " + fg("dim", "belowEditor widget mockup"),
  "",
  ...renderCurrent(),
  "",
  ...renderProposed(),
  "",
];
process.stdout.write(out.map((l) => `  ${l}`).join("\n") + "\n");
