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
