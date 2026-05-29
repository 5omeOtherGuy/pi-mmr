import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const FINDER_MODULE = "extensions/mmr-subagents/finder.ts";
const ORACLE_MODULE = "extensions/mmr-subagents/oracle.ts";
const RUNNER_MODULE = "extensions/mmr-subagents/runner.ts";
const ROOT_MODULE = "index.ts";
const PROMPTS_MODULE = "extensions/mmr-subagents/prompts.ts";
const PROMPT_ASSEMBLY_MODULE = "extensions/mmr-core/subagent-prompt-assembly.ts";

beforeEach(async () => {
  const { clearMmrSubagentPromptBuilders } = await importSource(PROMPT_ASSEMBLY_MODULE);
  const { registerMmrSubagentsPromptBuilders } = await importSource(PROMPTS_MODULE);
  clearMmrSubagentPromptBuilders();
  registerMmrSubagentsPromptBuilders();
});

function makeWorkerResult(overrides = {}) {
  return {
    messages: [{ role: "assistant", content: [{ type: "text", text: "hi" }] }],
    finalOutput: "hi",
    truncatedFinalOutput: "hi",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
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
    ...overrides,
  };
}

describe("MmrSubagentRunner — public surface", () => {
  it("exports the runner interface and child-CLI adapter factory", async () => {
    const mod = await importSource(RUNNER_MODULE);
    assert.equal(typeof mod.createChildCliMmrSubagentRunner, "function");
    const runner = mod.createChildCliMmrSubagentRunner();
    assert.equal(typeof runner.run, "function");
  });

  it("re-exports the runner interface and factory from the package root", async () => {
    const mod = await importSource(ROOT_MODULE);
    assert.equal(typeof mod.createChildCliMmrSubagentRunner, "function");
    assert.equal(typeof mod.createMmrSubagentRunnerFromRunWorker, "function");
  });
});

describe("createMmrSubagentRunnerFromRunWorker — shared test-injection adapter", () => {
  it("maps MmrSubagentRunOptions to RunMmrSubagentWorkerOptions (renames onProgress → onUpdate)", async () => {
    const { createMmrSubagentRunnerFromRunWorker } = await importSource(RUNNER_MODULE);
    const calls = [];
    const progressEvents = [];
    const fakeRunWorker = async (workerOptions) => {
      calls.push(workerOptions);
      // Simulate the worker emitting one progress event via the
      // mapped `onUpdate` callback so we can verify the rename.
      workerOptions.onUpdate?.({ messages: [], finalOutput: "", truncatedFinalOutput: "", usage: {}, toolActivity: [], trail: [] });
      return {
        messages: [],
        finalOutput: "done",
        truncatedFinalOutput: "done",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
        prompt: workerOptions.prompt,
        cwd: workerOptions.cwd,
        command: "pi",
        args: [],
        exitCode: 0,
        signal: null,
        stderr: "",
        aborted: false,
        outputTruncated: false,
        ignoredJsonLines: 0,
        toolActivity: [],
        trail: [],
      };
    };
    const runner = createMmrSubagentRunnerFromRunWorker(fakeRunWorker);
    const result = await runner.run({
      profileName: "finder",
      parentMode: "rush",
      prompt: "q",
      cwd: "/tmp/cwd",
      model: "openai/gpt-5.4-mini",
      tools: ["read", "grep"],
      systemPrompt: "sys",
      onProgress: (s) => progressEvents.push(s),
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].profileName, "finder");
    assert.equal(calls[0].parentMode, "rush");
    assert.equal(calls[0].prompt, "q");
    assert.equal(calls[0].model, "openai/gpt-5.4-mini");
    assert.deepEqual(calls[0].tools, ["read", "grep"]);
    assert.equal(calls[0].systemPrompt, "sys");
    assert.equal(typeof calls[0].onUpdate, "function");
    assert.equal(progressEvents.length, 1);
    assert.equal(result.exitCode, 0);
  });

  it("forwards systemPromptDelivery through the mapper (previously dropped by per-tool adapters)", async () => {
    // The per-tool createRunnerFromRunWorker helpers each silently
    // dropped systemPromptDelivery because they pre-dated that field.
    // The shared adapter goes through the canonical mapper so the
    // option reaches the worker. This test pins that fix.
    const { createMmrSubagentRunnerFromRunWorker } = await importSource(RUNNER_MODULE);
    let captured;
    const fakeRunWorker = async (workerOptions) => {
      captured = workerOptions;
      return {
        messages: [], finalOutput: "", truncatedFinalOutput: "",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        prompt: "", cwd: "/tmp", command: "pi", args: [],
        exitCode: 0, signal: null, stderr: "", aborted: false,
        outputTruncated: false, ignoredJsonLines: 0, toolActivity: [], trail: [],
      };
    };
    const runner = createMmrSubagentRunnerFromRunWorker(fakeRunWorker);
    await runner.run({
      profileName: "task-subagent",
      prompt: "x",
      cwd: "/tmp",
      systemPrompt: "sys",
      systemPromptDelivery: "replace",
    });
    assert.equal(captured.systemPromptDelivery, "replace", "systemPromptDelivery must reach the worker");
  });

  it("forwards optional MmrWorkerRunnerDeps verbatim to the worker function", async () => {
    const { createMmrSubagentRunnerFromRunWorker } = await importSource(RUNNER_MODULE);
    const calls = [];
    const fakeRunWorker = async (workerOptions, deps) => {
      calls.push({ workerOptions, deps });
      return {
        messages: [], finalOutput: "", truncatedFinalOutput: "",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        prompt: "", cwd: "/tmp", command: "pi", args: [],
        exitCode: 0, signal: null, stderr: "", aborted: false,
        outputTruncated: false, ignoredJsonLines: 0, toolActivity: [], trail: [],
      };
    };
    const sentinelDeps = { spawn: () => ({}), resolveInvocation: () => ({ command: "pi", args: [] }) };
    const runner = createMmrSubagentRunnerFromRunWorker(fakeRunWorker, sentinelDeps);
    await runner.run({ profileName: "finder", prompt: "x", cwd: "/tmp" });
    assert.equal(calls.length, 1);
    assert.strictEqual(calls[0].deps, sentinelDeps, "deps must be forwarded by reference");
  });
});

describe("child-CLI MmrSubagentRunner adapter", () => {
  it("delegates to runMmrSubagentWorker with option shape preserved", async () => {
    const { createChildCliMmrSubagentRunner } = await importSource(RUNNER_MODULE);
    const calls = [];
    const fakeSpawn = (command, args) => {
      calls.push({ command, args });
      const proc = {
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on(event, listener) {
          if (event === "close") queueMicrotask(() => listener(0, null));
          return this;
        },
        kill: () => true,
      };
      return proc;
    };
    const runner = createChildCliMmrSubagentRunner({
      spawn: fakeSpawn,
      resolveInvocation: (args) => ({ command: "pi", args }),
    });

    const result = await runner.run({
      profileName: "finder",
      prompt: "query text",
      cwd: "/tmp/cwd",
      tools: ["read", "grep"],
      model: "openai/gpt-5.4-mini",
      systemPrompt: "fake system prompt",
    });

    assert.equal(calls.length, 1, "child-CLI runner must spawn exactly one Pi worker");
    const { args } = calls[0];
    assert.ok(args.includes("--mmr-subagent"), "must include --mmr-subagent flag");
    const profileIndex = args.indexOf("--mmr-subagent");
    assert.equal(args[profileIndex + 1], "finder");
    assert.ok(args.includes("--model"), "must include --model flag");
    const modelIndex = args.indexOf("--model");
    assert.equal(args[modelIndex + 1], "openai/gpt-5.4-mini");
    assert.ok(args.includes("--tools"));
    const toolsIndex = args.indexOf("--tools");
    assert.equal(args[toolsIndex + 1], "read,grep");
    assert.equal(args.at(-1), "Task: query text");
    assert.equal(result.exitCode, 0);
    assert.equal(result.command, "pi");
    assert.deepEqual(result.args, args);
  });

  it("forwards onProgress events from the worker's progress snapshots", async () => {
    const { createChildCliMmrSubagentRunner } = await importSource(RUNNER_MODULE);
    let progressCount = 0;
    const fakeSpawn = (command, args) => {
      let stdoutCb;
      let closeCb;
      const proc = {
        stdout: {
          on(event, listener) {
            if (event === "data") stdoutCb = listener;
          },
        },
        stderr: { on: () => {} },
        on(event, listener) {
          if (event === "close") closeCb = listener;
          return this;
        },
        kill: () => true,
      };
      queueMicrotask(() => {
        stdoutCb?.(Buffer.from(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }) + "\n"));
        closeCb?.(0, null);
      });
      return proc;
    };
    const runner = createChildCliMmrSubagentRunner({
      spawn: fakeSpawn,
      resolveInvocation: (args) => ({ command: "pi", args }),
    });
    await runner.run({
      profileName: "finder",
      prompt: "q",
      cwd: "/tmp/cwd",
      onProgress: () => {
        progressCount += 1;
      },
    });
    assert.ok(progressCount > 0, "runner must surface at least one progress snapshot via onProgress");
  });
});

describe("createFinderTool({ runner })", () => {
  it("uses the injected MmrSubagentRunner instead of runWorker", async () => {
    const { createFinderTool } = await importSource(FINDER_MODULE);
    const calls = [];
    const fakeRunner = {
      async run(options) {
        calls.push(options);
        return makeWorkerResult({ finalOutput: "via runner", truncatedFinalOutput: "via runner" });
      },
    };
    const tool = createFinderTool({ runner: fakeRunner });
    const result = await tool.execute("call-1", { query: "find me" }, undefined, undefined, { cwd: "/tmp/runner-cwd" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].profileName, "finder");
    assert.equal(calls[0].prompt, "find me");
    assert.equal(calls[0].cwd, "/tmp/runner-cwd");
    // Parent omits explicit --tools; child resolves workerTools itself.
    assert.equal(calls[0].tools, undefined);
    assert.match(result.content[0].text, /via runner/);
  });

  it("prefers the injected runner over runWorker when both are present", async () => {
    const { createFinderTool } = await importSource(FINDER_MODULE);
    let runWorkerCalls = 0;
    let runnerCalls = 0;
    const previousWarn = console.warn;
    const warnCalls = [];
    console.warn = (...args) => {
      warnCalls.push(args.join(" "));
    };
    try {
      const tool = createFinderTool({
        runWorker: async () => {
          runWorkerCalls += 1;
          return makeWorkerResult();
        },
        runner: {
          async run() {
            runnerCalls += 1;
            return makeWorkerResult({ finalOutput: "from runner" });
          },
        },
      });
      await tool.execute("call-1", { query: "find" }, undefined, undefined, { cwd: "/tmp/cwd" });
    } finally {
      console.warn = previousWarn;
    }
    assert.equal(runnerCalls, 1);
    assert.equal(runWorkerCalls, 0, "runWorker must be ignored when runner is also provided");
    assert.ok(
      warnCalls.some((line) => /runner.*runWorker/i.test(line)),
      "expected a one-line console.warn naming both runner and runWorker",
    );
  });
});

describe("createOracleTool({ runner })", () => {
  it("uses the injected MmrSubagentRunner instead of runWorker", async () => {
    const { createOracleTool } = await importSource(ORACLE_MODULE);
    const calls = [];
    const fakeRunner = {
      async run(options) {
        calls.push(options);
        return makeWorkerResult({ finalOutput: "oracle-via-runner", truncatedFinalOutput: "oracle-via-runner" });
      },
    };
    const tool = createOracleTool({ runner: fakeRunner });
    const result = await tool.execute("call-1", { task: "Help debug" }, undefined, undefined, { cwd: "/tmp/oracle-cwd" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].profileName, "oracle");
    assert.equal(calls[0].cwd, "/tmp/oracle-cwd");
    assert.match(calls[0].prompt, /Help debug/);
    assert.match(result.content[0].text, /oracle-via-runner/);
  });
});
