import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

// Issue #8: capability-aware tool parallelism.
//
// pi-mmr cannot change Pi's built-in bash/edit/write execution modes (no
// extension API exists for that in this Pi version), but it CAN mark the
// tools it registers. Pi's agent loop runs the WHOLE assistant tool-call
// batch sequentially when any called tool declares
// `executionMode: "sequential"`. So marking pi-mmr's mutating/workflow
// tools sequential forces ordered execution for any turn that includes
// one, while batches of purely read-only tools stay parallel-eligible.
//
// The issue explicitly requires that independent read-only discovery —
// including read-only subagent research and web lookups — remain
// parallel-eligible, so those tools must NOT be marked sequential.

describe("mmr tool execution-mode policy (#8)", () => {
  it("marks workspace-mutating / session-state-mutating tools sequential", async () => {
    const { createApplyPatchTool } = await importSource("extensions/mmr-patch/apply-patch-tool.ts");
    const { createTodoListTool } = await importSource("extensions/mmr-tasks/todo-list-tool.ts");

    const applyPatch = createApplyPatchTool();
    assert.equal(applyPatch.executionMode, "sequential", "apply_patch mutates the workspace and must be sequential");

    // task_list is whole-list replacement: concurrent calls would race the
    // stored session list. Construction only stores the pi handle.
    const taskList = createTodoListTool({ pi: {} });
    assert.equal(taskList.executionMode, "sequential", "task_list mutates session state and must be sequential");
  });

  it("marks the Task workflow worker sequential (it can run bash/edit/write)", async () => {
    const { createTaskTool } = await importSource("extensions/mmr-subagents/task.ts");
    const task = createTaskTool();
    assert.equal(task.executionMode, "sequential", "Task workers can mutate the workspace and must be sequential");
  });

  it("keeps read-only subagent research tools parallel-eligible", async () => {
    const { createFinderTool } = await importSource("extensions/mmr-subagents/finder.ts");
    const { createOracleTool } = await importSource("extensions/mmr-subagents/oracle.ts");
    const { createLibrarianTool } = await importSource("extensions/mmr-subagents/librarian.ts");

    for (const [name, tool] of [
      ["finder", createFinderTool()],
      ["oracle", createOracleTool()],
      ["librarian", createLibrarianTool()],
    ]) {
      assert.notEqual(
        tool.executionMode,
        "sequential",
        `${name} is read-only research and must stay parallel-eligible`,
      );
    }
  });

  it("keeps read-only web lookup tools parallel-eligible", async () => {
    const { createWebSearchTool, createReadWebPageTool } = await importSource("extensions/mmr-web/tools.ts");
    const deps = { getSettings: () => ({}) };
    assert.notEqual(createWebSearchTool(deps).executionMode, "sequential", "web_search is a read-only lookup");
    assert.notEqual(createReadWebPageTool(deps).executionMode, "sequential", "read_web_page is a read-only lookup");
  });
});
