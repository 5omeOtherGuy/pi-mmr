import assert from "node:assert/strict";
import path from "node:path";
import { after, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { cleanupLoadedSource, getPreparedSourceRoot, importSource } from "./helpers/load-src.mjs";

const WIDGET_MODULE = "extensions/mmr-async-tasks/background-task-widget.ts";
const ABOVE_EDITOR_DASHBOARD_MODULE = "extensions/mmr-core/above-editor-dashboard.ts";
const ABOVE_EDITOR_ORDER_MODULE = "extensions/mmr-core/above-editor-order.ts";

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

  it("re-asserts lower aboveEditor widgets after setting itself, so they re-append below it", async () => {
    const { refreshBackgroundTaskWidget, BACKGROUND_TASK_WIDGET_ID } = await importSource(WIDGET_MODULE);
    // Import the SAME coordinator instance the widget module imports (stable
    // URL, no cache-bust query) so our registration is visible to its reassert.
    const orderUrl = pathToFileURL(path.join(getPreparedSourceRoot(), ABOVE_EDITOR_ORDER_MODULE)).href;
    const order = await import(orderUrl);
    order.resetLowerAboveEditorWidgetsForTest();
    const { ctx, calls } = makeCtx();
    order.registerLowerAboveEditorWidget("task_list", (c) => {
      c.ui.setWidget("task_list", () => ({ render: () => [] }), { placement: "aboveEditor" });
    });
    try {
      refreshBackgroundTaskWidget(
        ctx,
        makeBoard({ counts: { active: 1, stalled: 0, finished: 0 }, active: [makeEntry()] }),
      );
    } finally {
      order.resetLowerAboveEditorWidgetsForTest();
    }
    // Pi renders aboveEditor widgets in insertion order (top→bottom) and
    // re-appends the just-set widget to the bottom. The background widget set
    // itself first, then the lower widget re-emitted, so the task_list lands
    // AFTER (below) the background widget.
    const bgIdx = calls.findIndex((c) => c.id === BACKGROUND_TASK_WIDGET_ID && typeof c.value === "function");
    const tlIdx = calls.findIndex((c) => c.id === "task_list");
    assert.ok(bgIdx >= 0, "the background widget was set");
    assert.ok(tlIdx >= 0, "the lower widget re-asserted itself");
    assert.ok(bgIdx < tlIdx, "the background widget stays above the task_list widget");
  });

  it("uses the combined dashboard row budget so three finder groups fit beside an 11-row task list", async () => {
    const { refreshBackgroundTaskWidget } = await importSource(WIDGET_MODULE);
    const dashboard = await importSource(ABOVE_EDITOR_DASHBOARD_MODULE);
    dashboard.resetAboveEditorDashboardForTest();
    const { ctx, calls } = makeCtx();
    dashboard.updateAboveEditorDashboardSlot(ctx, "left", "pi-mmr-task-list", [
      "⠋ Reviewing finder test group 1",
      "  ├─ – Finder test 1",
      "  ├─ – Finder test 2",
      "  └─ – Finder test 3",
      "– Review finder test group 2",
      "  ├─ – Finder test 4",
      "  ├─ – Finder test 5",
      "  └─ – Finder test 6",
      "– Review finder test group 3",
      "  ├─ – Finder test 7",
      "  └─ – Finder test 8",
    ]);
    const now = Date.now();
    const entries = [
      ["t1", "group_1", "Finder test 1"],
      ["t2", "group_1", "Finder test 2"],
      ["t3", "group_1", "Finder test 3"],
      ["t4", "group_2", "Finder test 4"],
      ["t5", "group_2", "Finder test 5"],
      ["t6", "group_2", "Finder test 6"],
      ["t7", "group_3", "Finder test 7"],
      ["t8", "group_3", "Finder test 8"],
    ].map(([taskId, groupId, description]) => makeEntry({
      taskId,
      groupId,
      description,
      createdAtMs: now - 100_000,
      startedAtMs: now - 100_000,
      updatedAtMs: now,
      runtimeMs: 12_000,
    }));
    refreshBackgroundTaskWidget(
      ctx,
      makeBoard({ generatedAtMs: now, counts: { active: 8, stalled: 0, finished: 0 }, active: entries }),
      (groupId) => ({
        groupId,
        status: "running",
        label: groupId === "group_1" ? "Finder test group 1" : groupId === "group_2" ? "Finder test group 2" : "Finder test group 3",
        counts: { running: groupId === "group_3" ? 2 : 3, succeeded: 0, failed: 0, cancelled: 0, partial: 0, total: groupId === "group_3" ? 2 : 3 },
      }),
    );

    const widget = calls.at(-1).value({ requestRender() {} }, theme);
    const text = widget.render(140).join("\n");
    assert.match(text, /Finder test group 2/);
    assert.match(text, /Finder test group 3/);
    assert.doesNotMatch(text, /… 5 more/);
    dashboard.resetAboveEditorDashboardForTest();
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
    assert.deepEqual(last.options, { placement: "aboveEditor" }, "background agents render above the editor, above the task list");
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
    // The synthesized label leads with the earliest-created row's description.
    assert.match(text, /group_aaa111/);
    assert.match(text, /▸ Diff recent deploys · group_aaa111/);
    assert.match(text, /running/);
    assert.match(text, /1\/2/);
    // Capability profile is a row chip; the group id is NOT repeated per row.
    assert.match(text, /read-only/);
    assert.match(text, /read-write/);
    const rowLines = lines.filter((l) => /^ {2}\S/.test(l) && /Explore order services|Diff recent deploys/.test(l));
    assert.equal(rowLines.length, 2, "both grouped rows render");
    for (const l of rowLines) assert.match(l, /^ {2}\S/, "group members are indented under the header");
    for (const l of rowLines) {
      assert.equal((l.match(/group_aaa111/g) ?? []).length, 0, "group id is not a per-row chip");
    }
    // running sorts above settled within a group (compare row lines, since the
    // header now also mentions the earliest row's description).
    assert.match(rowLines[0], /Explore order services/, "non-terminal row sorts first inside a group");
    assert.match(rowLines[1], /Diff recent deploys/, "settled row sorts after the running one");
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

  it("renders <label> · <id> in the header when the resolver supplies a label", async () => {
    const { refreshBackgroundTaskWidget } = await importSource(WIDGET_MODULE);
    const { ctx, calls } = makeCtx();
    refreshBackgroundTaskWidget(
      ctx,
      makeBoard({
        counts: { active: 1, stalled: 0, finished: 0 },
        active: [makeEntry({ groupId: "group_ccc333", description: "scout" })],
      }),
      (groupId) => groupId === "group_ccc333"
        ? { status: "running", counts: { running: 1, succeeded: 0, failed: 0, cancelled: 0, partial: 0, total: 1 }, label: "Explore pricing engine" }
        : undefined,
    );
    const text = calls.at(-1).value(undefined, theme).render(120).join("\n");
    assert.match(text, /▸ Explore pricing engine · group_\w+/, "label leads, id trails in the header");
  });

  it("renders an id-only header when the resolver supplies no label", async () => {
    const { refreshBackgroundTaskWidget } = await importSource(WIDGET_MODULE);
    const { ctx, calls } = makeCtx();
    refreshBackgroundTaskWidget(
      ctx,
      makeBoard({
        counts: { active: 1, stalled: 0, finished: 0 },
        active: [makeEntry({ groupId: "group_ddd444", description: "scout" })],
      }),
      (groupId) => groupId === "group_ddd444"
        ? { status: "running", counts: { running: 1, succeeded: 0, failed: 0, cancelled: 0, partial: 0, total: 1 } }
        : undefined,
    );
    const lines = calls.at(-1).value(undefined, theme).render(120);
    const header = lines.find((l) => /▸/.test(l));
    assert.ok(header, "a section header renders");
    assert.match(header, /^▸ group_\w+\s+●/, "header begins with ▸ <id> directly, no stray label · separator");
  });

  it("truncates a long group label to the label width cap", async () => {
    const { refreshBackgroundTaskWidget } = await importSource(WIDGET_MODULE);
    const { ctx, calls } = makeCtx();
    const longLabel = "Investigate " + "x".repeat(70); // 82 chars; well over the 40-char cap
    refreshBackgroundTaskWidget(
      ctx,
      makeBoard({
        counts: { active: 1, stalled: 0, finished: 0 },
        active: [makeEntry({ groupId: "group_eee555", description: "scout" })],
      }),
      (groupId) => groupId === "group_eee555"
        ? { status: "running", counts: { running: 1, succeeded: 0, failed: 0, cancelled: 0, partial: 0, total: 1 }, label: longLabel }
        : undefined,
    );
    // Render wide enough that truncation comes from the 40-char label cap, not terminal width.
    const text = calls.at(-1).value(undefined, theme).render(200).join("\n");
    assert.doesNotMatch(text, new RegExp(longLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the full label is not rendered");
    assert.match(text, /…/, "an over-cap label is truncated with a trailing ellipsis");
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
      options: { placement: "aboveEditor" },
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

  it("omits a section whose rows are still in the invisible prep window", async () => {
    const { refreshBackgroundTaskWidget } = await importSource(WIDGET_MODULE);
    const { ctx, calls } = makeCtx();
    // An ACTIVE row with createdAtMs in the future => Date.now() is before its
    // settle window for the test's duration, so revealedRows reveals nothing and
    // the whole section (header + rows) is omitted while the clear/animation
    // decision stays on the real rows.
    const future = Date.now() + 10_000;
    refreshBackgroundTaskWidget(ctx, makeBoard({
      counts: { active: 1, stalled: 0, finished: 0 },
      active: [makeEntry({
        taskId: "task_future", agent: "finder", description: "Prep window scout",
        groupId: "group_prep01", createdAtMs: future, startedAtMs: future, updatedAtMs: future,
      })],
    }));
    const last = calls.at(-1);
    assert.equal(typeof last.value, "function", "active rows keep the widget mounted during prep");
    const lines = last.value({ requestRender() {} }, theme).render(120);
    const text = lines.join("\n");
    assert.equal(lines.length, 0, "a prep-window section renders no lines at all");
    assert.doesNotMatch(text, /Prep window scout/, "the row is hidden during prep");
    assert.doesNotMatch(text, /group_prep01/, "the header is hidden during prep too");
  });

  it("reveals a finished-only section immediately even with a recent createdAtMs (no animation clock)", async () => {
    const { refreshBackgroundTaskWidget } = await importSource(WIDGET_MODULE);
    const { ctx, calls } = makeCtx();
    // A group that just settled has recent createdAtMs but NO active row, so the
    // widget runs no animation interval. Staging it would leave it blank with no
    // future tick to reveal it, so revealedRows shows every row at once.
    const recent = Date.now();
    refreshBackgroundTaskWidget(ctx, makeBoard({
      generatedAtMs: recent,
      counts: { active: 0, stalled: 0, finished: 1 },
      finished: [makeEntry({
        taskId: "task_settled", agent: "finder", description: "Just finished scout",
        status: "succeeded", freshness: "terminal", groupId: "group_done01",
        createdAtMs: recent, startedAtMs: recent, updatedAtMs: recent, completedAtMs: recent,
      })],
    }));
    const text = calls.at(-1).value({ requestRender() {} }, theme).render(120).join("\n");
    assert.match(text, /Just finished scout/, "a finished-only section is never stuck blank");
    assert.match(text, /group_done01/, "its header renders immediately too");
  });

  it("does nothing on a non-TUI surface", async () => {
    const { refreshBackgroundTaskWidget } = await importSource(WIDGET_MODULE);
    const calls = [];
    const ctx = { mode: "rpc", ui: { setWidget: (id, value) => calls.push({ id, value }) } };
    refreshBackgroundTaskWidget(ctx, makeBoard({ counts: { active: 1, stalled: 0, finished: 0 }, active: [makeEntry()] }));
    assert.equal(calls.length, 0);
  });

  it("advances the displayed elapsed chip across render ticks for an active row", async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000 });
    const { refreshBackgroundTaskWidget } = await importSource(WIDGET_MODULE);
    const { ctx, calls } = makeCtx();
    refreshBackgroundTaskWidget(
      ctx,
      makeBoard({
        generatedAtMs: 1_000,
        counts: { active: 1, stalled: 0, finished: 0 },
        active: [makeEntry({ runtimeMs: 0 })],
      }),
    );
    const widget = calls.at(-1).value({ requestRender() {} }, theme);
    assert.match(widget.render(80).join("\n"), /· 0s/, "chip starts at the snapshot runtime");
    t.mock.timers.tick(1_000);
    assert.match(widget.render(80).join("\n"), /· 1s/, "chip ticks up 1s after a 1000ms tick");
    t.mock.timers.tick(64_000);
    assert.match(widget.render(80).join("\n"), /· 1m5s/, "chip reflects 65s of elapsed wall time");
    widget.dispose();
  });

  it("freezes the elapsed chip of a terminal row across render ticks", async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000 });
    const { refreshBackgroundTaskWidget } = await importSource(WIDGET_MODULE);
    const { ctx, calls } = makeCtx();
    refreshBackgroundTaskWidget(
      ctx,
      makeBoard({
        generatedAtMs: 1_000,
        // One active row keeps the animation timer alive; the terminal row is
        // freshly settled so it lingers within the retention window.
        counts: { active: 1, stalled: 0, finished: 1 },
        active: [makeEntry({ taskId: "task_live", description: "still running", runtimeMs: 0 })],
        finished: [makeEntry({
          taskId: "task_done", description: "all finished", status: "succeeded",
          freshness: "terminal", runtimeMs: 5_000, completedAtMs: 1_000,
        })],
      }),
    );
    const widget = calls.at(-1).value({ requestRender() {} }, theme);
    const doneLine = () => widget.render(120).find((l) => /all finished/.test(l));
    assert.match(doneLine(), /· 5s/, "terminal row shows its final runtime");
    t.mock.timers.tick(64_000);
    assert.match(doneLine(), /· 5s/, "terminal row's chip does NOT advance with wall time");
    widget.dispose();
  });

  it("falls back to the static runtime when the board timestamp is missing", async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 50_000 });
    const { refreshBackgroundTaskWidget } = await importSource(WIDGET_MODULE);
    const { ctx, calls } = makeCtx();
    refreshBackgroundTaskWidget(
      ctx,
      makeBoard({
        generatedAtMs: 0,
        counts: { active: 1, stalled: 0, finished: 0 },
        active: [makeEntry({ runtimeMs: 3_000 })],
      }),
    );
    const widget = calls.at(-1).value({ requestRender() {} }, theme);
    assert.match(widget.render(80).join("\n"), /· 3s/, "a zero/garbage board timestamp falls back to static runtime");
    t.mock.timers.tick(64_000);
    assert.match(widget.render(80).join("\n"), /· 3s/, "no live delta is applied without a valid board timestamp");
    widget.dispose();
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
