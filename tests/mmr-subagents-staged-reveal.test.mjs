import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

const VIEW_MODULE = "extensions/mmr-async-tasks/background-task-view.ts";

after(cleanupLoadedSource);

/** Minimal WidgetRow with only the fields revealedRows reads. */
function row(createdAtMs, overrides = {}) {
  return {
    taskId: `task_${createdAtMs}`,
    status: "running",
    freshness: "healthy",
    agent: "finder",
    description: "",
    runtimeMs: 0,
    createdAtMs,
    ...overrides,
  };
}

const ids = (rows) => rows.map((r) => r.taskId);

describe("revealedRows", () => {
  it("exports the tunable cadence constants", async () => {
    const { SPAWN_SETTLE_MS, REVEAL_INTERVAL_MS } = await importSource(VIEW_MODULE);
    assert.equal(SPAWN_SETTLE_MS, 200);
    assert.equal(REVEAL_INTERVAL_MS, 70);
  });

  it("returns [] for an empty row-set", async () => {
    const { revealedRows } = await importSource(VIEW_MODULE);
    assert.deepEqual(revealedRows([], 1_000_000), []);
  });

  it("returns nothing before the earliest row's settle window (invisible prep)", async () => {
    const { revealedRows, SPAWN_SETTLE_MS } = await importSource(VIEW_MODULE);
    const rows = [row(100), row(200), row(300)];
    // The earliest spawn (createdAtMs 100) is the first to reveal, at 100+settle.
    assert.deepEqual(revealedRows(rows, 100 + SPAWN_SETTLE_MS - 1), []);
    assert.deepEqual(revealedRows(rows, 0), []);
  });

  it("reveals rows one at a time in spawn order on the cadence", async () => {
    const { revealedRows, SPAWN_SETTLE_MS, REVEAL_INTERVAL_MS } = await importSource(VIEW_MODULE);
    const rows = [row(0), row(0), row(0), row(0)];
    const base = SPAWN_SETTLE_MS;
    assert.equal(revealedRows(rows, base - 1).length, 0);
    assert.equal(revealedRows(rows, base).length, 1);
    assert.equal(revealedRows(rows, base + REVEAL_INTERVAL_MS).length, 2);
    assert.equal(revealedRows(rows, base + 2 * REVEAL_INTERVAL_MS).length, 3);
    assert.equal(revealedRows(rows, base + 3 * REVEAL_INTERVAL_MS).length, 4);
    // Clamps: never exceeds the row count no matter how far past.
    assert.equal(revealedRows(rows, base + 100 * REVEAL_INTERVAL_MS).length, 4);
  });

  it("reveals ALL rows immediately when no row is active (no animation clock to tick)", async () => {
    const { revealedRows } = await importSource(VIEW_MODULE);
    // A freshly-spawned-looking but already-terminal set (e.g. a task that
    // finished within the settle window, or a settled group): there is no
    // active worker driving re-renders, so staging it could leave the surface
    // permanently blank. Reveal everything at once instead.
    const now = 1_000;
    const finished = [
      row(now, { taskId: "a", status: "succeeded" }),
      row(now, { taskId: "b", status: "failed" }),
      row(now, { taskId: "c", status: "cancelled" }),
    ];
    assert.deepEqual(ids(revealedRows(finished, now)), ["a", "b", "c"]);
  });

  it("preserves the caller's display order; reveal timing is decoupled from it", async () => {
    const { revealedRows, SPAWN_SETTLE_MS, REVEAL_INTERVAL_MS } = await importSource(VIEW_MODULE);
    // Display order = running-first (a settled row sorts last for display) while
    // spawn order = createdAtMs. The earliest-spawned row reveals first even
    // though it is displayed last.
    const rows = [
      row(50, { taskId: "running_new", status: "running" }),
      row(10, { taskId: "settled_old", status: "succeeded" }),
    ];
    // anyActive (running_new) => staged. spawn order: settled_old(10), running_new(50).
    const atFirst = revealedRows(rows, 10 + SPAWN_SETTLE_MS);
    assert.deepEqual(ids(atFirst), ["settled_old"], "earliest spawn reveals first regardless of display position");
    const atSecond = revealedRows(rows, 50 + SPAWN_SETTLE_MS + REVEAL_INTERVAL_MS);
    assert.deepEqual(ids(atSecond), ["running_new", "settled_old"], "output keeps the caller's display order");
  });

  it("does NOT hide already-revealed rows when a late sibling joins mid-reveal", async () => {
    const { revealedRows, SPAWN_SETTLE_MS, REVEAL_INTERVAL_MS } = await importSource(VIEW_MODULE);
    const early = [row(0, { taskId: "x" }), row(0, { taskId: "y" })];
    const now = SPAWN_SETTLE_MS + REVEAL_INTERVAL_MS; // x and y both revealed
    assert.deepEqual(ids(revealedRows(early, now)), ["x", "y"]);
    // A late sibling spawns far later and joins the set at the same `now`.
    const withLate = [...early, row(now, { taskId: "z" })];
    const after = revealedRows(withLate, now);
    assert.ok(after.some((r) => r.taskId === "x"), "x stays revealed");
    assert.ok(after.some((r) => r.taskId === "y"), "y stays revealed");
    assert.ok(!after.some((r) => r.taskId === "z"), "the late sibling only delays itself");
  });

  it("keeps a row revealed after it transitions to terminal mid-reveal", async () => {
    const { revealedRows, SPAWN_SETTLE_MS } = await importSource(VIEW_MODULE);
    // First row settles to succeeded while a later sibling is still running:
    // the set still has an active row (staged), and the terminal row keeps its
    // spawn-order threshold, so it does not drop out of the revealed prefix.
    const rows = [
      row(0, { taskId: "done", status: "succeeded" }),
      row(0, { taskId: "live", status: "running" }),
    ];
    const revealed = revealedRows(rows, SPAWN_SETTLE_MS);
    assert.deepEqual(ids(revealed), ["done"], "the settled earliest-spawn row stays in the revealed prefix");
  });

  it("reveals ALL ready rows immediately (declared up front, before any launch)", async () => {
    const { revealedRows } = await importSource(VIEW_MODULE);
    // A freshly declared fleet: every row is `ready`, nothing is running yet.
    const ready = [
      row(1000, { taskId: "a", status: "ready" }),
      row(1000, { taskId: "b", status: "ready" }),
      row(1000, { taskId: "c", status: "ready" }),
    ];
    // Even at the instant of declaration (no settle elapsed), all show.
    assert.deepEqual(ids(revealedRows(ready, 1000)), ["a", "b", "c"]);
  });

  it("keeps declared rows shown across the ready->running flip (animate in place)", async () => {
    const { revealedRows } = await importSource(VIEW_MODULE);
    // Fleet rows are marked deferredLaunch: declared up front, then launched
    // together. The instant they flip to running they must NOT re-stage and
    // disappear — they animate in place at their fixed positions.
    const now = 1000; // == createdAtMs, i.e. launched the same tick as declared
    const running = [
      row(now, { taskId: "a", status: "running", deferredLaunch: true }),
      row(now, { taskId: "b", status: "running", deferredLaunch: true }),
      row(now, { taskId: "c", status: "running", deferredLaunch: true }),
    ];
    assert.deepEqual(ids(revealedRows(running, now)), ["a", "b", "c"]);
  });

  it("shows ready rows while still staging a mixed legacy running sibling", async () => {
    const { revealedRows, SPAWN_SETTLE_MS } = await importSource(VIEW_MODULE);
    // A declared ready row coexists with a freshly-spawned legacy running row
    // (no deferredLaunch). The ready row always shows; the legacy row stages.
    const rows = [
      row(2000, { taskId: "ready", status: "ready" }),
      row(2000, { taskId: "legacy", status: "running" }),
    ];
    const before = revealedRows(rows, 2000); // settle not elapsed for legacy
    assert.ok(before.some((r) => r.taskId === "ready"), "ready row shows immediately");
    assert.ok(!before.some((r) => r.taskId === "legacy"), "legacy running row still staging");
    const after = revealedRows(rows, 2000 + SPAWN_SETTLE_MS);
    assert.deepEqual(ids(after).sort(), ["legacy", "ready"], "legacy reveals once its settle elapses");
  });

  it("reveals in lockstep for two groups whose members share the same spawn times", async () => {
    const { revealedRows, SPAWN_SETTLE_MS, REVEAL_INTERVAL_MS } = await importSource(VIEW_MODULE);
    // A one-step fan-out lands sibling rows at near-identical createdAtMs; model
    // that as identical spawn times across two groups.
    const groupA = [row(100, { taskId: "a0" }), row(100, { taskId: "a1" }), row(100, { taskId: "a2" })];
    const groupB = [row(100, { taskId: "b0" }), row(100, { taskId: "b1" }), row(100, { taskId: "b2" })];
    for (const offset of [0, REVEAL_INTERVAL_MS, 2 * REVEAL_INTERVAL_MS, 5 * REVEAL_INTERVAL_MS]) {
      const now = 100 + SPAWN_SETTLE_MS + offset;
      assert.equal(
        revealedRows(groupA, now).length,
        revealedRows(groupB, now).length,
        `lockstep at offset ${offset}`,
      );
    }
  });
});
