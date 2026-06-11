import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, getPreparedSourceRoot, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const repoRoot = path.resolve(import.meta.dirname, "..");
const subagentsExtensionPath = "./src/extensions/mmr-workers/index.ts";
const MMR_GITHUB_TOOL_OWNERSHIP_MODULE = "extensions/mmr-github/tool-ownership.ts";
const GITHUB_SOURCE_PATH = "/virtual/pi-mmr/extensions/mmr-github/index.ts";
const GITHUB_TOOLS = [
  "read_github",
  "list_directory_github",
  "glob_github",
  "search_github",
  "commit_search",
  "diff_github",
  "list_repositories",
];

async function mmrGithubToolInfos(names = GITHUB_TOOLS, sourcePath = GITHUB_SOURCE_PATH) {
  const {
    __resetMmrGithubToolSourcePathsForTests,
    registerMmrGithubToolSourcePath,
  } = await importSource(MMR_GITHUB_TOOL_OWNERSHIP_MODULE);
  __resetMmrGithubToolSourcePathsForTests();
  registerMmrGithubToolSourcePath(GITHUB_SOURCE_PATH);
  return names.map((name) => ({
    name,
    ...(sourcePath === null ? {} : { sourceInfo: { path: sourcePath } }),
  }));
}

function normalizeTool(tool) {
  return typeof tool === "string" ? { name: tool } : tool;
}

function makePi(options = {}) {
  const tools = [];
  const handlers = new Map();
  const externalTools = (options.externalTools ?? []).map(normalizeTool);
  const activeTools = options.activeTools ?? externalTools.map((tool) => tool.name);
  return {
    tools,
    handlers,
    pi: {
      registerTool: (definition) => tools.push(definition),
      on: (name, handler) => handlers.set(name, handler),
      getActiveTools: () => [...activeTools],
      getAllTools: () => [...externalTools, ...tools].map((tool) => ({ ...tool })),
    },
  };
}

async function importRuntime() {
  const url = pathToFileURL(path.join(getPreparedSourceRoot(), "extensions/mmr-core/runtime.ts")).href;
  return import(url);
}

async function importCacheIsolatedRuntime() {
  return importSource("extensions/mmr-core/runtime.ts");
}

async function readPackageJson() {
  return JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
}

describe("mmr-subagents package wiring", () => {
  it("registers mmr-subagents as a Pi extension after mmr-core", async () => {
    const pkg = await readPackageJson();
    const indexOfCore = pkg.pi.extensions.indexOf("./src/extensions/mmr-core/index.ts");
    const indexOfSubagents = pkg.pi.extensions.indexOf(subagentsExtensionPath);
    assert.notEqual(indexOfCore, -1, "mmr-core must be registered as a Pi extension");
    assert.notEqual(indexOfSubagents, -1, "mmr-subagents must be registered as a Pi extension");
    assert.ok(
      indexOfSubagents > indexOfCore,
      "mmr-subagents must load after mmr-core so the runtime singleton is available.",
    );
  });

  it("exposes a package subpath for direct extension loading", async () => {
    const pkg = await readPackageJson();
    assert.equal(pkg.exports["./extensions/mmr-workers"], subagentsExtensionPath);
    assert.equal(pkg.exports["./extensions/mmr-subagents"], undefined, "the pre-merge subpath is removed");
  });

  it("exports a default factory and a createMmrWorkersExtension test seam", async () => {
    const mod = await importSource("extensions/mmr-workers/index.ts");
    assert.equal(typeof mod.default, "function");
    assert.equal(typeof mod.createMmrWorkersExtension, "function");
  });

  it("re-exports the mmr-subagents public surface from the package root", async () => {
    const root = await importSource("index.ts");
    assert.equal(typeof root.createMmrWorkersExtension, "function");
    assert.equal(typeof root.createMmrSubagentsFeatureGateProvider, "function");
    assert.equal(typeof root.createMmrSubagentsToolProvider, "function");
    assert.equal(typeof root.runMmrSubagentWorker, "function");
    assert.equal(root.runMmrWorker, undefined, "retired in favor of runMmrSubagentWorker");
    assert.equal(typeof root.buildMmrWorkerArgs, "function");
    assert.equal(root.MMR_SUBAGENTS_PROVIDER_NAME, "mmr-subagents");
    assert.equal(root.MMR_SUBAGENTS_FEATURE_GATE, "mmr-subagents");
    assert.deepEqual(
      [...root.MMR_SUBAGENTS_OWNED_TOOLS].sort(),
      ["Task", "code_review", "finder", "librarian", "oracle"],
    );
    assert.equal(root.MMR_ASYNC_TASKS_PROVIDER_NAME, "mmr-async-tasks");
    assert.equal(root.MMR_ASYNC_TASKS_FEATURE_GATE, "mmr-async-tasks");
    assert.equal(root.MMR_SUBAGENTS_ASYNC_TASKS_FEATURE_GATE, "mmr-subagents.async-tasks");
    assert.deepEqual(
      [...root.MMR_ASYNC_TASK_TOOLS],
      ["start_task", "task_poll", "task_wait", "task_cancel"],
    );
    assert.deepEqual([...root.MMR_SUBAGENTS_ASYNC_TASK_TOOLS], [...root.MMR_ASYNC_TASK_TOOLS]);
    assert.equal(typeof root.createStartTaskTool, "function");
    assert.equal(typeof root.createTaskPollTool, "function");
    assert.equal(typeof root.createTaskWaitTool, "function");
    assert.equal(typeof root.createTaskCancelTool, "function");
    assert.equal(typeof root.registerAsyncTaskTools, "function");
    assert.equal(typeof root.getMmrAsyncTaskRegistry, "function");
    assert.equal(typeof root.createMmrAsyncTaskRegistry, "function");
    assert.equal(typeof root.toPublicAsyncTaskSnapshot, "function");
    assert.equal(root.MMR_SUBAGENTS_ASYNC_PUSH_ENV, "MMR_SUBAGENTS_ASYNC_PUSH");
    assert.equal(typeof root.DEFAULT_ASYNC_TASK_MAX_PUSHES_PER_SESSION, "number");
    // prepareTaskRun was retired in the "everything is a task" convergence:
    // the background surface prepares Task runs through the worker-tool
    // factory exactly like the blocking tool.
    assert.equal(root.prepareTaskRun, undefined, "prepareTaskRun must no longer be exported");
    assert.equal(root.START_TASK_TOOL_NAME, "start_task");
    // Finder, oracle, Task, and librarian ship in this slice; their public surfaces
    // must be reachable from the package root so consumers can build the tools with
    // a different runner injected (tests, alt hosts).
    assert.equal(typeof root.createFinderTool, "function");
    assert.equal(typeof root.registerFinderTool, "function");
    assert.equal(typeof root.buildFinderWorkerSystemPrompt, "function");
    // selectFinderWorkerModel was removed (issue-#1 "Option A"): finder now
    // resolves its worker route through the shared selectMmrModelRoute
    // registry resolver, so the public string selector is no longer exported.
    assert.equal(root.selectFinderWorkerModel, undefined, "selectFinderWorkerModel must no longer be exported");
    assert.equal(root.FINDER_TOOL_NAME, "finder");
    assert.deepEqual([...root.FINDER_WORKER_TOOLS].sort(), ["find", "grep", "read"]);
    assert.equal(typeof root.createCodeReviewTool, "function");
    assert.equal(typeof root.registerCodeReviewTool, "function");
    assert.equal(typeof root.buildCodeReviewWorkerSystemPrompt, "function");
    assert.equal(root.CODE_REVIEW_TOOL_NAME, "code_review");
    assert.equal(root.CODE_REVIEW_SUBAGENT_PROFILE, "code-review");
    assert.deepEqual([...root.CODE_REVIEW_WORKER_TOOLS], ["read", "grep", "find", "bash"]);
    assert.equal(typeof root.createOracleTool, "function");
    assert.equal(typeof root.registerOracleTool, "function");
    assert.equal(typeof root.buildOracleWorkerSystemPrompt, "function");
    // selectOracleWorkerModel was removed (issue-#1 "Option A"): oracle now
    // resolves its worker route through the shared selectMmrModelRoute
    // registry resolver, so the public string selector is no longer exported.
    assert.equal(root.selectOracleWorkerModel, undefined, "selectOracleWorkerModel must no longer be exported");
    assert.equal(root.ORACLE_TOOL_NAME, "oracle");
    assert.deepEqual(
      [...root.ORACLE_WORKER_TOOLS],
      ["read", "grep", "find", "web_search", "read_web_page", "read_session", "find_session"],
    );
    // The Cthulu advisor has been removed; its public exports must be gone.
    assert.equal(root.createCthuluTool, undefined);
    assert.equal(root.registerCthuluTool, undefined);
    assert.equal(root.buildCthuluWorkerSystemPrompt, undefined);
    assert.equal(root.CTHULU_TOOL_NAME, undefined);
    assert.equal(root.CTHULU_SUBAGENT_PROFILE, undefined);
    assert.equal(root.CTHULU_WORKER_TOOLS, undefined);
    assert.equal(typeof root.createLibrarianTool, "function");
    assert.equal(typeof root.registerLibrarianTool, "function");
    assert.equal(typeof root.buildLibrarianWorkerSystemPrompt, "function");
    assert.equal(typeof root.isLibrarianGithubToolPrerequisiteRegistered, "function");
    assert.equal(typeof root.MmrLibrarianContextWindowError, "function");
    assert.equal(root.LIBRARIAN_TOOL_NAME, "librarian");
    assert.equal(root.LIBRARIAN_SUBAGENT_PROFILE_NAME, "librarian");
    assert.deepEqual([...root.LIBRARIAN_WORKER_TOOLS], [
      "read_github",
      "list_directory_github",
      "glob_github",
      "search_github",
      "commit_search",
      "diff_github",
      "list_repositories",
    ]);
    assert.equal(typeof root.LIBRARIAN_DESCRIPTION, "string");
    assert.equal(root.LIBRARIAN_PROMPT_SNIPPET, "Research remote repositories and repository history with a read-only librarian worker.");
    assert.ok(Array.isArray(root.LIBRARIAN_PROMPT_GUIDELINES));
    assert.equal(root.LIBRARIAN_PARAMETERS_SCHEMA.type, "object");
    assert.equal(root.LIBRARIAN_PROGRESS_PLACEHOLDER, "librarian: researching repositories…");
    assert.equal(typeof root.createTaskTool, "function");
    assert.equal(typeof root.registerTaskTool, "function");
    assert.equal(typeof root.buildTaskWorkerSystemPrompt, "function");
    // Behavioral pin (Task routing/profile):
    // Task uses `resolveMmrSubagentInvocation` from mmr-core as the single
    // source of truth for routing; the legacy `selectTaskWorkerModel` and
    // `TASK_DEFAULT_MODEL_PREFERENCES` exports are intentionally removed.
    assert.equal(root.selectTaskWorkerModel, undefined);
    assert.equal(root.TASK_DEFAULT_MODEL_PREFERENCES, undefined);
    assert.equal(typeof root.resolveMmrSubagentInvocation, "function");
    assert.equal(root.TASK_TOOL_NAME, "Task");
    assert.equal(root.TASK_SUBAGENT_PROFILE, "task-subagent");
    assert.deepEqual(
      [...root.TASK_WORKER_TOOLS],
      ["read", "bash", "edit", "write", "read_web_page", "web_search", "finder", "skill", "task_list"],
    );
  });
});

describe("mmr-subagents extension factory", () => {
  it("registers the finder, oracle, Task, librarian, and code_review Pi tools plus the read-result normalizer", async () => {
    const { createMmrWorkersExtension } = await importSource("extensions/mmr-workers/index.ts");
    const { pi, tools, handlers } = makePi();
    createMmrWorkersExtension()(pi);
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(
      names,
      ["Task", "code_review", "finder", "librarian", "oracle", "start_task", "task_cancel", "task_poll", "task_wait"],
      "mmr-workers registers the blocking worker tools and the background task tools",
    );
    assert.equal(typeof handlers.get("tool_result"), "function", "finder installs a read-result normalizer");
    assert.equal(typeof handlers.get("before_agent_start"), "function", "Task captures the parent prompt for mode-derived workers");
    assert.equal(typeof handlers.get("session_shutdown"), "function", "the merged extension owns session_shutdown cleanup");
    assert.equal(typeof handlers.get("session_start"), "function", "clears session-scoped worker-fallback state on new/fork sessions");
  });

  it("numbers native read output only while the finder subagent profile is active", async () => {
    const { createMmrWorkersExtension } = await importSource("extensions/mmr-workers/index.ts");
    const runtime = await importCacheIsolatedRuntime();
    const { pi, handlers } = makePi();
    createMmrWorkersExtension()(pi);

    const readEvent = {
      type: "tool_result",
      toolCallId: "read-1",
      toolName: "read",
      input: { path: "src/foo.ts", offset: 41 },
      content: [{ type: "text", text: "alpha\nbeta" }],
      details: undefined,
      isError: false,
    };
    assert.equal(await handlers.get("tool_result")(readEvent, {}), undefined);

    runtime.setMmrSubagentState({
      profile: "finder",
      provider: "google",
      model: "gpt-5.4-mini",
      thinkingLevel: "minimal",
      promptRoute: "subagent",
      activeTools: ["grep", "find", "read"],
      activatedAt: "2026-05-24T00:00:00.000Z",
    });
    try {
      const result = await handlers.get("tool_result")(readEvent, {});
      assert.deepEqual(result.content, [{ type: "text", text: "41: alpha\n42: beta" }]);
    } finally {
      runtime.setMmrSubagentState(undefined);
    }
  });

  it("flips finder, oracle, Task, and librarian to active when the mmr-github tools are registered", async () => {
    const { createMmrWorkersExtension } = await importSource("extensions/mmr-workers/index.ts");
    const runtime = await importRuntime();
    const { pi, tools } = makePi({ externalTools: await mmrGithubToolInfos() });
    createMmrWorkersExtension()(pi);

    const available = ["read", "bash", "edit", "write", "grep", "find", "web_search", "read_web_page", ...tools.map((tool) => tool.name)];
    const resolved = runtime.resolveMmrTools("smart", available);
    for (const shipped of ["finder", "oracle", "Task", "librarian"]) {
      const decision = resolved.decisions.find((d) => d.requested === shipped);
      assert.ok(decision, `${shipped} must produce a decision`);
      assert.equal(decision.status, "active", `${shipped} must resolve as active`);
      assert.equal(decision.owner, "mmr-workers");
      assert.equal(resolved.activeTools.includes(shipped), true);
      assert.equal(resolved.gatedTools.includes(shipped), false);
    }
  });

  it("keeps librarian gated and provider-attributed when the GitHub tool prerequisite is missing", async () => {
    const { createMmrWorkersExtension } = await importSource("extensions/mmr-workers/index.ts");
    const runtime = await importRuntime();
    const { pi, tools } = makePi();
    createMmrWorkersExtension()(pi);

    const available = ["read", "bash", "edit", "write", "grep", "find", ...tools.map((tool) => tool.name)];
    const resolved = runtime.resolveMmrTools("smart", available);
    for (const shipped of ["finder", "oracle", "Task"]) {
      const decision = resolved.decisions.find((d) => d.requested === shipped);
      assert.ok(decision, `${shipped} must produce a decision`);
      assert.equal(decision.status, "active", `${shipped} must resolve as active`);
      assert.equal(decision.owner, "mmr-workers");
    }

    const decision = resolved.decisions.find((d) => d.requested === "librarian");
    assert.ok(decision, "librarian must produce a decision");
    assert.equal(decision.status, "gated", "librarian must be gated, not deferred");
    assert.equal(decision.owner, "mmr-workers", "librarian must be owned by the merged mmr-workers extension");
    assert.match(decision.diagnostic, /requires mmr-github read-only GitHub tools/);
    assert.equal(resolved.gatedTools.includes("librarian"), true);
    assert.equal(resolved.deferredTools.includes("librarian"), false);
  });

  it("keeps librarian gated when GitHub tool names are registered by another source", async () => {
    const { createMmrWorkersExtension } = await importSource("extensions/mmr-workers/index.ts");
    const runtime = await importRuntime();
    const { pi, tools } = makePi({ externalTools: await mmrGithubToolInfos(GITHUB_TOOLS, "/virtual/other-extension/index.ts") });
    createMmrWorkersExtension()(pi);

    const available = ["read", "bash", "edit", "write", "grep", "find", ...tools.map((tool) => tool.name)];
    const resolved = runtime.resolveMmrTools("smart", available);
    const decision = resolved.decisions.find((d) => d.requested === "librarian");
    assert.ok(decision, "librarian must produce a decision");
    assert.equal(decision.status, "gated");
    assert.match(decision.diagnostic, /requires mmr-github read-only GitHub tools/);
  });

  it("keeps librarian capability independent from parent active-tool snapshots", async () => {
    const { createMmrWorkersExtension } = await importSource("extensions/mmr-workers/index.ts");
    const runtime = await importRuntime();
    // The GitHub tools are registered + owned but never part of the parent's
    // active set; the registered-only gate must still flip librarian active.
    const { pi, tools } = makePi({
      externalTools: await mmrGithubToolInfos(),
      activeTools: [],
    });
    createMmrWorkersExtension()(pi);

    const available = ["read", "bash", "edit", "write", "grep", "find", ...tools.map((tool) => tool.name)];
    const resolved = runtime.resolveMmrTools("smart", available);
    const decision = resolved.decisions.find((d) => d.requested === "librarian");
    assert.ok(decision, "librarian must produce a decision");
    assert.equal(decision.status, "active");
    assert.equal(resolved.activeTools.includes("librarian"), true);
  });

  it("does not shadow tool decisions for non-owned logical names", async () => {
    const { createMmrWorkersExtension } = await importSource("extensions/mmr-workers/index.ts");
    const runtime = await importRuntime();
    const { pi } = makePi();
    createMmrWorkersExtension()(pi);

    const resolved = runtime.resolveMmrTools("smart", ["read", "bash", "edit", "write", "grep", "find"]);
    const readDecision = resolved.decisions.find((d) => d.requested === "read");
    assert.ok(readDecision);
    assert.notEqual(readDecision.owner, "mmr-workers", "read must not be claimed by mmr-workers");
    assert.equal(readDecision.status, "active");
  });

  it("flips the mmr-subagents feature gate to enabled and lists the shipped capabilities", async () => {
    const { createMmrWorkersExtension } = await importSource("extensions/mmr-workers/index.ts");
    const runtime = await importRuntime();
    const { pi } = makePi();
    createMmrWorkersExtension()(pi);

    const [decision] = runtime.resolveMmrFeatureGates(["mmr-subagents"]);
    assert.equal(decision.gate, "mmr-subagents");
    assert.equal(decision.status, "enabled");
    assert.equal(decision.source, "mmr-workers");
    assert.match(decision.reason, /finder/i);
    assert.match(decision.reason, /oracle/i);
    assert.match(decision.reason, /Task/);
    assert.doesNotMatch(decision.reason, /librarian/);
  });

  it("only claims the mmr-subagents feature gate (leaves siblings to other providers)", async () => {
    const { createMmrWorkersExtension } = await importSource("extensions/mmr-workers/index.ts");
    const runtime = await importRuntime();
    const { pi } = makePi();
    createMmrWorkersExtension()(pi);

    const [history, toolboxMcp] = runtime.resolveMmrFeatureGates(["mmr-history", "mmr-toolbox-mcp"]);
    assert.notEqual(history.source, "mmr-workers");
    assert.notEqual(toolboxMcp.source, "mmr-workers");
  });
});

describe("mmr-subagents registration across cache-isolated extension entrypoints", () => {
  it("shares provider registrations with a separately imported mmr-core runtime", async () => {
    const { createMmrWorkersExtension } = await importSource("extensions/mmr-workers/index.ts");
    const runtime = await importCacheIsolatedRuntime();
    const { pi } = makePi();
    createMmrWorkersExtension()(pi);

    const resolved = runtime.resolveMmrTools(
      "smart",
      ["read", "bash", "edit", "write", "grep", "find", "finder", "oracle", "Task", "librarian"],
    );
    for (const shipped of ["finder", "oracle", "Task"]) {
      const decision = resolved.decisions.find((d) => d.requested === shipped);
      assert.ok(decision);
      assert.equal(decision.status, "active");
      assert.equal(decision.owner, "mmr-workers");
    }
    const decision = resolved.decisions.find((d) => d.requested === "librarian");
    assert.ok(decision);
    assert.equal(decision.status, "gated");
    assert.equal(decision.owner, "mmr-workers");

    const [gate] = runtime.resolveMmrFeatureGates(["mmr-subagents"]);
    assert.equal(gate.status, "enabled");
    assert.equal(gate.source, "mmr-workers");
  });
});
