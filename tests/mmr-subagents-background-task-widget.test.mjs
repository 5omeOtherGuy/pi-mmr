import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

const WIDGET_MODULE = "extensions/mmr-subagents/background-task-widget.ts";

after(cleanupLoadedSource);

const theme = { fg: (_n, v) => v, bold: (v) => v };

function makeEntry(overrides = {}) {
  return {
    taskId: "task_1",
    status: "running",
    freshness: "healthy",
    agent: "finder",
    description: "Search the repo",
    createdAtMs: 1,
    startedAtMs: 1,
    updatedAtMs: 1,
    runtimeMs: 5,
    ...overrides,
  };
}

function makeBoard(overrides = {}) {
  return {
    version: 1,
    generatedAtMs: 0,
    counts: { active: 0, stalled: 0, finished: 0 },
    active: [],
    stalled: [],
    finished: [],
    ...overrides,
  };
}

function makeCtx() {
  const calls = [];
  return {
    ctx: {
      mode: "tui",
      ui: {
        theme,
        setWidget(id, value, options) {
          calls.push({ id, value, options });
        },
      },
    },
    calls,
  };
}

describe("background-task widget", () => {
  it("only renders on a TUI surface", async () => {
    const { isTuiWidgetSurface } = await importSource(WIDGET_MODULE);
    assert.equal(isTuiWidgetSurface({ mode: "tui", ui: {} }), true);
    assert.equal(isTuiWidgetSurface({ mode: "rpc", ui: {} }), false);
    assert.equal(isTuiWidgetSurface({ hasUI: true, ui: {} }), true);
    assert.equal(isTuiWidgetSurface({ hasUI: false, ui: {} }), false);
    assert.equal(isTuiWidgetSurface(undefined), false);
  });

  it("registers a factory listing active and stalled agents, not finished ones", async () => {
    const { refreshBackgroundTaskWidget, BACKGROUND_TASK_WIDGET_ID } = await importSource(WIDGET_MODULE);
    const { ctx, calls } = makeCtx();
    refreshBackgroundTaskWidget(
      ctx,
      makeBoard({
        counts: { active: 1, stalled: 1, finished: 1 },
        active: [makeEntry({ taskId: "task_1", agent: "finder", description: "Search the repo" })],
        stalled: [makeEntry({ taskId: "task_3", agent: "Task", freshness: "stalled", description: "Slow build" })],
        finished: [makeEntry({ taskId: "task_2", agent: "oracle", status: "succeeded", freshness: "terminal", description: "Review design" })],
      }),
    );
    const last = calls.at(-1);
    assert.equal(last.id, BACKGROUND_TASK_WIDGET_ID);
    assert.equal(typeof last.value, "function");
    assert.deepEqual(last.options, { placement: "belowEditor" }, "background agents must stay below the editor");
    const widget = last.value(undefined, theme);
    const text = widget.render(80).join("\n");
    assert.doesNotMatch(text, /Background agents/, "background widget must render rows directly without a header");
    assert.match(text, /finder/);
    assert.match(text, /Search the repo/);
    assert.match(text, /Task/);
    assert.match(text, /\[stalled\]/);
    assert.doesNotMatch(text, /oracle/, "finished agents drop off the running board");
    assert.doesNotMatch(text, /task_1/, "raw task ids must not lead the widget UI");
  });

  it("renders available progress metadata without requiring a widget redesign", async () => {
    const { refreshBackgroundTaskWidget } = await importSource(WIDGET_MODULE);
    const { ctx, calls } = makeCtx();
    refreshBackgroundTaskWidget(
      ctx,
      makeBoard({
        counts: { active: 1, stalled: 0, finished: 0 },
        active: [makeEntry({
          runtimeMs: 65_000,
          resolvedModel: "openai/gpt-5.5",
          contextWindow: 200_000,
          usage: { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 50_000, turns: 2 },
          latestToolName: "bash",
          toolCount: 3,
        })],
      }),
    );
    const widget = calls.at(-1).value(undefined, theme);
    const text = widget.render(160).join("\n");
    assert.match(text, /1m5s/);
    assert.match(text, /gpt-5\.5/);
    assert.match(text, /bash/);
    assert.match(text, /2 turns/);
    assert.match(text, /3 tools/);
    assert.match(text, /25\.0%/);
  });

  it("clears the widget when only finished (or no) agents remain", async () => {
    const { refreshBackgroundTaskWidget } = await importSource(WIDGET_MODULE);
    const { ctx, calls } = makeCtx();
    refreshBackgroundTaskWidget(ctx, makeBoard());
    assert.equal(calls.at(-1).value, undefined);
    refreshBackgroundTaskWidget(
      ctx,
      makeBoard({
        counts: { active: 0, stalled: 0, finished: 1 },
        finished: [makeEntry({ taskId: "task_2", agent: "oracle", status: "succeeded", freshness: "terminal" })],
      }),
    );
    assert.equal(calls.at(-1).value, undefined, "a board of only finished tasks clears the widget");
  });

  it("groups entries into sections with a status header and indented rows", async () => {
    const { refreshBackgroundTaskWidget } = await importSource(WIDGET_MODULE);
    const { ctx, calls } = makeCtx();
    refreshBackgroundTaskWidget(
      ctx,
      makeBoard({
        generatedAtMs: 1000,
        counts: { active: 1, stalled: 0, finished: 1 },
        active: [makeEntry({
          taskId: "task_a", agent: "Task", description: "Explore order services",
          groupId: "group_aaa111", capabilityProfile: "read-only", createdAtMs: 10,
        })],
        finished: [makeEntry({
          taskId: "task_b", agent: "Task", description: "Diff recent deploys", status: "succeeded",
          freshness: "terminal", groupId: "group_aaa111", capabilityProfile: "read-write",
          createdAtMs: 5, completedAtMs: 1000,
        })],
      }),
    );
    const lines = calls.at(-1).value(undefined, theme).render(120);
    const text = lines.join("\n");
    // Header carries the group id + synthesized status/counts (1 of 2 settled).
    assert.match(text, /▸ group_aaa111/);
    assert.match(text, /running/);
    assert.match(text, /1\/2/);
    // Capability profile is a row chip; the group id is NOT repeated per row.
    assert.match(text, /read-only/);
    assert.match(text, /read-write/);
    const rowLines = lines.filter((l) => /Explore order services|Diff recent deploys/.test(l));
    assert.equal(rowLines.length, 2, "both grouped rows render");
    for (const l of rowLines) assert.match(l, /^ {2}\S/, "group members are indented under the header");
    for (const l of rowLines) {
      assert.equal((l.match(/group_aaa111/g) ?? []).length, 0, "group id is not a per-row chip");
    }
    // Settled wave sorts above... no — running sorts above settled within a group.
    assert.ok(text.indexOf("Explore order services") < text.indexOf("Diff recent deploys"),
      "non-terminal rows sort above settled rows inside a group");
  });

  it("uses the resolved group snapshot for the header when provided", async () => {
    const { refreshBackgroundTaskWidget } = await importSource(WIDGET_MODULE);
    const { ctx, calls } = makeCtx();
    refreshBackgroundTaskWidget(
      ctx,
      makeBoard({
        generatedAtMs: 1000,
        counts: { active: 1, stalled: 0, finished: 0 },
        active: [makeEntry({ groupId: "group_bbb222", description: "Explore pricing engine" })],
      }),
      (groupId) => groupId === "group_bbb222"
        ? { status: "partial", counts: { running: 1, succeeded: 2, failed: 0, cancelled: 0, partial: 1, total: 4 } }
        : undefined,
    );
    const text = calls.at(-1).value(undefined, theme).render(120).join("\n");
    assert.match(text, /▸ group_bbb222/);
    assert.match(text, /partial/);
    assert.match(text, /3\/4/, "settled count = succeeded + failed + cancelled + partial");
  });

  it("retains a freshly finished group row but drops a stale one", async () => {
    const { refreshBackgroundTaskWidget } = await importSource(WIDGET_MODULE);
    const { ctx, calls } = makeCtx();
    // Fresh: completed 1s before the board was generated -> within the window.
    refreshBackgroundTaskWidget(ctx, makeBoard({
      generatedAtMs: 10_000,
      counts: { active: 0, stalled: 0, finished: 1 },
      finished: [makeEntry({ status: "succeeded", freshness: "terminal", description: "Check cache hit rates", completedAtMs: 9_000 })],
    }));
    assert.equal(typeof calls.at(-1).value, "function", "a just-settled row lingers briefly");
    assert.match(calls.at(-1).value(undefined, theme).render(120).join("\n"), /Check cache hit rates/);

    // Stale: completed 20s before the board -> past the 8s window -> dropped.
    refreshBackgroundTaskWidget(ctx, makeBoard({
      generatedAtMs: 30_000,
      counts: { active: 0, stalled: 0, finished: 1 },
      finished: [makeEntry({ status: "succeeded", freshness: "terminal", description: "Check cache hit rates", completedAtMs: 10_000 })],
    }));
    assert.equal(calls.at(-1).value, undefined, "a finished row past the retention window clears the widget");
  });

  it("auto-clears a finished-only widget after the retention window", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { refreshBackgroundTaskWidget, BACKGROUND_TASK_WIDGET_ID } = await importSource(WIDGET_MODULE);
    const { ctx, calls } = makeCtx();
    refreshBackgroundTaskWidget(ctx, makeBoard({
      generatedAtMs: 10_000,
      counts: { active: 0, stalled: 0, finished: 1 },
      finished: [makeEntry({ status: "succeeded", freshness: "terminal", description: "Done", completedAtMs: 9_000 })],
    }));

    const widget = calls.at(-1).value(undefined, theme);
    assert.equal(typeof widget.render, "function");
    t.mock.timers.tick(6_999);
    assert.equal(calls.length, 1, "retained row stays visible until its drop-off deadline");
    t.mock.timers.tick(1);
    assert.deepEqual(calls.at(-1), {
      id: BACKGROUND_TASK_WIDGET_ID,
      value: undefined,
      options: { placement: "belowEditor" },
    });
  });

  it("keeps the grouped widget within the visible row cap including the overflow line", async () => {
    const { refreshBackgroundTaskWidget } = await importSource(WIDGET_MODULE);
    const { ctx, calls } = makeCtx();
    refreshBackgroundTaskWidget(ctx, makeBoard({
      counts: { active: 9, stalled: 0, finished: 0 },
      active: Array.from({ length: 9 }, (_, i) => makeEntry({
        taskId: `task_${i}`,
        groupId: `group_abc00${i}`,
        description: `grouped task ${i}`,
        createdAtMs: i,
      })),
    }));

    const lines = calls.at(-1).value(undefined, theme).render(120);
    assert.ok(lines.length <= 8, `expected at most 8 visible rows, got ${lines.length}`);
    assert.match(lines.at(-1), /… \d+ more/);
  });

  it("renders a flat headerless list when no task belongs to a group", async () => {
    const { refreshBackgroundTaskWidget } = await importSource(WIDGET_MODULE);
    const { ctx, calls } = makeCtx();
    refreshBackgroundTaskWidget(ctx, makeBoard({
      counts: { active: 1, stalled: 0, finished: 0 },
      active: [makeEntry({ description: "ungrouped scout" })],
    }));
    const lines = calls.at(-1).value(undefined, theme).render(120);
    assert.doesNotMatch(lines.join("\n"), /▸/, "no section header when nothing is grouped");
    assert.match(lines[0], /^\S/, "ungrouped-only rows stay flush-left");
  });

  it("does nothing on a non-TUI surface", async () => {
    const { refreshBackgroundTaskWidget } = await importSource(WIDGET_MODULE);
    const calls = [];
    const ctx = { mode: "rpc", ui: { setWidget: (id, value) => calls.push({ id, value }) } };
    refreshBackgroundTaskWidget(ctx, makeBoard({ counts: { active: 1, stalled: 0, finished: 0 }, active: [makeEntry()] }));
    assert.equal(calls.length, 0);
  });

  it("animates active rows on a timer and stops on dispose", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const { refreshBackgroundTaskWidget } = await importSource(WIDGET_MODULE);
    const { ctx, calls } = makeCtx();
    refreshBackgroundTaskWidget(
      ctx,
      makeBoard({ counts: { active: 1, stalled: 0, finished: 0 }, active: [makeEntry()] }),
    );
    let renders = 0;
    const widget = calls.at(-1).value({ requestRender() { renders += 1; } }, theme);
    const frame0 = widget.render(80).join("\n");
    t.mock.timers.tick(80);
    const frame1 = widget.render(80).join("\n");
    assert.equal(renders, 1, "an active row schedules a re-render");
    assert.notEqual(frame0, frame1, "the loader glyph advances between frames");
    widget.dispose();
    t.mock.timers.tick(80);
    assert.equal(renders, 1, "dispose clears the animation timer");
  });
});
