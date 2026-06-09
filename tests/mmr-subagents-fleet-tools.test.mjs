import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

const TOOLS_MODULE = "extensions/mmr-async-tasks/async-task-tools.ts";
const REGISTRY_MODULE = "extensions/mmr-async-tasks/async-task-registry.ts";

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

/** A runner whose every run() resolves immediately with a succeeded result. */
function makeImmediateRunner() {
  const calls = [];
  return {
    runner: {
      run(options) {
        calls.push(options);
        return Promise.resolve(makeWorkerResult());
      },
    },
    calls,
  };
}

async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

function counter(prefix, hex = false) {
  let n = 0;
  return () => {
    n += 1;
    return hex ? `${prefix}${n.toString(16).padStart(6, "0")}` : `${prefix}_${n}`;
  };
}

async function makeFleetToolset(registryDeps = {}) {
  const tools = await importSource(TOOLS_MODULE);
  const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
  const registry = createMmrAsyncTaskRegistry({
    idFactory: counter("task"),
    groupIdFactory: counter("group_", true),
    ...registryDeps,
  });
  const runner = makeImmediateRunner();
  let scheduled;
  const deps = {
    registry,
    sessionKey: "S",
    resolveInvocation: stubTaskInvocation(),
    runner: runner.runner,
    buildSystemPrompt: () => "WORKER PROMPT",
    // Capture the deferred launch so the test controls when ready -> running.
    launchScheduler: (fn) => {
      scheduled = fn;
    },
  };
  return {
    registry,
    runner,
    startTask: tools.createStartTaskTool(deps),
    launch: () => scheduled?.(),
    hasScheduled: () => typeof scheduled === "function",
  };
}

const taskMember = (n) => ({ agent: "Task", params: { prompt: `prompt ${n}`, description: `task ${n}` } });

const FLEET = {
  fleet: {
    groups: [
      { group_label: "Group A", members: [taskMember(1), taskMember(2)] },
      { members: [taskMember(3)] },
    ],
  },
};

const CTX = { cwd: "/repo" };

describe("start_task fleet execution", () => {
  it("declares all members ready up front and returns fleet details without running", async () => {
    const { startTask, registry, runner, hasScheduled } = await makeFleetToolset();
    const result = await startTask.execute("call-1", FLEET, undefined, undefined, CTX);
    // Fleet details
    assert.ok(result.details.fleet, "result carries fleet details");
    assert.equal(result.details.fleet.totalTasks, 3);
    assert.equal(result.details.fleet.groups.length, 2);
    assert.equal(result.details.fleet.groups[0].rows.length, 2);
    assert.equal(result.details.fleet.groups[0].label, "Group A");
    assert.equal(result.details.sessionKey, "S");
    assert.ok(result.details.fleet.groups[0].taskIds.length === 2);
    // Nothing has run yet: all ready, launch deferred.
    assert.equal(runner.calls.length, 0, "no worker runs before the deferred launch");
    assert.ok(hasScheduled(), "a deferred launch was scheduled");
    const board = registry.listTasks("S");
    assert.equal(board.active.length, 3);
    assert.ok(board.active.every((e) => e.status === "ready"), "every declared member is ready");
    assert.ok(board.active.every((e) => e.deferredLaunch === true), "members are marked deferredLaunch");
  });

  it("launches all members together when the scheduled tick fires", async () => {
    const { startTask, registry, runner, launch } = await makeFleetToolset();
    await startTask.execute("call-1", FLEET, undefined, undefined, CTX);
    launch();
    await flush();
    assert.equal(runner.calls.length, 3, "all three members run on launch");
    // After running to completion, the groups settle.
    const groupA = registry.getGroup("S", registry.listTasks("S").finished[0]?.groupId
      ?? registry.listTasks("S").active[0]?.groupId);
    assert.ok(groupA);
  });

  it("rejects the whole fleet (no tasks, no groups) when it would exceed the cap", async () => {
    const { startTask, registry } = await makeFleetToolset({ maxRunningPerSession: 2 });
    const result = await startTask.execute("call-1", FLEET, undefined, undefined, CTX);
    assert.match(result.content[0].text, /cap/i);
    assert.equal(result.details.fleet, undefined, "no fleet card on rejection");
    const board = registry.listTasks("S");
    assert.equal(board.active.length + board.stalled.length + board.finished.length, 0, "no tasks created");
  });

  it("fails atomically when a member's payload is invalid (no partial fleet)", async () => {
    const { startTask, registry } = await makeFleetToolset();
    const bad = {
      fleet: {
        groups: [
          { members: [taskMember(1), { agent: "Task", params: { prompt: "", description: "empty" } }] },
        ],
      },
    };
    const result = await startTask.execute("call-1", bad, undefined, undefined, CTX);
    assert.equal(result.details.fleet, undefined);
    assert.match(result.content[0].text, /invalid|empty|prompt/i);
    const board = registry.listTasks("S");
    assert.equal(board.active.length + board.finished.length, 0, "an invalid member creates no records");
  });

  it("refreshes the widget at declaration and again at launch", async () => {
    const widgetCalls = [];
    const ctx = { ...CTX, mode: "tui", ui: { setWidget: (id, value) => widgetCalls.push(value) } };
    const { startTask, launch } = await makeFleetToolset();
    await startTask.execute("call-1", FLEET, undefined, undefined, ctx);
    const afterDeclare = widgetCalls.length;
    assert.ok(afterDeclare >= 1, "widget refreshed at declaration");
    launch();
    await flush();
    assert.ok(widgetCalls.length > afterDeclare, "widget refreshed again at launch");
  });
});
