// Positive import-presence guard for the public `todo-list-tool` surface.
//
// PR A decomposes `extensions/mmr-toolbox/todo-list-tool.ts` into focused leaf
// modules (`todo-list-contract`, `todo-list-rendering`, `todo-list-widget`)
// while keeping the entry file a thin compatibility shell. This test pins that
// every previously-exported public symbol stays importable from the same
// `todo-list-tool.js` path after the split. The companion negative guard
// (`mmr-pi-root-todo-exports.test.mjs`) only asserts the legacy coordination
// surface is gone, so it does not cover the positive surface.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

describe("mmr-toolbox todo-list-tool public surface stays importable", () => {
  it("re-exports the documented runtime symbols from todo-list-tool.js", async () => {
    const mod = await importSource("extensions/mmr-toolbox/todo-list-tool.ts");

    assert.equal(typeof mod.createTodoListTool, "function", "createTodoListTool");
    assert.equal(typeof mod.refreshTodoWidget, "function", "refreshTodoWidget");
    assert.equal(typeof mod.isTuiWidgetSurface, "function", "isTuiWidgetSurface");
    assert.equal(typeof mod.taskStatusGlyph, "function", "taskStatusGlyph");
    assert.equal(typeof mod.TodoValidationError, "function", "TodoValidationError");
    assert.equal(mod.TASK_LIST_WIDGET_ID, "pi-mmr-task-list", "TASK_LIST_WIDGET_ID");
    assert.equal(typeof mod.TASK_LIST_DESCRIPTION, "string", "TASK_LIST_DESCRIPTION");
    assert.equal(typeof mod.TASK_LIST_PROMPT_SNIPPET, "string", "TASK_LIST_PROMPT_SNIPPET");
    assert.ok(Array.isArray(mod.TASK_LIST_PROMPT_GUIDELINES), "TASK_LIST_PROMPT_GUIDELINES");
    assert.ok(mod.TASK_LIST_PARAMS && typeof mod.TASK_LIST_PARAMS === "object", "TASK_LIST_PARAMS");
  });
});
