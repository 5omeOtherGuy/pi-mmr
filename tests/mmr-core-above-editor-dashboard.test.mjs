import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

const MODULE = "extensions/mmr-core/above-editor-dashboard.ts";

after(cleanupLoadedSource);

describe("above-editor dashboard", () => {
  let mod;
  beforeEach(async () => {
    mod = await importSource(MODULE);
    mod.resetAboveEditorDashboardForTest();
  });

  function makeCtx() {
    const calls = [];
    return {
      calls,
      ctx: {
        ui: {
          setWidget(id, value, options) {
            calls.push({ id, value, options });
          },
        },
      },
    };
  }

  it("keeps a single active slot as its standalone widget", () => {
    const { ctx, calls } = makeCtx();
    mod.updateAboveEditorDashboardSlot(ctx, "left", "task", ["todo"]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, "task");
    assert.deepEqual(calls[0].value, ["todo"]);
    assert.deepEqual(calls[0].options, { placement: "aboveEditor" });
  });

  it("combines task-list left and background agents right when both slots are active", () => {
    const { ctx, calls } = makeCtx();
    mod.updateAboveEditorDashboardSlot(ctx, "left", "task", ["⠋ Task one", "– Task two"]);
    mod.updateAboveEditorDashboardSlot(ctx, "right", "background", ["▸ Group ● running · 1/2", "  ⠋ finder Worker"]);

    const dashboardCall = calls.at(-1);
    assert.equal(dashboardCall.id, mod.ABOVE_EDITOR_DASHBOARD_WIDGET_ID);
    assert.equal(typeof dashboardCall.value, "function");
    const widget = dashboardCall.value({}, {});
    const lines = widget.render(100);
    assert.match(lines[0], /^⠋ Task one +│ ▸ Group ● running · 1\/2/);
    assert.match(lines[1], /^– Task two +│   ⠋ finder Worker/);
  });

  it("returns to the remaining standalone widget when one slot clears", () => {
    const { ctx, calls } = makeCtx();
    mod.updateAboveEditorDashboardSlot(ctx, "left", "task", ["todo"]);
    mod.updateAboveEditorDashboardSlot(ctx, "right", "background", ["agent"]);
    mod.updateAboveEditorDashboardSlot(ctx, "right", "background", undefined);

    const last = calls.at(-1);
    assert.equal(last.id, "task");
    assert.deepEqual(last.value, ["todo"]);
  });

  it("combines slots across cache-isolated extension module instances", async () => {
    const leftModule = await importSource(MODULE);
    const rightModule = await importSource(MODULE);
    leftModule.resetAboveEditorDashboardForTest();
    const { ctx, calls } = makeCtx();

    leftModule.updateAboveEditorDashboardSlot(ctx, "left", "task", ["⠋ Task one"]);
    rightModule.updateAboveEditorDashboardSlot(ctx, "right", "background", ["▸ Group ● running · 1/2"]);

    const dashboardCall = calls.at(-1);
    assert.equal(dashboardCall.id, leftModule.ABOVE_EDITOR_DASHBOARD_WIDGET_ID);
    assert.equal(typeof dashboardCall.value, "function");
    const lines = dashboardCall.value({}, {}).render(100);
    assert.match(lines[0], /^⠋ Task one +│ ▸ Group ● running · 1\/2/);
  });

  it("stacks instead of column-splitting on narrow widths", () => {
    const { ctx, calls } = makeCtx();
    mod.updateAboveEditorDashboardSlot(ctx, "left", "task", ["todo"]);
    mod.updateAboveEditorDashboardSlot(ctx, "right", "background", ["agent"]);
    const widget = calls.at(-1).value({}, {});
    assert.deepEqual(widget.render(40), ["todo", "agent"]);
  });
});
