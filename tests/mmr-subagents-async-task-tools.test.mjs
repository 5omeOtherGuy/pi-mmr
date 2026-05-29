import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

const TOOLS_MODULE = "extensions/mmr-subagents/async-task-tools.ts";
const REGISTRY_MODULE = "extensions/mmr-subagents/async-task-registry.ts";

after(cleanupLoadedSource);

const DEFAULT_TASK_WORKER_TOOLS = Object.freeze(["read", "bash", "edit", "write", "finder"]);

function stubTaskInvocation() {
  return () => ({
    ok: true,
    profile: { name: "task-subagent" },
    promptRoute: "mode-derived",
    parentMode: "smart",
    promptBaseMode: "smart",
    selected: {
      provider: "claude-subscription",
      model: "claude-opus-4-8",
      thinkingLevel: "high",
      registeredModel: { provider: "claude-subscription", id: "claude-opus-4-8" },
    },
    modelArg: "claude-subscription/claude-opus-4-8",
    workerTools: DEFAULT_TASK_WORKER_TOOLS,
    tools: DEFAULT_TASK_WORKER_TOOLS,
    toolResolution: { intendedTools: DEFAULT_TASK_WORKER_TOOLS, deniedTools: ["Task", "oracle"], omittedTools: [] },
    candidates: [],
    diagnostics: [],
  });
}

function makeWorkerResult(overrides = {}) {
  return {
    messages: [],
    finalOutput: "worker done",
    truncatedFinalOutput: "worker done",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 1, turns: 1 },
    prompt: "",
    cwd: "",
    command: "pi",
    args: [],
    exitCode: 0,
    signal: null,
    stderr: "",
    aborted: false,
    outputTruncated: false,
    ignoredJsonLines: 0,
    agentStarted: true,
    trail: [],
    ...overrides,
  };
}

function makeDeferredRunner() {
  const calls = [];
  let resolveFn;
  let rejectFn;
  const runner = {
    run(options) {
      calls.push(options);
      return new Promise((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      });
    },
  };
  return { runner, calls, resolve: (r) => resolveFn(r), reject: (e) => rejectFn(e) };
}

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

async function makeToolset(overrides = {}) {
  const tools = await importSource(TOOLS_MODULE);
  const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
  const registry = createMmrAsyncTaskRegistry({ idFactory: () => overrides.taskId ?? "t1", ...overrides.registryDeps });
  const def = makeDeferredRunner();
  const deps = {
    registry,
    sessionKey: "S",
    resolveInvocation: stubTaskInvocation(),
    runner: def.runner,
    // Bypass the real prompt assembler (which needs prompt builders
    // registered); routing/validation is still exercised end-to-end.
    buildSystemPrompt: () => "WORKER PROMPT",
  };
  return {
    registry,
    def,
    startTask: tools.createStartTaskTool(deps),
    poll: tools.createTaskPollTool(deps),
    wait: tools.createTaskWaitTool(deps),
    cancel: tools.createTaskCancelTool(deps),
  };
}

const CTX = { cwd: "/repo" };
const GOOD_PARAMS = { prompt: "do the thing", description: "thing" };

describe("start_task", () => {
  it("returns a task_id immediately without awaiting the worker", async () => {
    const { startTask, def } = await makeToolset();
    const result = await startTask.execute("call-1", GOOD_PARAMS, undefined, undefined, CTX);
    assert.equal(result.details.tool, "start_task");
    assert.equal(result.details.taskId, "t1");
    assert.equal(result.details.status, "running");
    assert.match(result.content[0].text, /started background worker t1/);
    assert.equal(def.calls.length, 1, "the worker run must have been invoked");
    def.resolve(makeWorkerResult());
    await flush();
  });

  it("does NOT bind the worker to the per-call tool signal", async () => {
    const { startTask, def } = await makeToolset();
    const aborted = AbortSignal.abort(); // already-aborted per-call signal
    await startTask.execute("call-1", GOOD_PARAMS, aborted, undefined, CTX);
    const workerSignal = def.calls[0].signal;
    assert.ok(workerSignal instanceof AbortSignal);
    assert.notEqual(workerSignal, aborted, "worker must use the registry's own signal");
    assert.equal(workerSignal.aborted, false, "an aborted start_task call must not abort the worker");
    def.resolve(makeWorkerResult());
    await flush();
  });

  it("returns a validation failure and creates no record on bad params", async () => {
    const { startTask, registry, def } = await makeToolset();
    const result = await startTask.execute("call-1", { prompt: "", description: "x" }, undefined, undefined, CTX);
    assert.equal(result.details.taskId, undefined);
    assert.match(result.content[0].text, /invalid parameters/i);
    assert.equal(registry.listTasks("S").counts.active, 0);
    assert.equal(def.calls.length, 0, "no worker should be spawned for invalid params");
  });

  it("rejects starts past the concurrency cap", async () => {
    const tools = await importSource(TOOLS_MODULE);
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    let n = 0;
    const registry = createMmrAsyncTaskRegistry({ maxRunningPerSession: 1, idFactory: () => `t${n++}` });
    const def = makeDeferredRunner();
    const deps = {
      registry,
      sessionKey: "S",
      resolveInvocation: stubTaskInvocation(),
      runner: def.runner,
      buildSystemPrompt: () => "WORKER PROMPT",
    };
    const startTask = tools.createStartTaskTool(deps);
    const first = await startTask.execute("c0", GOOD_PARAMS, undefined, undefined, CTX);
    assert.equal(first.details.taskId, "t0");
    const second = await startTask.execute("c1", GOOD_PARAMS, undefined, undefined, CTX);
    assert.match(second.content[0].text, /cannot start/i);
    assert.equal(second.details.taskId, undefined);
    def.resolve(makeWorkerResult());
    await flush();
  });
});

describe("task_poll", () => {
  it("lists background tasks when called with no task_id", async () => {
    const { startTask, poll, def } = await makeToolset();
    await startTask.execute("c0", GOOD_PARAMS, undefined, undefined, CTX);
    const result = await poll.execute("p0", {}, undefined, undefined, CTX);
    assert.ok(result.details.board, "board mode must return a board");
    assert.equal(result.details.board.counts.active, 1);
    assert.match(result.content[0].text, /1 active/);
    def.resolve(makeWorkerResult());
    await flush();
  });

  it("returns running progress, then the final result when terminal", async () => {
    const { startTask, poll, def } = await makeToolset();
    await startTask.execute("c0", GOOD_PARAMS, undefined, undefined, CTX);
    def.calls[0].onProgress(makeWorkerResult({ finalOutput: "halfway", truncatedFinalOutput: "halfway" }));
    let result = await poll.execute("p0", { task_id: "t1" }, undefined, undefined, CTX);
    assert.equal(result.details.status, "running");
    assert.match(result.content[0].text, /halfway/);

    def.resolve(makeWorkerResult({ finalOutput: "final answer", truncatedFinalOutput: "final answer" }));
    await flush();
    result = await poll.execute("p1", { task_id: "t1" }, undefined, undefined, CTX);
    assert.equal(result.details.status, "succeeded");
    assert.match(result.content[0].text, /final answer/);
    assert.equal(result.details.final.worker, "mmr-subagents.Task");
  });

  it("returns a deterministic not-found result for an unknown id", async () => {
    const { poll } = await makeToolset();
    const result = await poll.execute("p0", { task_id: "ghost" }, undefined, undefined, CTX);
    assert.match(result.content[0].text, /no background task with id "ghost"/);
    assert.equal(result.details.errorMessage.length > 0, true);
  });
});

describe("task_wait", () => {
  it("times out without cancelling the worker, then resolves on completion", async () => {
    const { startTask, wait, def } = await makeToolset();
    await startTask.execute("c0", GOOD_PARAMS, undefined, undefined, CTX);
    const timedOut = await wait.execute("w0", { task_id: "t1", timeout_ms: 5 }, undefined, undefined, CTX);
    assert.equal(timedOut.details.timedOut, true);
    assert.equal(timedOut.details.status, "running");
    assert.equal(def.calls[0].signal.aborted, false, "wait timeout must not abort the worker");

    const waitPromise = wait.execute("w1", { task_id: "t1", timeout_ms: 5000 }, undefined, undefined, CTX);
    def.resolve(makeWorkerResult({ finalOutput: "done now", truncatedFinalOutput: "done now" }));
    const settled = await waitPromise;
    assert.notEqual(settled.details.timedOut, true);
    assert.equal(settled.details.status, "succeeded");
  });
});

describe("task_cancel", () => {
  it("cancels a running task and reports the cancellation", async () => {
    const { startTask, cancel, def } = await makeToolset({ registryDeps: { cancelDeadAfterMs: 30 } });
    await startTask.execute("c0", GOOD_PARAMS, undefined, undefined, CTX);
    const cancelPromise = cancel.execute("x0", { task_id: "t1", reason: "obsolete" }, undefined, undefined, CTX);
    assert.equal(def.calls[0].signal.aborted, true, "cancel must abort the registry-owned signal");
    def.resolve(makeWorkerResult({ aborted: true, signal: "SIGTERM", exitCode: null, trail: [
      { type: "tool", toolCallId: "1", toolName: "read", status: "completed" },
    ] }));
    const result = await cancelPromise;
    await flush();
    assert.equal(result.details.status, "cancelled");
    assert.match(result.content[0].text, /task t1 cancelled/);
    assert.match(result.content[0].text, /completed/);
  });

  it("is a safe no-op for an unknown id", async () => {
    const { cancel } = await makeToolset();
    const result = await cancel.execute("x0", { task_id: "ghost" }, undefined, undefined, CTX);
    assert.match(result.content[0].text, /no background task with id "ghost"/);
  });
});

describe("worker failure surfaces through poll", () => {
  it("reports a failed terminal status when the worker rejects", async () => {
    const { startTask, poll, def } = await makeToolset();
    await startTask.execute("c0", GOOD_PARAMS, undefined, undefined, CTX);
    def.reject(new Error("kaboom"));
    await flush();
    const result = await poll.execute("p0", { task_id: "t1" }, undefined, undefined, CTX);
    assert.equal(result.details.status, "failed");
    assert.match(result.content[0].text, /kaboom/);
  });
});

describe("async task tools audit regressions", () => {
  it("isolates background tasks by the calling context's session id", async () => {
    const tools = await importSource(TOOLS_MODULE);
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    const registry = createMmrAsyncTaskRegistry({ idFactory: () => "t" });
    const def = makeDeferredRunner();
    const deps = {
      registry,
      resolveInvocation: stubTaskInvocation(),
      runner: def.runner,
      buildSystemPrompt: () => "WORKER PROMPT",
    };
    const startTask = tools.createStartTaskTool(deps);
    const poll = tools.createTaskPollTool(deps);
    const ctxA = { cwd: "/repo", sessionManager: { getSessionId: () => "A" } };
    const ctxB = { cwd: "/repo", sessionManager: { getSessionId: () => "B" } };
    await startTask.execute("c0", GOOD_PARAMS, undefined, undefined, ctxA);
    const boardB = await poll.execute("p0", {}, undefined, undefined, ctxB);
    assert.equal(boardB.details.board.counts.active, 0, "session B must not see session A's task");
    const boardA = await poll.execute("p1", {}, undefined, undefined, ctxA);
    assert.equal(boardA.details.board.counts.active, 1);
    def.resolve(makeWorkerResult());
    await flush();
  });

  it("projects a runner spawn failure as spawn-error through poll (parity with blocking Task)", async () => {
    const tools = await importSource(TOOLS_MODULE);
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    const registry = createMmrAsyncTaskRegistry({ idFactory: () => "t1" });
    const runner = {
      run() {
        throw new Error("spawn ENOENT");
      },
    };
    const deps = {
      registry,
      sessionKey: "S",
      resolveInvocation: stubTaskInvocation(),
      runner,
      buildSystemPrompt: () => "WORKER PROMPT",
    };
    const startTask = tools.createStartTaskTool(deps);
    const poll = tools.createTaskPollTool(deps);
    const started = await startTask.execute("c0", GOOD_PARAMS, undefined, undefined, CTX);
    assert.equal(started.details.taskId, "t1");
    await flush();
    const result = await poll.execute("p0", { task_id: "t1" }, undefined, undefined, CTX);
    assert.equal(result.details.status, "failed");
    assert.equal(result.details.final.status, "spawn-error");
    assert.match(result.content[0].text, /failed to spawn/);
  });
});

describe("async task tools model-visible surface", () => {
  it("exposes stable names, descriptions, snippets, guidelines, and locked schemas", async () => {
    const tools = await importSource(TOOLS_MODULE);
    const start = tools.createStartTaskTool();
    const poll = tools.createTaskPollTool();
    const wait = tools.createTaskWaitTool();
    const cancel = tools.createTaskCancelTool();
    assert.deepEqual(
      [start.name, poll.name, wait.name, cancel.name],
      ["start_task", "task_poll", "task_wait", "task_cancel"],
    );
    for (const t of [start, poll, wait, cancel]) {
      assert.equal(typeof t.description, "string");
      assert.ok(t.description.length > 0, `${t.name} needs a description`);
      assert.equal(typeof t.promptSnippet, "string");
      assert.ok(Array.isArray(t.promptGuidelines) && t.promptGuidelines.length > 0);
      assert.equal(t.parameters.type, "object");
      assert.equal(t.parameters.additionalProperties, false);
    }
    assert.deepEqual(Object.keys(start.parameters.properties).sort(), ["description", "notify", "prompt"]);
    assert.equal(start.parameters.properties.notify.type, "boolean");
    assert.deepEqual(start.parameters.required, ["prompt", "description"]);
    assert.deepEqual(Object.keys(poll.parameters.properties), ["task_id"]);
    assert.deepEqual(wait.parameters.required, ["task_id"]);
    assert.deepEqual(cancel.parameters.required, ["task_id"]);
    assert.match(start.description, /background/i);
    assert.ok(start.promptGuidelines.some((g) => /blocking Task/i.test(g)));
  });
});

describe("async task tools completion push", () => {
  async function pushHarness(overrides = {}) {
    const tools = await importSource(TOOLS_MODULE);
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    const registry = createMmrAsyncTaskRegistry({ idFactory: () => "t1" });
    const def = makeDeferredRunner();
    const sent = [];
    const deps = {
      registry,
      sessionKey: "S",
      resolveInvocation: stubTaskInvocation(),
      runner: def.runner,
      buildSystemPrompt: () => "WORKER PROMPT",
      pi: { sendMessage: (m, o) => sent.push({ m, o }) },
      ...overrides,
    };
    return { registry, def, sent, startTask: tools.createStartTaskTool(deps) };
  }

  it("pushes exactly once when the ceiling is on and the task opts in", async () => {
    const { registry, def, sent, startTask } = await pushHarness({ enableCompletionPush: true });
    await startTask.execute("c0", { ...GOOD_PARAMS, notify: true }, undefined, undefined, CTX);
    def.resolve(makeWorkerResult());
    await flush();
    assert.equal(sent.length, 1, "exactly one completion push");
    assert.deepEqual(sent[0].o, { deliverAs: "nextTurn", triggerTurn: true });
    assert.equal(sent[0].m.customType, "mmr-subagents.async-task-completion");
    assert.equal(registry.getTask("S", "t1").completionPush, "sent");
  });

  it("does not push when the ceiling is on but the task did not opt in", async () => {
    const { registry, def, sent, startTask } = await pushHarness({ enableCompletionPush: true });
    await startTask.execute("c0", GOOD_PARAMS, undefined, undefined, CTX);
    def.resolve(makeWorkerResult());
    await flush();
    assert.equal(sent.length, 0);
    assert.equal(registry.getTask("S", "t1").completionPush, "disabled");
  });

  it("does not push when the task opts in but the session ceiling is off", async () => {
    const { registry, def, sent, startTask } = await pushHarness();
    await startTask.execute("c0", { ...GOOD_PARAMS, notify: true }, undefined, undefined, CTX);
    def.resolve(makeWorkerResult());
    await flush();
    assert.equal(sent.length, 0);
    assert.equal(registry.getTask("S", "t1").completionPush, "disabled");
  });

  it("strips notify before the shared Task validator (the task still starts)", async () => {
    const { def, startTask } = await pushHarness({ enableCompletionPush: true });
    const result = await startTask.execute("c0", { ...GOOD_PARAMS, notify: true }, undefined, undefined, CTX);
    assert.equal(result.details.taskId, "t1", "notify must not trip the unknown-parameter validator");
    def.resolve(makeWorkerResult());
    await flush();
  });

  it("treats a non-boolean notify as opt-out", async () => {
    const { def, sent, startTask } = await pushHarness({ enableCompletionPush: true });
    await startTask.execute("c0", { ...GOOD_PARAMS, notify: "yes" }, undefined, undefined, CTX);
    def.resolve(makeWorkerResult());
    await flush();
    assert.equal(sent.length, 0);
  });
});
