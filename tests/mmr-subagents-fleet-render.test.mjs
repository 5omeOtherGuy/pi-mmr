import assert from "node:assert/strict";
import { homedir } from "node:os";
import { after, describe, it } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

initTheme(undefined, false);
after(cleanupLoadedSource);

const PROGRESS_RENDERING_MODULE = "extensions/mmr-subagents/progress-rendering.ts";

const fakeTheme = { fg: (_c, t) => t, bold: (t) => t, italic: (t) => t };
const stripAnsi = (t) => t.replace(/\u001b\[[0-9;]*m/g, "").replace(/\u001b\][^\u0007]*\u0007/g, "");
const renderLines = (component) => component.render(240).map(stripAnsi);
const renderText = (component) => renderLines(component).join("\n").replace(/[ \t]+/g, " ");
const makeContext = () => ({ args: {}, state: {}, cwd: `${homedir()}/projects/repo`, showImages: false, isError: false, executionStarted: true, argsComplete: true });

function fleetResult(sessionKey) {
  return {
    content: [{ type: "text", text: "start_task: set up 3 background workers across 2 groups; launching now." }],
    details: {
      worker: "mmr-subagents.async-task",
      tool: "start_task",
      ...(sessionKey !== undefined ? { sessionKey } : {}),
      fleet: {
        version: 1,
        totalTasks: 3,
        groups: [
          {
            groupId: "group_aaa001",
            label: "Group A",
            taskIds: ["t1", "t2"],
            rows: [
              { taskId: "t1", agent: "finder", description: "find routes" },
              { taskId: "t2", agent: "Task", description: "inspect handlers" },
            ],
          },
          {
            groupId: "group_bbb002",
            taskIds: ["t3"],
            rows: [{ taskId: "t3", agent: "librarian", description: "compare repos" }],
          },
        ],
      },
    },
  };
}

const boardEntry = (over) => ({
  freshness: "healthy", createdAtMs: 1, startedAtMs: 1, updatedAtMs: 1, runtimeMs: 1000, ...over,
});

describe("fleet inline card", () => {
  it("renders all groups in ready state up front, with the launch line (no live board)", async () => {
    const { renderMmrBackgroundTaskResult } = await importSource(PROGRESS_RENDERING_MODULE);
    const card = renderMmrBackgroundTaskResult(
      "start_task", fleetResult("s1"), { expanded: false, isPartial: false }, fakeTheme, makeContext(), undefined,
    );
    const text = renderText(card);
    assert.match(text, /▸ Group A · group_aaa001 +● ready · 0\/2/);
    // An unlabeled group borrows its earliest member's description as the label.
    assert.match(text, /▸ compare repos · group_bbb002 +● ready · 0\/1/);
    assert.match(text, /- finder find routes/);
    assert.match(text, /- Task inspect handlers/);
    assert.match(text, /- librarian compare repos/);
    assert.match(text, /All 3 agents set up across 2 groups\. Launching them now\./);
  });

  it("animates rows in place once the board shows them running (no launch line)", async () => {
    const { renderMmrBackgroundTaskResult } = await importSource(PROGRESS_RENDERING_MODULE);
    const board = {
      version: 1, generatedAtMs: 0, counts: { active: 3, stalled: 0, finished: 0 },
      active: [
        boardEntry({ taskId: "t1", status: "running", agent: "finder", description: "find routes", groupId: "group_aaa001", deferredLaunch: true }),
        boardEntry({ taskId: "t2", status: "running", agent: "Task", description: "inspect handlers", groupId: "group_aaa001", deferredLaunch: true }),
        boardEntry({ taskId: "t3", status: "running", agent: "librarian", description: "compare repos", groupId: "group_bbb002", deferredLaunch: true }),
      ],
      stalled: [], finished: [],
    };
    const groups = {
      group_aaa001: { groupId: "group_aaa001", status: "running", label: "Group A", generatedAtMs: 0, createdAtMs: 0, updatedAtMs: 0, completionPush: "pending", taskIds: ["t1", "t2"], counts: { running: 2, succeeded: 0, failed: 0, cancelled: 0, partial: 0, total: 2 } },
      group_bbb002: { groupId: "group_bbb002", status: "running", generatedAtMs: 0, createdAtMs: 0, updatedAtMs: 0, completionPush: "pending", taskIds: ["t3"], counts: { running: 1, succeeded: 0, failed: 0, cancelled: 0, partial: 0, total: 1 } },
    };
    const extras = { resolveBoard: () => board, resolveGroup: (_s, id) => groups[id] };
    const text = renderText(renderMmrBackgroundTaskResult(
      "start_task", fleetResult("s1"), { expanded: false, isPartial: false }, fakeTheme, makeContext(), extras,
    ));
    assert.match(text, /● running · 0\/2/);
    assert.doesNotMatch(text, /Launching them now/);
    assert.doesNotMatch(text, /- finder find routes/, "running rows no longer show the ready dash");
  });

  it("shows completed checks when the board settles", async () => {
    const { renderMmrBackgroundTaskResult } = await importSource(PROGRESS_RENDERING_MODULE);
    const board = {
      version: 1, generatedAtMs: 0, counts: { active: 0, stalled: 0, finished: 3 },
      active: [], stalled: [],
      finished: [
        boardEntry({ taskId: "t1", status: "succeeded", freshness: "terminal", agent: "finder", description: "find routes", completedAtMs: 0, groupId: "group_aaa001" }),
        boardEntry({ taskId: "t2", status: "succeeded", freshness: "terminal", agent: "Task", description: "inspect handlers", completedAtMs: 0, groupId: "group_aaa001" }),
        boardEntry({ taskId: "t3", status: "succeeded", freshness: "terminal", agent: "librarian", description: "compare repos", completedAtMs: 0, groupId: "group_bbb002" }),
      ],
    };
    const groups = {
      group_aaa001: { groupId: "group_aaa001", status: "completed", label: "Group A", generatedAtMs: 0, createdAtMs: 0, updatedAtMs: 0, completionPush: "pending", taskIds: ["t1", "t2"], counts: { running: 0, succeeded: 2, failed: 0, cancelled: 0, partial: 0, total: 2 } },
      group_bbb002: { groupId: "group_bbb002", status: "completed", generatedAtMs: 0, createdAtMs: 0, updatedAtMs: 0, completionPush: "pending", taskIds: ["t3"], counts: { running: 0, succeeded: 1, failed: 0, cancelled: 0, partial: 0, total: 1 } },
    };
    const extras = { resolveBoard: () => board, resolveGroup: (_s, id) => groups[id] };
    const text = renderText(renderMmrBackgroundTaskResult(
      "start_task", fleetResult("s1"), { expanded: false, isPartial: false }, fakeTheme, makeContext(), extras,
    ));
    assert.match(text, /● completed · 2\/2/);
    assert.match(text, /✓ finder find routes/);
    assert.doesNotMatch(text, /Launching them now/);
  });

  it("keeps declared row order even when a later member finishes first", async () => {
    const { renderMmrBackgroundTaskResult } = await importSource(PROGRESS_RENDERING_MODULE);
    const board = {
      version: 1, generatedAtMs: 0, counts: { active: 1, stalled: 0, finished: 1 },
      active: [boardEntry({ taskId: "t1", status: "running", agent: "finder", description: "find routes", groupId: "group_aaa001", deferredLaunch: true })],
      stalled: [],
      finished: [boardEntry({ taskId: "t2", status: "succeeded", freshness: "terminal", agent: "Task", description: "inspect handlers", completedAtMs: 0, groupId: "group_aaa001" })],
    };
    const groups = { group_aaa001: { groupId: "group_aaa001", status: "running", label: "Group A", generatedAtMs: 0, createdAtMs: 0, updatedAtMs: 0, completionPush: "pending", taskIds: ["t1", "t2"], counts: { running: 1, succeeded: 1, failed: 0, cancelled: 0, partial: 0, total: 2 } } };
    const extras = { resolveBoard: () => board, resolveGroup: (_s, id) => groups[id] };
    const lines = renderLines(renderMmrBackgroundTaskResult(
      "start_task", fleetResult("s1"), { expanded: false, isPartial: false }, fakeTheme, makeContext(), extras,
    ));
    const idxT1 = lines.findIndex((l) => l.includes("find routes"));
    const idxT2 = lines.findIndex((l) => l.includes("inspect handlers"));
    assert.ok(idxT1 >= 0 && idxT2 >= 0);
    assert.ok(idxT1 < idxT2, "declared order (t1 before t2) is preserved even though t2 finished first");
  });
});
