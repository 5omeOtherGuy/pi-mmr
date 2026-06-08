import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

const VIEW_MODULE = "extensions/mmr-subagents/background-task-view.ts";

after(cleanupLoadedSource);

/** Minimal WidgetRow. */
function row(overrides = {}) {
  return {
    taskId: "task_x",
    status: "ready",
    freshness: "healthy",
    agent: "finder",
    description: "Find routes",
    runtimeMs: 0,
    createdAtMs: 1_000,
    boardGeneratedAtMs: 0,
    ...overrides,
  };
}

describe("ready-state view primitives", () => {
  it("renders the ready glyph as an ASCII dash, distinct from cancelled", async () => {
    const { backgroundStatusGlyph } = await importSource(VIEW_MODULE);
    assert.equal(backgroundStatusGlyph("ready"), "-");
    // A running activeFrame must not override the ready dash.
    assert.equal(backgroundStatusGlyph("ready", "⠹"), "-");
    // cancelled stays the en-dash, so the two read differently.
    assert.notEqual(backgroundStatusGlyph("ready"), backgroundStatusGlyph("cancelled"));
  });

  it("reads the ready status word as 'ready'", async () => {
    const { backgroundStatusWord } = await importSource(VIEW_MODULE);
    assert.equal(backgroundStatusWord("ready"), "ready");
  });

  it("colours a ready row/group as muted (not warning/error)", async () => {
    const { backgroundStatusColor, groupStatusColor } = await importSource(VIEW_MODULE);
    assert.equal(backgroundStatusColor("ready"), "muted");
    assert.equal(groupStatusColor("ready"), "muted");
  });

  it("renders a ready section header as '● ready · 0/N'", async () => {
    const { renderSectionHeader } = await importSource(VIEW_MODULE);
    const header = renderSectionHeader(
      {
        groupId: "group_ab12cd",
        group: {
          status: "ready",
          counts: { running: 0, succeeded: 0, failed: 0, cancelled: 0, partial: 0, total: 3 },
          label: "API surface review",
        },
        rows: [],
      },
      undefined,
    );
    assert.match(header, /ready/);
    assert.match(header, /0\/3/);
    assert.match(header, /API surface review/);
  });

  it("keeps a ready row's elapsed at 0s (no wall-time tick before launch)", async () => {
    const { liveRuntimeMs, renderRowLine } = await importSource(VIEW_MODULE);
    // boardGeneratedAtMs well in the past would otherwise add wall time.
    const ready = row({ status: "ready", runtimeMs: 0, boardGeneratedAtMs: Date.now() - 5_000 });
    assert.equal(liveRuntimeMs(ready), 0);
    const line = renderRowLine(ready, undefined, "⠹", { metadata: "minimal" });
    assert.match(line, /^- /, "ready row leads with the dash glyph");
    assert.match(line, /0s/, "ready row shows 0s elapsed");
  });
});
