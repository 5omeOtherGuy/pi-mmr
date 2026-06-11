// Worker tool guidance: the `## Using workers` augmentation block inserted
// after the built-in tool guidance block. It states the worker-delegation
// rules (don't spawn for single-response work, workers lose context,
// summarize results) and the blocking-vs-background policy ONCE, instead of
// repeating them inside every worker tool's Guidelines bullets. The block is
// mmr-core-authored and active only for worker tool names that actually
// appear in Pi's Available tools block.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const MODULE = "extensions/mmr-core/worker-tool-guidance.ts";

describe("buildUsingWorkersGuidance", () => {
  it("returns null when no worker tool is active", async () => {
    const { buildUsingWorkersGuidance } = await importSource(MODULE);
    assert.equal(buildUsingWorkersGuidance([]), null);
    assert.equal(buildUsingWorkersGuidance(["read", "bash", "edit"]), null);
  });

  it("emits the heading and core delegation rules when any worker is active", async () => {
    const { buildUsingWorkersGuidance, MMR_USING_WORKERS_HEADING } = await importSource(MODULE);
    const text = buildUsingWorkersGuidance(["finder"]);
    assert.ok(text.startsWith(MMR_USING_WORKERS_HEADING));
    assert.match(text, /complete directly in a single response/);
    assert.match(text, /do not see your conversation/i);
    assert.match(text, /summarize its result for the user/);
  });

  it("includes the blocking-vs-background policy only when a background-capable worker is active", async () => {
    const { buildUsingWorkersGuidance } = await importSource(MODULE);
    const withBackground = buildUsingWorkersGuidance(["Task", "task_poll"]);
    assert.match(withBackground, /background: true/);
    // oracle alone is never background-capable: no background policy.
    const oracleOnly = buildUsingWorkersGuidance(["oracle"]);
    assert.ok(oracleOnly !== null);
    assert.doesNotMatch(oracleOnly, /background: true/);
  });

  it("mentions oracle's always-blocking constraint only when oracle is active alongside background workers", async () => {
    const { buildUsingWorkersGuidance } = await importSource(MODULE);
    const withOracle = buildUsingWorkersGuidance(["finder", "oracle"]);
    assert.match(withOracle, /oracle is always blocking/);
    const withoutOracle = buildUsingWorkersGuidance(["finder"]);
    assert.doesNotMatch(withoutOracle, /oracle/);
  });

  it("includes result-delivery semantics only when poll/wait tools are active", async () => {
    const { buildUsingWorkersGuidance } = await importSource(MODULE);
    const withPoll = buildUsingWorkersGuidance(["Task", "task_poll", "task_wait"]);
    assert.match(withPoll, /terminal/);
    assert.match(withPoll, /stale/);
    const withoutPoll = buildUsingWorkersGuidance(["Task"]);
    assert.doesNotMatch(withoutPoll, /task_poll/);
  });

  it("never references the deprecated start_task alias", async () => {
    const { buildUsingWorkersGuidance } = await importSource(MODULE);
    const text = buildUsingWorkersGuidance([
      "Task",
      "finder",
      "librarian",
      "oracle",
      "start_task",
      "task_poll",
      "task_wait",
      "task_cancel",
    ]);
    assert.doesNotMatch(text, /start_task/);
  });
});

describe("extractActiveWorkerToolNames", () => {
  it("extracts known worker tool names (including capitalized Task) from an Available tools block", async () => {
    const { extractActiveWorkerToolNames } = await importSource(MODULE);
    const block = [
      "Available tools:",
      "- read: Read file contents",
      "- Task: Perform a bounded task in a subagent worker",
      "- finder: Intelligently search your codebase",
      "- task_poll: Poll one background task",
      "- unknown_custom: Something else",
    ].join("\n");
    assert.deepEqual(extractActiveWorkerToolNames(block), ["Task", "finder", "task_poll"]);
  });

  it("returns an empty list when no worker tools are listed", async () => {
    const { extractActiveWorkerToolNames } = await importSource(MODULE);
    assert.deepEqual(extractActiveWorkerToolNames("- read: Read file contents"), []);
  });
});
