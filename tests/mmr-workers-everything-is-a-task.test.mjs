import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

// Phase "everything is a task": every worker run registers in the async-task
// registry. Blocking calls register + await settle and return the projected
// result inline; the registry owns the worker AbortController with the
// tool-call signal adapted to task cancellation; blocking runs appear on the
// task board (cap-exempt, never deduplicated, no watchdog).

const FINDER_MODULE = "extensions/mmr-workers/finder.ts";
const ORACLE_MODULE = "extensions/mmr-workers/oracle.ts";
const REGISTRY_MODULE = "extensions/mmr-workers/async-task-registry.ts";
const TOOLS_MODULE = "extensions/mmr-workers/async-task-tools.ts";

after(cleanupLoadedSource);

const CTX = { cwd: "/repo" };

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

async function flush() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

/** Runner whose run() blocks until resolve()/abort; abort settles as an aborted worker result. */
function makeDeferredRunner() {
  const calls = [];
  let resolveRun;
  const runner = {
    run(options) {
      calls.push(options);
      return new Promise((resolve) => {
        resolveRun = resolve;
        options.signal?.addEventListener("abort", () => {
          resolve(makeWorkerResult({ aborted: true, exitCode: null, finalOutput: "", truncatedFinalOutput: "" }));
        }, { once: true });
      });
    },
  };
  return { runner, calls, resolve: (result) => resolveRun?.(result ?? makeWorkerResult()) };
}

async function makeBlockingFinder({ taskIds = ["b1", "b2", "b3"], registryDeps = {} } = {}) {
  const finderModule = await importSource(FINDER_MODULE);
  const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
  let next = 0;
  const registry = createMmrAsyncTaskRegistry({ idFactory: () => taskIds[next++] ?? `b${next}`, ...registryDeps });
  const def = makeDeferredRunner();
  const finder = finderModule.createFinderTool({
    registry,
    sessionKey: "S",
    runner: def.runner,
    buildSystemPrompt: () => "WORKER PROMPT",
  });
  return { finder, registry, def };
}

describe("blocking runs register in the async-task registry", () => {
  it("appears on the board while running (runMode blocking) and finishes observed", async () => {
    const { finder, registry, def } = await makeBlockingFinder();
    const controller = new AbortController();
    const pending = finder.execute("c1", { query: "find the auth path" }, controller.signal, undefined, CTX);
    const board = registry.listTasks("S");
    assert.equal(board.counts.active, 1, "a blocking run is a live board row");
    assert.equal(board.active[0].taskId, "b1");
    assert.equal(board.active[0].runMode, "blocking");
    assert.equal(board.active[0].agent, "finder");
    assert.equal(board.active[0].description, "finder: find the auth path");
    def.resolve();
    const result = await pending;
    assert.equal(result.content[0].text, "worker done");
    const finished = registry.listTasks("S").finished;
    assert.equal(finished.length, 1);
    assert.equal(finished[0].status, "succeeded");
    assert.equal(finished[0].runMode, "blocking");
  });

  it("returns the registry-materialized projection inline — one result path", async () => {
    const { finder, registry, def } = await makeBlockingFinder();
    const pending = finder.execute("c1", { query: "find X" }, new AbortController().signal, undefined, CTX);
    def.resolve();
    const result = await pending;
    const snapshot = registry.getTask("S", "b1");
    assert.equal(result, snapshot.finalToolResult, "blocking result IS the registry's materialized finalToolResult");
    assert.equal(result.details.worker, "mmr-subagents.finder");
    assert.equal(result.details.status, "success");
    // Renderer-only board reference (never in model content).
    assert.equal(result.details.sessionKey, "S");
    assert.equal(result.details.taskId, "b1");
    assert.doesNotMatch(result.content[0].text, /\bb1\b/);
  });

  it("adapts the tool-call signal to task cancellation (signal adapter)", async () => {
    const { finder, registry, def } = await makeBlockingFinder();
    void def;
    const controller = new AbortController();
    const pending = finder.execute("c1", { query: "slow search" }, controller.signal, undefined, CTX);
    controller.abort();
    const result = await pending;
    assert.match(result.content[0].text, /finder: search was cancelled before producing a result/);
    const snapshot = registry.getTask("S", "b1");
    assert.equal(snapshot.status, "cancelled");
    assert.equal(snapshot.cancelReason, "tool call aborted");
  });

  it("task_cancel stops a blocking run and the blocking call returns the cancelled shaping", async () => {
    const { finder, registry, def } = await makeBlockingFinder();
    void def;
    const tools = await importSource(TOOLS_MODULE);
    const cancel = tools.createTaskCancelTool({ registry, sessionKey: "S" });
    const pending = finder.execute("c1", { query: "slow search" }, new AbortController().signal, undefined, CTX);
    const cancelResult = await cancel.execute("c2", { task_id: "b1" }, new AbortController().signal, undefined, CTX);
    assert.match(cancelResult.content[0].text, /task b1 cancelled/);
    const result = await pending;
    assert.match(result.content[0].text, /finder: search was cancelled before producing a result/);
  });

  it("is cap-exempt in both directions and never deduplicated by tool-call id", async () => {
    const { finder, registry, def } = await makeBlockingFinder({ registryDeps: { maxRunningPerSession: 1 } });
    const pending = finder.execute("same-id", { query: "first" }, new AbortController().signal, undefined, CTX);
    // An in-flight blocking run does not shrink background capacity…
    assert.equal(registry.getRunningCapacity("S").runningCount, 0);
    def.resolve();
    const first = await pending;
    // …and a reused tool-call id never replays a finished blocking record.
    const secondPending = finder.execute("same-id", { query: "second" }, new AbortController().signal, undefined, CTX);
    await flush();
    def.resolve();
    const second = await secondPending;
    assert.equal(def.calls.length, 2, "both blocking executes must spawn");
    assert.notEqual(first.details.taskId, second.details.taskId);
  });

  it("registers oracle blocking runs too — every run is a task, oracle stays blocking-only", async () => {
    const oracleModule = await importSource(ORACLE_MODULE);
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    const registry = createMmrAsyncTaskRegistry({ idFactory: () => "o1" });
    const def = makeDeferredRunner();
    const oracle = oracleModule.createOracleTool({
      registry,
      sessionKey: "S",
      runner: def.runner,
      buildSystemPrompt: () => "ORACLE PROMPT",
    });
    const pending = oracle.execute("c1", { task: "review the design" }, new AbortController().signal, undefined, CTX);
    const active = registry.listTasks("S").active;
    assert.equal(active.length, 1);
    assert.equal(active[0].agent, "oracle");
    assert.equal(active[0].runMode, "blocking");
    def.resolve();
    await pending;
  });

  it("marks blocking rows in the task_poll board text", async () => {
    const { finder, registry, def } = await makeBlockingFinder();
    const tools = await importSource(TOOLS_MODULE);
    const poll = tools.createTaskPollTool({ registry, sessionKey: "S" });
    const pending = finder.execute("c1", { query: "find Y" }, new AbortController().signal, undefined, CTX);
    const list = await poll.execute("c2", {}, new AbortController().signal, undefined, CTX);
    assert.match(list.content[0].text, /b1 \(running, finder, blocking\)/);
    def.resolve();
    await pending;
  });

  it("stamps the board reference on streamed progress details", async () => {
    const { finder, def } = await makeBlockingFinder();
    const updates = [];
    const pending = finder.execute(
      "c1",
      { query: "find Z" },
      new AbortController().signal,
      (update) => updates.push(update),
      CTX,
    );
    def.calls[0].onProgress({ ...makeWorkerResult(), trail: [] });
    assert.ok(updates.length >= 1);
    assert.equal(updates[0].details.sessionKey, "S");
    assert.equal(updates[0].details.taskId, "b1");
    def.resolve();
    await pending;
  });
});

describe("registry: waitForSettle, external signal, raw-result projection", () => {
  function startArgs(overrides = {}) {
    return {
      sessionKey: "S",
      originToolCallId: "c0",
      agent: "Task",
      description: "d",
      prompt: "p",
      cwd: "/repo",
      workerTools: ["read"],
      deliveryOptIn: false,
      ...overrides,
    };
  }

  it("waitForSettle waits unbounded (past the task_wait cap) and marks the result observed", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    const registry = createMmrAsyncTaskRegistry({ idFactory: () => "t1" });
    let resolveRun;
    registry.startTask(startArgs({ run: () => new Promise((resolve) => { resolveRun = resolve; }) }));
    let settled = false;
    const pending = registry.waitForSettle("S", "t1").then((snapshot) => {
      settled = true;
      return snapshot;
    });
    await flush();
    assert.equal(settled, false);
    resolveRun(makeWorkerResult());
    const snapshot = await pending;
    assert.equal(snapshot.status, "succeeded");
    assert.equal(registry.getTask("S", "t1").completionPush, "disabled");
    assert.equal(await registry.waitForSettle("S", "missing"), undefined);
  });

  it("requests cancellation when the external signal aborts, without a live tool call", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    const registry = createMmrAsyncTaskRegistry({ idFactory: () => "t1" });
    const controller = new AbortController();
    registry.startTask(startArgs({
      externalSignal: controller.signal,
      run: ({ signal }) => new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          resolve(makeWorkerResult({ aborted: true, exitCode: null, finalOutput: "", truncatedFinalOutput: "" }));
        }, { once: true });
      }),
    }));
    controller.abort();
    const snapshot = await registry.waitForSettle("S", "t1");
    assert.equal(snapshot.status, "cancelled");
    assert.equal(snapshot.cancelReason, "tool call aborted");
  });

  it("materializes finalToolResult from a raw result through the per-run projector", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    const registry = createMmrAsyncTaskRegistry({ idFactory: () => "t1" });
    registry.startTask(startArgs({
      projectResult: (result) => ({
        content: [{ type: "text", text: `PROJECTED ${result.finalOutput}` }],
        details: { status: "success" },
      }),
      run: async () => makeWorkerResult(),
    }));
    const snapshot = await registry.waitForSettle("S", "t1");
    assert.equal(snapshot.finalToolResult.content[0].text, "PROJECTED worker done");
    // task_poll's terminal projection now reads the same materialized result.
    assert.equal(snapshot.status, "succeeded");
  });

  it("a projector throw never affects task state (best-effort materialization)", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    const registry = createMmrAsyncTaskRegistry({ idFactory: () => "t1" });
    registry.startTask(startArgs({
      projectResult: () => {
        throw new Error("projection boom");
      },
      run: async () => makeWorkerResult(),
    }));
    const snapshot = await registry.waitForSettle("S", "t1");
    assert.equal(snapshot.status, "succeeded");
    assert.equal(snapshot.finalToolResult, undefined);
    assert.deepEqual(snapshot.finalResult.finalOutput, "worker done");
  });
});
