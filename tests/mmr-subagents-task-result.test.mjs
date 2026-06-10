import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

const RESULT_MODULE = "extensions/mmr-subagents/task-result.ts";
const TASK_MODULE = "extensions/mmr-subagents/task.ts";

after(cleanupLoadedSource);

const EMPTY_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };

/** Completed worker result: clean exit, usable final text. */
function makeWorkerResult(overrides = {}) {
  return {
    messages: [],
    finalOutput: "worker answer",
    truncatedFinalOutput: "worker answer",
    usage: EMPTY_USAGE,
    trail: [],
    prompt: "do the thing",
    cwd: "/repo",
    command: "pi",
    args: [],
    exitCode: 0,
    signal: null,
    stderr: "",
    aborted: false,
    outputTruncated: false,
    ignoredJsonLines: 0,
    agentStarted: true,
    ...overrides,
  };
}

function makeSnapshot(overrides = {}) {
  return {
    messages: [],
    finalOutput: "",
    truncatedFinalOutput: "",
    usage: EMPTY_USAGE,
    trail: [],
    ...overrides,
  };
}

const DETAILS_CTX = {
  prompt: "do the thing",
  description: "a bounded task",
  cwd: "/repo",
  workerTools: ["read", "grep"],
};

describe("mmr-subagents task-result", () => {
  it("classifies Task outcomes with prefer-usable-output baked in", async () => {
    const { classifyTaskOutcome } = await importSource(RESULT_MODULE);
    const base = {
      aborted: false,
      signal: null,
      exitCode: 0,
      finalOutput: "",
      truncatedFinalOutput: "",
      agentStarted: true,
    };

    assert.equal(classifyTaskOutcome({ ...base, spawnError: "spawn ENOENT" }), "spawn-error");
    assert.equal(classifyTaskOutcome({ ...base, subagentActivationError: "unknown profile" }), "activation-error");
    assert.equal(classifyTaskOutcome({ ...base, aborted: true }), "aborted");
    assert.equal(classifyTaskOutcome({ ...base, signal: "SIGKILL" }), "worker-error");
    // Task policy: nonzero exit with usable final text still succeeds.
    assert.equal(classifyTaskOutcome({ ...base, exitCode: 1, finalOutput: "partial answer" }), "success");
    assert.equal(classifyTaskOutcome({ ...base, exitCode: 1 }), "worker-error");
    assert.equal(classifyTaskOutcome({ ...base, agentStarted: false }), "no-agent-start");
    assert.equal(classifyTaskOutcome(base), "empty-output");
  });

  it("mirrors the shared usable-final-text predicate", async () => {
    const { hasUsableTaskFinalText } = await importSource(RESULT_MODULE);

    assert.equal(hasUsableTaskFinalText({ finalOutput: "answer", truncatedFinalOutput: "" }), true);
    assert.equal(hasUsableTaskFinalText({ finalOutput: "", truncatedFinalOutput: "partial" }), true);
    assert.equal(hasUsableTaskFinalText({ finalOutput: "  \n", truncatedFinalOutput: "" }), false);
  });

  it("builds progress results with placeholder-or-stream content", async () => {
    const { buildTaskProgressResult, TASK_PROGRESS_PLACEHOLDER } = await importSource(RESULT_MODULE);

    const idle = buildTaskProgressResult(makeSnapshot(), DETAILS_CTX);
    assert.deepEqual(idle.content, [{ type: "text", text: TASK_PROGRESS_PLACEHOLDER }]);
    assert.equal(idle.details.worker, "mmr-subagents.Task");
    // Progress is always classified success; the final status needs the exit.
    assert.equal(idle.details.status, "success");
    assert.equal(idle.details.prompt, DETAILS_CTX.prompt);
    assert.equal(idle.details.description, DETAILS_CTX.description);

    const streaming = buildTaskProgressResult(makeSnapshot({ truncatedFinalOutput: "thinking…" }), DETAILS_CTX);
    assert.deepEqual(streaming.content, [{ type: "text", text: "thinking…" }]);
  });

  it("builds final results with status-aware content", async () => {
    const { buildTaskFinalResult } = await importSource(RESULT_MODULE);

    const ok = buildTaskFinalResult(makeWorkerResult(), DETAILS_CTX);
    assert.deepEqual(ok.content, [{ type: "text", text: "worker answer" }]);
    assert.equal(ok.details.status, "success");
    assert.equal(ok.details.workerTools, DETAILS_CTX.workerTools);

    const spawnFail = buildTaskFinalResult(
      makeWorkerResult({ finalOutput: "", truncatedFinalOutput: "", spawnError: "spawn E2BIG", exitCode: null }),
      DETAILS_CTX,
    );
    assert.equal(spawnFail.details.status, "spawn-error");
    assert.match(spawnFail.content[0].text, /^Task: worker failed to spawn: spawn E2BIG/);

    const cancelled = buildTaskFinalResult(
      makeWorkerResult({ finalOutput: "", truncatedFinalOutput: "", aborted: true }),
      DETAILS_CTX,
    );
    assert.equal(cancelled.details.status, "aborted");
    assert.match(cancelled.content[0].text, /cancelled before producing a result/);

    const crashed = buildTaskFinalResult(
      makeWorkerResult({ finalOutput: "", truncatedFinalOutput: "", exitCode: 3, stderr: "boom\nstack line\nlast line" }),
      DETAILS_CTX,
    );
    assert.equal(crashed.details.status, "worker-error");
    assert.match(crashed.content[0].text, /exited with code 3/);
    assert.match(crashed.content[0].text, /last line/, "stderr tail should be appended");

    const neverStarted = buildTaskFinalResult(
      makeWorkerResult({ finalOutput: "", truncatedFinalOutput: "", agentStarted: false }),
      DETAILS_CTX,
    );
    assert.equal(neverStarted.details.status, "no-agent-start");
    assert.match(neverStarted.content[0].text, /before the agent loop started/);
  });

  it("synthesizes a spawn-error worker result from a runner throw", async () => {
    const { buildSpawnErrorWorkerResult, classifyTaskOutcome } = await importSource(RESULT_MODULE);

    const result = buildSpawnErrorWorkerResult(new Error("spawn ENOENT"), { prompt: "p", cwd: "/repo" });
    assert.equal(result.spawnError, "spawn ENOENT");
    assert.equal(result.errorMessage, "spawn ENOENT");
    assert.equal(result.agentStarted, false);
    assert.equal(result.prompt, "p");
    assert.equal(classifyTaskOutcome(result), "spawn-error");

    assert.equal(buildSpawnErrorWorkerResult("string failure", { prompt: "p", cwd: "/repo" }).spawnError, "string failure");
  });

  it("maps a runner throw to a complete spawn-error tool result", async () => {
    const { buildTaskRunnerThrowResult } = await importSource(RESULT_MODULE);

    const prepared = {
      params: { prompt: "do the thing", description: "a bounded task" },
      cwd: "/repo",
      detailsContext: { ...DETAILS_CTX, resolvedModel: "provider/model-x" },
    };
    const result = buildTaskRunnerThrowResult(new Error("spawn EACCES"), prepared);
    assert.match(result.content[0].text, /^Task: worker failed to spawn: spawn EACCES$/);
    assert.equal(result.details.status, "spawn-error");
    assert.equal(result.details.errorMessage, "spawn EACCES");
    assert.equal(result.details.prompt, "do the thing");
    assert.equal(result.details.model, "provider/model-x");
  });

  it("keeps the moved surface resolving through the task entry file", async () => {
    const resultModule = await importSource(RESULT_MODULE);
    const task = await importSource(TASK_MODULE);

    // `importSource` cache-busts per call: compare values/behavior, not identity.
    assert.equal(task.TASK_PROGRESS_PLACEHOLDER, resultModule.TASK_PROGRESS_PLACEHOLDER);
    for (const name of [
      "buildSpawnErrorWorkerResult",
      "buildTaskFinalResult",
      "buildTaskProgressResult",
      "buildTaskRunnerThrowResult",
      "classifyTaskOutcome",
      "hasUsableTaskFinalText",
    ]) {
      assert.equal(typeof task[name], "function", `${name} must keep resolving from task.ts`);
    }
    const viaTask = task.buildTaskFinalResult(makeWorkerResult(), DETAILS_CTX);
    assert.equal(viaTask.details.status, "success");
  });
});
