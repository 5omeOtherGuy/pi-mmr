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

const LIBRARIAN_WORKER_TOOLS = Object.freeze([
  "read_github",
  "list_directory_github",
  "glob_github",
  "search_github",
  "commit_search",
  "diff_github",
  "list_repositories",
]);

function stubLibrarianInvocation() {
  return () => ({
    ok: true,
    profile: { name: "librarian" },
    promptRoute: "standalone",
    selected: {
      provider: "claude-subscription",
      model: "claude-opus-4-6",
      thinkingLevel: "medium",
      registeredModel: { provider: "claude-subscription", id: "claude-opus-4-6", contextWindow: 200000 },
    },
    modelArg: "claude-subscription/claude-opus-4-6",
    workerTools: LIBRARIAN_WORKER_TOOLS,
    tools: LIBRARIAN_WORKER_TOOLS,
    toolResolution: { intendedTools: LIBRARIAN_WORKER_TOOLS, deniedTools: [], omittedTools: [] },
    candidates: [],
    diagnostics: [],
  });
}

async function makeGithubOwnedPi() {
  const ownership = await importSource("extensions/mmr-github/tool-ownership.ts");
  ownership.__resetMmrGithubToolSourcePathsForTests();
  ownership.registerMmrGithubToolSourcePath("/mmr-github");
  return {
    getAllTools: () => ownership.MMR_GITHUB_TOOL_NAMES.map((name) => ({ name, sourceInfo: { path: "/mmr-github" } })),
  };
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
    assert.equal(result.details.description, "thing");
    assert.equal(result.details.prompt, "do the thing");
    assert.match(result.content[0].text, /started background worker t1/);
    assert.equal(def.calls.length, 1, "the worker run must have been invoked");
    def.resolve(makeWorkerResult());
    await flush();
  });

  it("does not promise automatic delivery when notify:false opts out", async () => {
    const { startTask, def } = await makeToolset();
    const result = await startTask.execute("call-1", { ...GOOD_PARAMS, notify: false }, undefined, undefined, CTX);
    assert.match(result.content[0].text, /Automatic delivery is disabled/);
    assert.doesNotMatch(result.content[0].text, /will notify this session/i);
    def.resolve(makeWorkerResult());
    await flush();
  });

  it("refreshes the bottom-of-window widget while running and retains the settled row briefly", async () => {
    const widgetCalls = [];
    const ctx = {
      ...CTX,
      mode: "tui",
      ui: { setWidget: (id, value) => widgetCalls.push({ id, value }) },
    };
    const { startTask, def } = await makeToolset();

    await startTask.execute("call-1", GOOD_PARAMS, undefined, undefined, ctx);
    assert.equal(
      typeof widgetCalls.at(-1)?.value,
      "function",
      "launching a background agent pins the widget factory",
    );

    // The registry settle hook (onSettle) still fires, but a freshly-settled
    // task now lingers in place for WIDGET_FINISHED_RETENTION_MS so the wave can
    // be seen flipping to ✓ before it drops — it does not clear immediately.
    def.resolve(makeWorkerResult());
    await flush();
    assert.equal(
      typeof widgetCalls.at(-1)?.value,
      "function",
      "a just-settled background agent is retained on the widget for the brief drop-off window",
    );
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

  it("accepts a Task capability profile shortcut and forwards it into Task params", async () => {
    const tools = await importSource(TOOLS_MODULE);
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    const registry = createMmrAsyncTaskRegistry({ idFactory: () => "cap-task" });
    const def = makeDeferredRunner();
    const inputs = [];
    const startTask = tools.createStartTaskTool({
      registry,
      sessionKey: "S",
      resolveInvocation(input) {
        inputs.push(input);
        return stubTaskInvocation()();
      },
      runner: def.runner,
      buildSystemPrompt: () => "WORKER PROMPT",
    });

    await startTask.execute(
      "cap0",
      { prompt: "Run it", description: "run", capabilityProfile: "read-write" },
      undefined,
      undefined,
      CTX,
    );

    assert.equal(inputs[0].capabilityProfile, "read-write");
    assert.ok(!("allowPrivilegedProfiles" in inputs[0]), "privileged-gate plumbing must not be threaded into the resolver input");
    def.resolve(makeWorkerResult());
    await flush();
  });

  it("accepts explicit Task agent params as a background Task worker", async () => {
    const { startTask, def } = await makeToolset();
    const result = await startTask.execute(
      "call-1",
      { agent: "Task", params: GOOD_PARAMS },
      undefined,
      undefined,
      CTX,
    );
    assert.equal(result.details.agent, "Task");
    assert.equal(result.details.taskId, "t1");
    assert.equal(result.details.description, "thing");
    assert.equal(result.details.prompt, "do the thing");
    assert.equal(def.calls[0].profileName, "task-subagent");
    def.resolve(makeWorkerResult());
    await flush();
  });

  it("runs finder as a selected background agent and polls its final result", async () => {
    const tools = await importSource(TOOLS_MODULE);
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    const registry = createMmrAsyncTaskRegistry({ idFactory: () => "finder-1" });
    const def = makeDeferredRunner();
    const startTask = tools.createStartTaskTool({
      registry,
      sessionKey: "S",
      finderDeps: { runner: def.runner, buildSystemPrompt: () => "FINDER PROMPT" },
    });
    const poll = tools.createTaskPollTool({ registry, sessionKey: "S" });

    const started = await startTask.execute(
      "f0",
      { agent: "finder", description: "find files", params: { query: "Find the async task tool" } },
      undefined,
      undefined,
      CTX,
    );
    assert.equal(started.details.agent, "finder");
    assert.equal(started.details.taskId, "finder-1");
    assert.equal(def.calls[0].profileName, "finder");
    assert.equal(def.calls[0].prompt, "Find the async task tool");

    def.resolve(makeWorkerResult({ finalOutput: "finder answer", truncatedFinalOutput: "finder answer" }));
    await flush();
    const result = await poll.execute("p0", { task_id: "finder-1" }, undefined, undefined, CTX);
    assert.equal(result.details.status, "succeeded");
    assert.equal(result.details.agent, "finder");
    assert.equal(result.details.final.worker, "mmr-subagents.finder");
    assert.match(result.content[0].text, /finder answer/);
  });

  it("maps a selected agent empty-output result to a failed outer async status", async () => {
    const tools = await importSource(TOOLS_MODULE);
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    const registry = createMmrAsyncTaskRegistry({ idFactory: () => "finder-empty" });
    const def = makeDeferredRunner();
    const startTask = tools.createStartTaskTool({
      registry,
      sessionKey: "S",
      finderDeps: { runner: def.runner, buildSystemPrompt: () => "FINDER PROMPT" },
    });
    const poll = tools.createTaskPollTool({ registry, sessionKey: "S" });

    await startTask.execute(
      "f-empty",
      { agent: "finder", description: "empty finder", params: { query: "Find nothing" } },
      undefined,
      undefined,
      CTX,
    );
    def.resolve(makeWorkerResult({ finalOutput: "", truncatedFinalOutput: "" }));
    await flush();
    const result = await poll.execute("p-empty", { task_id: "finder-empty" }, undefined, undefined, CTX);
    assert.equal(result.details.status, "failed");
    assert.equal(result.details.final.status, "empty-output");
  });

  it("rejects oracle as a selected background agent", async () => {
    const tools = await importSource(TOOLS_MODULE);
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    const registry = createMmrAsyncTaskRegistry({ idFactory: () => "oracle-1" });
    const def = makeDeferredRunner();
    const startTask = tools.createStartTaskTool({
      registry,
      sessionKey: "S",
      runner: def.runner,
      buildSystemPrompt: () => "WORKER PROMPT",
    });

    const result = await startTask.execute(
      "o0",
      { agent: "oracle", description: "review design", params: { task: "Review the design" } },
      undefined,
      undefined,
      CTX,
    );

    assert.equal(result.details.taskId, undefined);
    assert.match(result.content[0].text, /Oracle is always blocking/i);
    assert.equal(registry.listTasks("S").counts.active, 0);
    assert.equal(def.calls.length, 0);
  });

  it("runs librarian as a selected background agent and uses librarian-specific deps", async () => {
    const tools = await importSource(TOOLS_MODULE);
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    const registry = createMmrAsyncTaskRegistry({ idFactory: () => "librarian-1" });
    const def = makeDeferredRunner();
    const pi = await makeGithubOwnedPi();
    const startTask = tools.createStartTaskTool({
      registry,
      sessionKey: "S",
      librarianDeps: {
        runner: def.runner,
        resolveInvocation: stubLibrarianInvocation(),
        buildSystemPrompt: () => "LIBRARIAN PROMPT",
        pi,
      },
    });
    const poll = tools.createTaskPollTool({ registry, sessionKey: "S" });

    await startTask.execute(
      "l0",
      { agent: "librarian", description: "research repo", params: { query: "Explain owner/repo auth" } },
      undefined,
      undefined,
      CTX,
    );
    assert.equal(def.calls[0].profileName, "librarian");
    assert.match(def.calls[0].prompt, /Query: Explain owner\/repo auth/);

    def.resolve(makeWorkerResult({ finalOutput: "librarian answer", truncatedFinalOutput: "librarian answer" }));
    await flush();
    const result = await poll.execute("p0", { task_id: "librarian-1" }, undefined, undefined, CTX);
    assert.equal(result.details.agent, "librarian");
    assert.equal(result.details.final.worker, "mmr-subagents.librarian");
    assert.equal(result.details.final.query, "Explain owner/repo auth");
    assert.match(result.content[0].text, /librarian answer/);
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

  it("renders partial terminal outcomes distinctly from clean success", async () => {
    const { startTask, poll, def } = await makeToolset();
    await startTask.execute("c0", GOOD_PARAMS, undefined, undefined, CTX);
    def.resolve(makeWorkerResult({
      outputTruncated: true,
      finalOutput: "full answer beyond the limit",
      truncatedFinalOutput: "clipped answer",
    }));
    await flush();

    const result = await poll.execute("p0", { task_id: "t1" }, undefined, undefined, CTX);
    assert.equal(result.details.status, "succeeded");
    assert.equal(result.details.terminalOutcome, "partial");
    assert.match(result.content[0].text, /partial/i);
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

describe("async task worker groups", () => {
  it("opens a group with start_task group_id=new and polls/waits/cancels by group_id", async () => {
    const tools = await importSource(TOOLS_MODULE);
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    let n = 0;
    const registry = createMmrAsyncTaskRegistry({ idFactory: () => `gt${n++}`, groupIdFactory: () => "group_abc999", cancelDeadAfterMs: 30 });
    const calls = [];
    const runner = {
      run(options) {
        const call = { options };
        calls.push(call);
        return new Promise((resolve) => {
          call.resolve = resolve;
        });
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
    const wait = tools.createTaskWaitTool(deps);
    const cancel = tools.createTaskCancelTool(deps);

    const first = await startTask.execute("g0", { ...GOOD_PARAMS, group_id: "new" }, undefined, undefined, CTX);
    assert.equal(first.details.groupId, "group_abc999");
    assert.equal(first.details.taskId, "gt0");
    const groupId = first.details.groupId;
    const second = await startTask.execute("g1", { ...GOOD_PARAMS, description: "thing 2", group_id: groupId }, undefined, undefined, CTX);
    assert.equal(second.details.groupId, groupId);
    assert.equal(second.details.taskId, "gt1");

    let group = await poll.execute("pg", { group_id: groupId }, undefined, undefined, CTX);
    assert.equal(group.details.group.status, "running");
    assert.deepEqual(group.details.group.taskIds, ["gt0", "gt1"]);
    assert.match(group.content[0].text, /Child task_ids: gt0, gt1/, "running group result lists child task_ids");

    calls[0].resolve(makeWorkerResult({ outputTruncated: true }));
    await flush();
    const timedOut = await wait.execute("wg0", { group_id: groupId, timeout_ms: 5 }, undefined, undefined, CTX);
    assert.equal(timedOut.details.timedOut, true);
    assert.equal(timedOut.details.group.status, "running");

    const cancelPromise = cancel.execute("cg", { group_id: groupId, reason: "stop group" }, undefined, undefined, CTX);
    assert.equal(calls[1].options.signal.aborted, true);
    calls[1].resolve(makeWorkerResult({ aborted: true, signal: "SIGTERM", exitCode: null }));
    const cancelResult = await cancelPromise;
    assert.equal(cancelResult.details.group.status, "cancelled");
    group = await poll.execute("pg2", { group_id: groupId }, undefined, undefined, CTX);
    assert.equal(group.details.group.status, "cancelled");
    assert.match(group.content[0].text, /group_abc999/);
    assert.match(
      group.content[0].text,
      /Retrieve each needed child once with task_poll\(\{task_id\}\): gt0, gt1/,
      "terminal group result names the per-child retrieval step",
    );
  });

  it("rejects unsafe group ids and mutually-exclusive task_id/group_id controls", async () => {
    const { startTask, poll, wait, cancel } = await makeToolset();
    assert.match((await startTask.execute("bad", { ...GOOD_PARAMS, group_id: "../nope" }, undefined, undefined, CTX)).content[0].text, /invalid parameters/i);
    assert.match((await poll.execute("p", { task_id: "t1", group_id: "group_abcdef" }, undefined, undefined, CTX)).content[0].text, /mutually exclusive/i);
    assert.match((await wait.execute("w", {}, undefined, undefined, CTX)).content[0].text, /requires task_id or group_id/i);
    assert.match((await cancel.execute("c", {}, undefined, undefined, CTX)).content[0].text, /requires task_id or group_id/i);
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
      assert.equal(t.renderShell, "self");
      assert.equal(typeof t.renderCall, "function");
      assert.equal(typeof t.renderResult, "function");
    }
    assert.deepEqual(Object.keys(start.parameters.properties).sort(), ["agent", "capabilityProfile", "description", "group_id", "group_label", "notify", "params", "prompt"]);
    assert.equal(start.parameters.properties.notify.type, "boolean");
    assert.equal(start.parameters.properties.group_label.type, "string");
    assert.deepEqual(start.parameters.properties.capabilityProfile.anyOf.map((entry) => entry.const), ["read-only", "read-write"]);
    assert.deepEqual(start.parameters.properties.agent.anyOf.map((entry) => entry.const), ["Task", "finder", "librarian"]);
    assert.equal(start.parameters.required, undefined);
    assert.deepEqual(Object.keys(poll.parameters.properties).sort(), ["group_id", "task_id"]);
    assert.deepEqual(Object.keys(wait.parameters.properties).sort(), ["group_id", "task_id", "timeout_ms"]);
    assert.equal(wait.parameters.required, undefined);
    assert.deepEqual(Object.keys(cancel.parameters.properties).sort(), ["group_id", "reason", "task_id"]);
    assert.equal(cancel.parameters.required, undefined);
    assert.match(start.description, /background/i);
    assert.match(
      start.description,
      /With notify enabled, completed background work is surfaced automatically/i,
      "start_task should teach automatic delivery handling",
    );
    assert.doesNotMatch(
      start.description,
      /Always follow start_task with task_poll or task_wait/i,
      "start_task must not make polling the default completion path",
    );
    assert.ok(
      start.promptGuidelines.some((g) => /automatic/i.test(g) && /active agent loop/i.test(g) && /idle/i.test(g)),
      "guidelines should describe active-loop and idle automatic delivery",
    );
    assert.ok(start.promptGuidelines.some((g) => /blocking Task/i.test(g)));
    assert.match(
      start.description,
      /single grouped notification/i,
      "start_task should document the single grouped-notification policy",
    );
    assert.ok(
      start.promptGuidelines.some((g) => /open the group with start_task\(\{ group_id: 'new'/.test(g) && /task_poll\(\{ task_id \}\)/.test(g)),
      "guidelines should give a concrete open-group-then-reuse example with the per-child retrieval call",
    );
  });
});

describe("async task tool lifecycle wiring", () => {
  it("registers lifecycle/context handlers against the injected registry and appends context notices", async () => {
    const tools = await importSource(TOOLS_MODULE);
    const events = {};
    const calls = [];
    const registry = {
      startTask() { throw new Error("not used"); },
      openGroup() { throw new Error("not used"); },
      getTask() { return undefined; },
      getGroup() { return undefined; },
      dropEmptyGroup() { return false; },
      listTasks() {
        return { version: 1, generatedAtMs: 0, counts: { active: 0, stalled: 0, finished: 0 }, active: [], stalled: [], finished: [] };
      },
      waitForTask() { throw new Error("not used"); },
      waitForGroup() { throw new Error("not used"); },
      cancelTask() { throw new Error("not used"); },
      cancelGroup() { throw new Error("not used"); },
      prune() {},
      shutdownSession(sessionKey, reason) { calls.push(["shutdown", sessionKey, reason]); },
      setSessionAgentActive(sessionKey, active) { calls.push(["active", sessionKey, active]); },
      flushIdleDeliveries(sessionKey) { calls.push(["flush", sessionKey]); },
      claimPendingForContext(sessionKey, max) {
        calls.push(["claim", sessionKey, max]);
        return {
          items: [{
            kind: "task",
            id: "task_x",
            status: "failed",
            description: "done",
            errorMessage: "</background-tasks-finished><bad>",
          }],
          hasMore: false,
          claimedAtMs: 1,
        };
      },
    };
    const pi = {
      registerTool() {},
      registerMessageRenderer() {},
      on(name, handler) { events[name] = handler; },
    };

    tools.registerAsyncTaskTools(pi, { registry, sessionKey: "S" });
    events.agent_start?.({ type: "agent_start" }, CTX);
    const prior = { role: "user", content: [{ type: "text", text: "prior" }], timestamp: 0 };
    const contextResult = await events.context?.({ type: "context", messages: [prior] }, CTX);
    events.agent_end?.({ type: "agent_end", messages: [] }, CTX);
    events.session_shutdown?.({ type: "session_shutdown", reason: "shutdown" }, CTX);

    assert.deepEqual(calls, [
      ["active", "S", true],
      ["claim", "S", 12],
      ["active", "S", false],
      ["flush", "S"],
      ["shutdown", "S", "session_shutdown"],
    ]);
    assert.equal(contextResult.messages[0], prior, "context handler must append, not replace");
    assert.match(contextResult.messages[1].content[0].text, /background-tasks-finished/);
    assert.match(contextResult.messages[1].content[0].text, /task task_x/);
    assert.match(contextResult.messages[1].content[0].text, /&lt;\/background-tasks-finished&gt;&lt;bad&gt;/);
    assert.doesNotMatch(contextResult.messages[1].content[0].text, /<bad>/);
  });
});

describe("async task tools completion push", () => {
  async function pushHarness(overrides = {}) {
    const tools = await importSource(TOOLS_MODULE);
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    const { registryDeps, ...toolOverrides } = overrides;
    const registry = createMmrAsyncTaskRegistry({ idFactory: () => "t1", ...registryDeps });
    const def = makeDeferredRunner();
    const sent = [];
    const deps = {
      registry,
      sessionKey: "S",
      resolveInvocation: stubTaskInvocation(),
      runner: def.runner,
      buildSystemPrompt: () => "WORKER PROMPT",
      pi: { sendMessage: (m, o) => sent.push({ m, o }) },
      ...toolOverrides,
    };
    return {
      registry,
      def,
      sent,
      startTask: tools.createStartTaskTool(deps),
      cancel: tools.createTaskCancelTool(deps),
    };
  }

  it("pushes exactly once by default", async () => {
    const { registry, def, sent, startTask } = await pushHarness();
    await startTask.execute("c0", GOOD_PARAMS, undefined, undefined, CTX);
    def.resolve(makeWorkerResult());
    await flush();
    assert.equal(sent.length, 1, "exactly one completion push");
    assert.deepEqual(sent[0].o, { deliverAs: "followUp", triggerTurn: true });
    assert.equal(sent[0].m.customType, "mmr-subagents.async-task-completion");
    assert.match(sent[0].m.content, /call task_poll\(\{task_id:"t1"\}\) once to retrieve it\./);
    assert.doesNotMatch(sent[0].m.content, /Non-normal outcome:/);
    assert.equal(sent[0].m.details.outcomeText, undefined);
    assert.doesNotMatch(sent[0].m.content, /Poll only later/);
    assert.equal(sent[0].m.display, false, "completion push is model-facing only; inline lifecycle cards own human rendering");
    assert.equal(registry.listTasks("S").finished.find((e) => e.taskId === "t1")?.completionPush, "announced");
  });

  it("sends one group completion push naming the group and per-child polling, with no individual child pushes", async () => {
    const tools = await importSource(TOOLS_MODULE);
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    let n = 0;
    const registry = createMmrAsyncTaskRegistry({ idFactory: () => `gt${n++}`, groupIdFactory: () => "group_def111" });
    const sent = [];
    const calls = [];
    const runner = {
      run(options) {
        const call = { options };
        calls.push(call);
        return new Promise((resolve) => { call.resolve = resolve; });
      },
    };
    const deps = {
      registry,
      sessionKey: "S",
      resolveInvocation: stubTaskInvocation(),
      runner,
      buildSystemPrompt: () => "WORKER PROMPT",
      pi: { sendMessage: (m, o) => sent.push({ m, o }) },
    };
    const startTask = tools.createStartTaskTool(deps);
    await startTask.execute("g0", { ...GOOD_PARAMS, group_id: "new" }, undefined, undefined, CTX);
    await startTask.execute("g1", { ...GOOD_PARAMS, description: "t2", group_id: "group_def111" }, undefined, undefined, CTX);
    calls[0].resolve(makeWorkerResult());
    calls[1].resolve(makeWorkerResult());
    await flush();

    const groupPushes = sent.filter((s) => /task-group-notification/.test(s.m.content));
    assert.equal(groupPushes.length, 1, "exactly one group-level completion push");
    assert.match(groupPushes[0].m.content, /call task_poll\(\{group_id:"group_def111"\}\) once/);
    assert.match(groupPushes[0].m.content, /retrieve only child outputs you still need with task_poll\(\{task_id\}\)/);
    const childPushes = sent.filter((s) => /<task-notification/.test(s.m.content));
    assert.equal(childPushes.length, 0, "grouped children must not send individual completion pushes");
  });

  it("includes explicit non-normal outcome text in the model-facing completion push", async () => {
    const { def, sent, startTask } = await pushHarness();
    await startTask.execute("c0", GOOD_PARAMS, undefined, undefined, CTX);
    def.reject(new Error("kaboom"));
    await flush();

    assert.equal(sent.length, 1, "failed tasks still send one completion push");
    assert.match(sent[0].m.content, /Non-normal outcome: failed — kaboom\./);
    assert.equal(sent[0].m.details.outcomeText, "failed — kaboom.");
  });

  it("does not push when task_cancel returns the terminal cancellation snapshot", async () => {
    const { def, sent, startTask, cancel } = await pushHarness({ registryDeps: { cancelDeadAfterMs: 30 } });
    await startTask.execute("c0", GOOD_PARAMS, undefined, undefined, CTX);
    const cancelPromise = cancel.execute("x0", { task_id: "t1", reason: "duplicate work" }, undefined, undefined, CTX);
    def.resolve(makeWorkerResult({ aborted: true, signal: "SIGTERM", exitCode: null }));
    const cancelled = await cancelPromise;
    await flush();

    assert.equal(cancelled.details.status, "cancelled");
    assert.equal(sent.length, 0, "task_cancel consumed the terminal result, so no stale push should be sent");
  });

  it("does not push when the task opts out", async () => {
    const { registry, def, sent, startTask } = await pushHarness({ enableCompletionPush: true });
    await startTask.execute("c0", { ...GOOD_PARAMS, notify: false }, undefined, undefined, CTX);
    def.resolve(makeWorkerResult());
    await flush();
    assert.equal(sent.length, 0);
    assert.equal(registry.getTask("S", "t1").completionPush, "disabled");
  });

  it("does not push when the session ceiling is off", async () => {
    const { registry, def, sent, startTask } = await pushHarness({ enableCompletionPush: false });
    await startTask.execute("c0", GOOD_PARAMS, undefined, undefined, CTX);
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

  it("rejects a non-boolean notify before spawn (schema is authoritative)", async () => {
    const { startTask, registry, def } = await makeToolset();
    const result = await startTask.execute("c0", { ...GOOD_PARAMS, notify: "yes" }, undefined, undefined, CTX);
    assert.match(result.content[0].text, /invalid parameters/i);
    assert.equal(result.details.taskId, undefined);
    assert.equal(registry.listTasks("S").counts.active, 0);
    assert.equal(def.calls.length, 0, "no worker should be spawned for a non-boolean notify");
  });
});

describe("async control validation (shared checkMmrToolParams)", () => {
  it("start_task rejects unknown top-level parameters", async () => {
    const { startTask, registry, def } = await makeToolset();
    const result = await startTask.execute("c0", { ...GOOD_PARAMS, bogus: 1 }, undefined, undefined, CTX);
    assert.match(result.content[0].text, /invalid parameters/i);
    assert.equal(result.details.taskId, undefined);
    assert.equal(registry.listTasks("S").counts.active, 0);
    assert.equal(def.calls.length, 0);
  });

  it("task_poll rejects unknown parameters", async () => {
    const { poll } = await makeToolset();
    const result = await poll.execute("p0", { bogus: true }, undefined, undefined, CTX);
    assert.match(result.content[0].text, /invalid parameters/i);
  });

  it("task_wait rejects a non-integer timeout_ms", async () => {
    const { wait } = await makeToolset();
    const result = await wait.execute("w0", { task_id: "t1", timeout_ms: 5.5 }, undefined, undefined, CTX);
    assert.match(result.content[0].text, /invalid parameters/i);
  });

  it("task_wait rejects an out-of-range timeout_ms", async () => {
    const { MAX_TASK_WAIT_TIMEOUT_MS } = await importSource(REGISTRY_MODULE);
    const { wait } = await makeToolset();
    const negative = await wait.execute("w1", { task_id: "t1", timeout_ms: -1 }, undefined, undefined, CTX);
    assert.match(negative.content[0].text, /invalid parameters/i);
    const tooBig = await wait.execute("w2", { task_id: "t1", timeout_ms: MAX_TASK_WAIT_TIMEOUT_MS + 1 }, undefined, undefined, CTX);
    assert.match(tooBig.content[0].text, /invalid parameters/i);
  });

  it("task_cancel rejects unknown parameters", async () => {
    const { cancel } = await makeToolset();
    const result = await cancel.execute("x0", { task_id: "t1", bogus: "y" }, undefined, undefined, CTX);
    assert.match(result.content[0].text, /invalid parameters/i);
  });
});

describe("start_task capability profile and group side effects", () => {
  for (const profile of ["execute", "all"]) {
    it(`rejects the removed ${profile} capability profile before spawn with no record or group`, async () => {
      const { startTask, registry, def } = await makeToolset();
      const result = await startTask.execute(
        "c0",
        { ...GOOD_PARAMS, capabilityProfile: profile, group_id: "group_abcdef" },
        undefined,
        undefined,
        CTX,
      );
      assert.match(result.content[0].text, /invalid parameters/i);
      assert.equal(result.details.taskId, undefined);
      assert.equal(registry.getGroup("S", "group_abcdef"), undefined, "must not open a group for a rejected profile");
      assert.equal(registry.listTasks("S").counts.active, 0);
      assert.equal(def.calls.length, 0);
    });
  }

  it("does not open a group when Task validation fails (no orphan group)", async () => {
    const { startTask, registry, def } = await makeToolset();
    const result = await startTask.execute(
      "c0",
      { prompt: "", description: "x", group_id: "group_abcdef" },
      undefined,
      undefined,
      CTX,
    );
    assert.match(result.content[0].text, /invalid parameters/i);
    assert.equal(result.details.taskId, undefined);
    assert.equal(registry.getGroup("S", "group_abcdef"), undefined, "invalid Task params must not mint an orphan group");
    assert.equal(registry.listTasks("S").counts.active, 0);
    assert.equal(def.calls.length, 0, "no worker should be spawned");
  });

  it("rejects capabilityProfile for non-Task agents before spawn", async () => {
    const { startTask, def } = await makeToolset();
    const result = await startTask.execute(
      "c0",
      { agent: "finder", params: { query: "x" }, capabilityProfile: "read-only" },
      undefined,
      undefined,
      CTX,
    );
    assert.match(result.content[0].text, /only supported for the Task agent/i);
    assert.equal(def.calls.length, 0);
  });

  it("rolls back a freshly minted group when the concurrency cap rejects the start", async () => {
    const tools = await importSource(TOOLS_MODULE);
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    let n = 0;
    const registry = createMmrAsyncTaskRegistry({
      maxRunningPerSession: 1,
      idFactory: () => `t${n++}`,
      groupIdFactory: () => "group_cab123",
    });
    const def = makeDeferredRunner();
    const deps = {
      registry,
      sessionKey: "S",
      resolveInvocation: stubTaskInvocation(),
      runner: def.runner,
      buildSystemPrompt: () => "WORKER PROMPT",
    };
    const startTask = tools.createStartTaskTool(deps);
    // First start (no group) consumes the single running slot.
    await startTask.execute("c0", GOOD_PARAMS, undefined, undefined, CTX);
    // Second start opens a NEW group but is rejected by the cap.
    const rejected = await startTask.execute("c1", { ...GOOD_PARAMS, group_id: "new" }, undefined, undefined, CTX);
    assert.match(rejected.content[0].text, /cannot start/i);
    assert.equal(rejected.details.taskId, undefined);
    assert.equal(registry.getGroup("S", "group_cab123"), undefined, "cap rejection must not leave an empty orphan group");
    def.resolve(makeWorkerResult());
    await flush();
  });

  it("forwards group_label into the group it opens", async () => {
    const { startTask, registry, def } = await makeToolset();
    const result = await startTask.execute(
      "g0",
      { ...GOOD_PARAMS, group_id: "new", group_label: "Explore order services" },
      undefined,
      undefined,
      CTX,
    );
    const groupId = result.details.groupId;
    assert.ok(typeof groupId === "string" && groupId.length > 0, "opening call must mint a group id");
    assert.equal(registry.getGroup("S", groupId).label, "Explore order services");
    def.resolve(makeWorkerResult());
    await flush();
  });

  it("length-caps the forwarded group_label via the registry", async () => {
    const { startTask, registry, def } = await makeToolset();
    const result = await startTask.execute(
      "g0",
      { ...GOOD_PARAMS, group_id: "new", group_label: "x".repeat(130) },
      undefined,
      undefined,
      CTX,
    );
    const groupId = result.details.groupId;
    assert.equal(registry.getGroup("S", groupId).label.length, 120);
    def.resolve(makeWorkerResult());
    await flush();
  });

  it("ignores group_label when joining an existing group (set-once on open)", async () => {
    const tools = await importSource(TOOLS_MODULE);
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    let n = 0;
    const registry = createMmrAsyncTaskRegistry({ idFactory: () => `gt${n++}`, groupIdFactory: () => "group_abc999" });
    const calls = [];
    const runner = {
      run(options) {
        const call = { options };
        calls.push(call);
        return new Promise((resolve) => { call.resolve = resolve; });
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

    const first = await startTask.execute("g0", { ...GOOD_PARAMS, group_id: "new", group_label: "First" }, undefined, undefined, CTX);
    const groupId = first.details.groupId;
    assert.equal(registry.getGroup("S", groupId).label, "First");
    await startTask.execute("g1", { ...GOOD_PARAMS, description: "second", group_id: groupId, group_label: "Second" }, undefined, undefined, CTX);
    assert.equal(registry.getGroup("S", groupId).label, "First", "label is set-once on open; joining must not clobber it");
    calls[0].resolve(makeWorkerResult());
    calls[1].resolve(makeWorkerResult());
    await flush();
  });

  it("does not leave an empty labeled orphan group when an opener retries (idempotent dedup)", async () => {
    const tools = await importSource(TOOLS_MODULE);
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    let g = 0;
    const groupIds = ["group_aaa001", "group_bbb002"];
    const registry = createMmrAsyncTaskRegistry({ idFactory: () => "t1", groupIdFactory: () => groupIds[g++] });
    const def = makeDeferredRunner();
    const deps = {
      registry,
      sessionKey: "S",
      resolveInvocation: stubTaskInvocation(),
      runner: def.runner,
      buildSystemPrompt: () => "WORKER PROMPT",
    };
    const startTask = tools.createStartTaskTool(deps);
    // First opener mints group_aaa001 and attaches the task.
    const first = await startTask.execute("same-call", { ...GOOD_PARAMS, group_id: "new", group_label: "Wave" }, undefined, undefined, CTX);
    assert.equal(first.details.groupId, "group_aaa001");
    // Retry with the SAME tool-call id mints group_bbb002 but dedups to the existing task.
    const retry = await startTask.execute("same-call", { ...GOOD_PARAMS, group_id: "new", group_label: "Wave" }, undefined, undefined, CTX);
    assert.equal(retry.details.groupId, "group_aaa001", "dedup returns the original task's group");
    assert.equal(registry.getGroup("S", "group_bbb002"), undefined, "the retry's freshly minted group must not linger as an orphan");
    assert.equal(registry.getGroup("S", "group_aaa001").label, "Wave");
    def.resolve(makeWorkerResult());
    await flush();
  });

  it("rejects an invalid finder background start before spawn with no task or group", async () => {
    const { startTask, registry, def } = await makeToolset();
    const result = await startTask.execute(
      "c0",
      { agent: "finder", params: {}, group_id: "group_abcdef" },
      undefined,
      undefined,
      CTX,
    );
    assert.match(result.content[0].text, /invalid parameters/i);
    assert.equal(result.details.taskId, undefined);
    assert.equal(registry.getGroup("S", "group_abcdef"), undefined, "invalid finder params must not mint a group");
    assert.equal(registry.listTasks("S").counts.active, 0);
    assert.equal(def.calls.length, 0);
  });
});
