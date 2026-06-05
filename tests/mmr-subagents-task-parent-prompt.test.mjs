// Batch B #6: capture the parent turn's structured systemPromptOptions
// alongside the parent prompt string, so Task-worker diagnostics can classify
// the parent surface. Metadata only — never used to rebuild a prompt.
//
// Pins:
//   - captureTaskParentPrompt stores prompt + options atomically; options only
//     change when a non-empty prompt string is seen (never desynced).
//   - readParentPromptOptions validates the structural view (string-only
//     selectedTools, non-empty customPrompt; otherwise undefined).
//   - registerTaskParentPromptCapture wires before_agent_start and skips while
//     a subagent worker is active.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const TASK_MODULE = "extensions/mmr-subagents/task.ts";
const RUNTIME_MODULE = "extensions/mmr-core/runtime.ts";

describe("Task parent-prompt capture (#6)", () => {
  it("captures the system prompt and its structured options together", async () => {
    const m = await importSource(TASK_MODULE);
    m.captureTaskParentPrompt("PARENT PROMPT", { selectedTools: ["read", "bash"], customPrompt: "" });
    assert.equal(m.getTaskParentSystemPrompt(), "PARENT PROMPT");
    assert.deepEqual(m.getTaskParentSystemPromptOptions(), { selectedTools: ["read", "bash"] });
  });

  it("does not update either field for an empty or non-string prompt", async () => {
    const m = await importSource(TASK_MODULE);
    m.captureTaskParentPrompt("REAL PROMPT", { selectedTools: ["read"] });
    m.captureTaskParentPrompt("", { selectedTools: ["bash", "edit"] });
    m.captureTaskParentPrompt(undefined, { customPrompt: "x" });
    assert.equal(m.getTaskParentSystemPrompt(), "REAL PROMPT");
    assert.deepEqual(m.getTaskParentSystemPromptOptions(), { selectedTools: ["read"] });
  });

  it("captures a custom prompt and filters non-string selectedTools entries", async () => {
    const m = await importSource(TASK_MODULE);
    m.captureTaskParentPrompt("P", { selectedTools: ["read", 5, null, "bash"], customPrompt: "SYSTEM.md text" });
    assert.deepEqual(m.getTaskParentSystemPromptOptions(), {
      selectedTools: ["read", "bash"],
      customPrompt: "SYSTEM.md text",
    });
  });

  it("stores undefined options when the host supplies none or an invalid shape", async () => {
    const m = await importSource(TASK_MODULE);
    m.captureTaskParentPrompt("P", undefined);
    assert.equal(m.getTaskParentSystemPromptOptions(), undefined);
    m.captureTaskParentPrompt("P2", { selectedTools: "not-an-array" });
    assert.equal(m.getTaskParentSystemPromptOptions(), undefined);
  });

  it("preserves an empty selectedTools array as distinct from not-supplied", async () => {
    const m = await importSource(TASK_MODULE);
    m.captureTaskParentPrompt("P", { selectedTools: [] });
    assert.deepEqual(m.getTaskParentSystemPromptOptions(), { selectedTools: [] });
  });

  it("registers a before_agent_start handler that captures, and skips inside a subagent worker", async () => {
    const m = await importSource(TASK_MODULE);
    const runtime = await importSource(RUNTIME_MODULE);
    const handlers = new Map();
    m.registerTaskParentPromptCapture({ on: (name, fn) => handlers.set(name, fn) });
    const handler = handlers.get("before_agent_start");
    assert.equal(typeof handler, "function");

    // Parent turn: captures from the event.
    m.captureTaskParentPrompt("SEED", { selectedTools: ["seed"] });
    handler({ systemPrompt: "FROM EVENT", systemPromptOptions: { selectedTools: ["read", "write"] } });
    assert.equal(m.getTaskParentSystemPrompt(), "FROM EVENT");
    assert.deepEqual(m.getTaskParentSystemPromptOptions(), { selectedTools: ["read", "write"] });

    // Inside a subagent worker: the handler must not overwrite parent state.
    runtime.setMmrSubagentState({ profileName: "Task", activeTools: [] });
    try {
      handler({ systemPrompt: "WORKER PROMPT", systemPromptOptions: { selectedTools: ["grep"] } });
    } finally {
      runtime.setMmrSubagentState(undefined);
    }
    assert.equal(m.getTaskParentSystemPrompt(), "FROM EVENT");
    assert.deepEqual(m.getTaskParentSystemPromptOptions(), { selectedTools: ["read", "write"] });
  });
});
