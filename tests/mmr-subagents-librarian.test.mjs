import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const LIBRARIAN_MODULE = "extensions/mmr-workers/librarian.ts";
const PROMPTS_MODULE = "extensions/mmr-workers/prompts.ts";
const PROMPT_ASSEMBLY_MODULE = "extensions/mmr-core/subagent-prompt-assembly.ts";
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

beforeEach(async () => {
  const { clearMmrSubagentPromptBuilders } = await importSource(PROMPT_ASSEMBLY_MODULE);
  const { registerMmrSubagentsPromptBuilders } = await importSource(PROMPTS_MODULE);
  const {
    __resetMmrGithubToolSourcePathsForTests,
    registerMmrGithubToolSourcePath,
  } = await importSource(MMR_GITHUB_TOOL_OWNERSHIP_MODULE);
  clearMmrSubagentPromptBuilders();
  registerMmrSubagentsPromptBuilders();
  __resetMmrGithubToolSourcePathsForTests();
  registerMmrGithubToolSourcePath(GITHUB_SOURCE_PATH);
});

function usage(overrides = {}) {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0, ...overrides };
}

function makeWorkerResult(overrides = {}) {
  return {
    messages: [],
    finalOutput: "The router lives in [src/router.ts](https://github.com/acme/repo/blob/main/src/router.ts).",
    truncatedFinalOutput: "The router lives in [src/router.ts](https://github.com/acme/repo/blob/main/src/router.ts).",
    usage: usage({ input: 100, output: 50, turns: 1 }),
    model: "claude-opus-4-6",
    stopReason: "end_turn",
    errorMessage: undefined,
    prompt: "Query: explain routing",
    cwd: "/tmp/project",
    command: "pi",
    args: ["--mode", "json", "-p", "--no-session"],
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

function makeRunnerSpy(result = makeWorkerResult()) {
  const calls = [];
  const runWorker = async (options) => {
    calls.push(options);
    if (result instanceof Error) throw result;
    return result;
  };
  return { runWorker, calls };
}

function makeRegistry(models) {
  return {
    getAll: () => models,
    find: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
    hasConfiguredAuth: () => true,
    isUsingOAuth: (model) => model.provider.endsWith("subscription") || model.provider.endsWith("codex"),
  };
}

function makeCtx(models = [{ provider: "claude-subscription", id: "claude-opus-4-6", contextWindow: 200000 }]) {
  return {
    cwd: "/abs/project",
    modelRegistry: makeRegistry(models),
  };
}

// The librarian gate is registered + source-owned (not parent-active): the
// GitHub tools are registered globally by mmr-github but are not part of any
// user-facing mode's active set; the child worker activates them via --tools.
function githubHost({
  registered = GITHUB_TOOLS,
  sourcePath = GITHUB_SOURCE_PATH,
} = {}) {
  return {
    getAllTools: () => registered.map((name) => ({
      name,
      description: `${name} description`,
      promptSnippet: `${name} snippet`,
      promptGuidelines: [`${name} guideline`],
      parameters: { type: "object" },
      ...(sourcePath === null ? {} : { sourceInfo: { path: sourcePath } }),
    })),
    getActiveTools: () => [],
  };
}

function firstText(result) {
  return result.content.find((entry) => entry.type === "text")?.text ?? "";
}

describe("librarian tool definition", () => {
  it("declares the expected name, snippet, description, and schema", async () => {
    const {
      createLibrarianTool,
      LIBRARIAN_TOOL_NAME,
      LIBRARIAN_SUBAGENT_PROFILE_NAME,
      LIBRARIAN_PROMPT_SNIPPET,
      LIBRARIAN_DESCRIPTION,
    } = await importSource(LIBRARIAN_MODULE);
    assert.equal(LIBRARIAN_TOOL_NAME, "librarian");
    assert.equal(LIBRARIAN_SUBAGENT_PROFILE_NAME, "librarian");
    const tool = createLibrarianTool();
    assert.equal(tool.name, "librarian");
    assert.equal(tool.promptSnippet, LIBRARIAN_PROMPT_SNIPPET);
    assert.equal(tool.description, LIBRARIAN_DESCRIPTION);
    assert.equal(tool.renderShell, "self");
    const params = tool.parameters;
    assert.equal(params.type, "object");
    assert.deepEqual(params.required, ["query"]);
    assert.equal(params.additionalProperties, false);
    assert.equal(params.properties.query.type, "string");
    assert.equal(params.properties.query.minLength, 1);
    assert.match(params.properties.query.description, /remote-repository research question/i);
    assert.equal(params.properties.context.type, "string");
    assert.match(params.properties.context.description, /Do not put secrets or credentials/i);
  });

  it("description and guidelines steer remote repository research without local mutation", async () => {
    const { createLibrarianTool, LIBRARIAN_PROMPT_GUIDELINES } = await importSource(LIBRARIAN_MODULE);
    const tool = createLibrarianTool();
    assert.match(tool.description, /Research remote repositories with the librarian/i);
    assert.match(tool.description, /Public GitHub repositories/i);
    assert.match(tool.description, /architecture explanation/i);
    assert.match(tool.description, /behavior evolution through commits or diffs/i);
    assert.match(tool.description, /Do not use the librarian when:/i);
    assert.match(tool.description, /local workspace/i);
    assert.match(tool.description, /modify files, run code, create branches, or open pull requests/i);
    assert.match(tool.description, /owner\/repo or a full repository URL/i);
    assert.match(tool.description, /Preserve the librarian's full answer/i);
    assert.match(tool.description, /kubernetes\/kubernetes/);
    assert.match(tool.description, /facebook\/react/);
    assert.match(tool.description, /vercel\/next\.js/);
    assert.deepEqual(tool.promptGuidelines, [...LIBRARIAN_PROMPT_GUIDELINES]);
    for (const guideline of LIBRARIAN_PROMPT_GUIDELINES) {
      assert.match(guideline, /librarian/i, `every guideline must name librarian; offender: ${guideline}`);
    }
  });

  it("worker tools are exactly the read-only GitHub provider allowlist", async () => {
    const { LIBRARIAN_WORKER_TOOLS } = await importSource(LIBRARIAN_MODULE);
    assert.deepEqual([...LIBRARIAN_WORKER_TOOLS], GITHUB_TOOLS);
    for (const forbidden of ["read", "grep", "find", "bash", "edit", "write", "apply_patch", "task_list", "oracle", "Task", "web_search", "read_web_page"]) {
      assert.equal(LIBRARIAN_WORKER_TOOLS.includes(forbidden), false, `${forbidden} must not be in librarian worker tools`);
    }
  });
});

describe("librarian worker system prompt", () => {
  it("re-exports the canonical prompt builder", async () => {
    const { buildLibrarianWorkerSystemPrompt } = await importSource(LIBRARIAN_MODULE);
    const prompt = buildLibrarianWorkerSystemPrompt("/abs/repo");
    assert.match(prompt, /You are Librarian, a specialized repository research worker\./);
    assert.match(prompt, /## Responsibilities/);
    assert.match(prompt, /## Research guidelines/);
    assert.match(prompt, /Use the available tools extensively/);
    assert.match(prompt, /commit history, diffs, and file revisions/i);
    assert.match(prompt, /reads public GitHub repositories/i);
    assert.match(prompt, /github\.com\/<owner>\/<repo>\/blob\/<revision>/);
    assert.match(prompt, /Never name tools in the user-facing answer/i);
    assert.match(prompt, /Use fluent links/);
    assert.doesNotMatch(prompt, /Working directory:/);
    assert.doesNotMatch(prompt, /apply_patch|task_list|bash|edit|write/);
  });
});

describe("librarian execute() validation and gating", () => {
  it("returns validation-error for invalid params before spawning", async () => {
    const { createLibrarianTool } = await importSource(LIBRARIAN_MODULE);
    const { runWorker, calls } = makeRunnerSpy();
    const tool = createLibrarianTool({ runWorker, pi: githubHost() });
    const cases = [
      undefined,
      null,
      [],
      { query: "" },
      { query: "   " },
      { query: "ok", context: 42 },
      { query: "ok", extra: true },
    ];
    for (const raw of cases) {
      const result = await tool.execute("c", raw, undefined, undefined, makeCtx());
      assert.equal(result.details.status, "validation-error");
      assert.match(firstText(result), /librarian: invalid parameters:/);
    }
    assert.equal(calls.length, 0, "invalid calls must not spawn the worker");
  });

  it("returns provider-gated when any GitHub tool is not registered", async () => {
    const { createLibrarianTool } = await importSource(LIBRARIAN_MODULE);
    const cases = [
      { label: "none", registered: [] },
      { label: "missing diff_github", registered: GITHUB_TOOLS.filter((t) => t !== "diff_github") },
      { label: "missing search_github", registered: GITHUB_TOOLS.filter((t) => t !== "search_github") },
    ];
    for (const c of cases) {
      const { runWorker, calls } = makeRunnerSpy();
      const tool = createLibrarianTool({ runWorker, pi: githubHost({ registered: c.registered }) });
      const result = await tool.execute("c", { query: "Explain acme/repo routing" }, undefined, undefined, makeCtx());
      assert.equal(result.details.status, "provider-gated", c.label);
      assert.match(firstText(result), /requires mmr-github read-only GitHub tools/);
      assert.equal(calls.length, 0, `${c.label}: gated calls must not spawn`);
    }
  });

  it("returns provider-gated when GitHub tool names exist but are not owned by mmr-github", async () => {
    const { createLibrarianTool } = await importSource(LIBRARIAN_MODULE);
    const cases = [
      { label: "missing sourceInfo", sourcePath: null },
      { label: "third-party source", sourcePath: "/virtual/other-extension/index.ts" },
    ];
    for (const c of cases) {
      const { runWorker, calls } = makeRunnerSpy();
      const tool = createLibrarianTool({ runWorker, pi: githubHost({ sourcePath: c.sourcePath }) });
      const result = await tool.execute("c", { query: "Explain acme/repo routing" }, undefined, undefined, makeCtx());
      assert.equal(result.details.status, "provider-gated", c.label);
      assert.match(firstText(result), /requires mmr-github read-only GitHub tools/);
      assert.equal(calls.length, 0, `${c.label}: gated calls must not spawn`);
    }
  });

  it("returns activation-error when no librarian model route resolves", async () => {
    const { createLibrarianTool } = await importSource(LIBRARIAN_MODULE);
    const { runWorker, calls } = makeRunnerSpy();
    const tool = createLibrarianTool({ runWorker, pi: githubHost() });
    const result = await tool.execute(
      "c",
      { query: "Explain acme/repo routing" },
      undefined,
      undefined,
      makeCtx([{ provider: "openai", id: "gpt-5.1" }]),
    );
    assert.equal(result.details.status, "activation-error");
    assert.match(firstText(result), /could not resolve a model route/i);
    assert.equal(calls.length, 0, "model route failures must not spawn");
  });
});

describe("librarian execute() runner dispatch", () => {
  it("composes the user prompt, resolves model/tools, replaces system prompt, and spawns once", async () => {
    const { createLibrarianTool, LIBRARIAN_WORKER_TOOLS } = await importSource(LIBRARIAN_MODULE);
    const { runWorker, calls } = makeRunnerSpy();
    const tool = createLibrarianTool({
      runWorker,
      pi: githubHost(),
      buildSystemPrompt: () => "LIBRARIAN SYSTEM PROMPT",
    });
    const controller = new AbortController();
    const result = await tool.execute(
      "call-1",
      {
        query: "  Explain acme/repo routing.  ",
        context: "  Focus on default-branch behavior.  ",
      },
      controller.signal,
      undefined,
      makeCtx(),
    );
    assert.equal(calls.length, 1);
    const options = calls[0];
    assert.equal(options.profileName, "librarian");
    assert.equal(options.prompt, "Context: Focus on default-branch behavior.\n\nQuery: Explain acme/repo routing.");
    assert.equal(options.cwd, "/abs/project");
    assert.deepEqual([...options.tools], [...LIBRARIAN_WORKER_TOOLS]);
    assert.equal(options.model, "claude-subscription/claude-opus-4-6");
    assert.equal(options.systemPrompt, "LIBRARIAN SYSTEM PROMPT");
    assert.equal(options.systemPromptDelivery, "replace");
    // Every run registers in the async-task registry, which owns the worker
    // AbortController; the runner receives the registry signal (adapted from
    // the tool-call signal), never the tool-call signal itself.
    assert.ok(options.signal instanceof AbortSignal, "runner must receive the registry-owned task signal");
    assert.notEqual(options.signal, controller.signal);
    assert.equal(options.signal.aborted, false);
    assert.equal(typeof options.outputByteLimit, "number");
    assert.equal(result.details.status, "success");
    assert.equal(result.details.query, "Explain acme/repo routing.");
    assert.equal(result.details.context, "Focus on default-branch behavior.");
    assert.equal(result.details.model, "claude-subscription/claude-opus-4-6");
    assert.deepEqual([...result.details.workerTools], [...LIBRARIAN_WORKER_TOOLS]);
  });

  it("reads settings-driven subagentModelPreferences.librarian on every execute", async () => {
    const { createLibrarianTool } = await importSource(LIBRARIAN_MODULE);
    const { runWorker, calls } = makeRunnerSpy();
    let settingsReads = 0;
    const tool = createLibrarianTool({
      runWorker,
      pi: githubHost(),
      loadSubagentModelPreferences: (cwd) => {
        settingsReads += 1;
        assert.equal(cwd, "/abs/project");
        return { librarian: [{ model: "gpt-5.5" }] };
      },
    });
    const ctx = makeCtx([
      { provider: "claude-subscription", id: "claude-opus-4-6", contextWindow: 200000 },
      { provider: "openai-codex", id: "gpt-5.5", contextWindow: 400000 },
    ]);

    await tool.execute("c1", { query: "Explain acme/repo routing" }, undefined, undefined, ctx);
    await tool.execute("c2", { query: "Explain acme/repo history" }, undefined, undefined, ctx);

    assert.equal(settingsReads, 2);
    assert.equal(calls[0].model, "openai-codex/gpt-5.5");
    assert.equal(calls[1].model, "openai-codex/gpt-5.5");
  });

  it("uses the bare Query form when context is absent or blank", async () => {
    const { createLibrarianTool } = await importSource(LIBRARIAN_MODULE);
    const { runWorker, calls } = makeRunnerSpy();
    const tool = createLibrarianTool({ runWorker, pi: githubHost() });
    await tool.execute("c1", { query: "Explain acme/repo routing", context: "   " }, undefined, undefined, makeCtx());
    assert.equal(calls[0].prompt, "Query: Explain acme/repo routing");
  });

  it("forwards progress with the librarian placeholder and child trail", async () => {
    const { createLibrarianTool, LIBRARIAN_PROGRESS_PLACEHOLDER } = await importSource(LIBRARIAN_MODULE);
    let captured;
    const runWorker = async (options) => {
      options.onUpdate?.({
        messages: [],
        finalOutput: "",
        truncatedFinalOutput: "",
        usage: usage(),
        trail: [{ type: "tool", toolCallId: "t1", toolName: "search_github", status: "running", argsPreview: '{"pattern":"router"}' }],
      });
      return makeWorkerResult();
    };
    const tool = createLibrarianTool({ runWorker, pi: githubHost() });
    await tool.execute("c", { query: "Explain acme/repo" }, undefined, (partial) => { captured = partial; }, makeCtx());
    assert.ok(captured);
    assert.equal(captured.content[0].text, LIBRARIAN_PROGRESS_PLACEHOLDER);
    assert.equal(captured.details.worker, "mmr-subagents.librarian");
    assert.equal(captured.details.status, "success");
    assert.equal(captured.details.query, "Explain acme/repo");
    assert.equal(captured.details.trail[0].toolName, "search_github");
  });
});

describe("librarian failure mapping", () => {
  it("maps runner activation markers to activation-error", async () => {
    const { createLibrarianTool } = await importSource(LIBRARIAN_MODULE);
    const failure = makeWorkerResult({
      finalOutput: "",
      truncatedFinalOutput: "",
      exitCode: 0,
      stderr: 'pi-mmr: subagent activation failed: Subagent "librarian" was invoked with --tools read_github,read, but the resolved worker tool set is read_github,list_directory_github.\n',
      subagentActivationError: 'Subagent "librarian" was invoked with --tools read_github,read, but the resolved worker tool set is read_github,list_directory_github.',
      errorMessage: 'subagent activation failed: Subagent "librarian" was invoked with --tools read_github,read, but the resolved worker tool set is read_github,list_directory_github.',
    });
    const { runWorker } = makeRunnerSpy(failure);
    const tool = createLibrarianTool({ runWorker, pi: githubHost() });
    const result = await tool.execute("c", { query: "Explain acme/repo" }, undefined, undefined, makeCtx());
    assert.equal(result.details.status, "activation-error");
    assert.match(firstText(result), /subagent activation failed/);
    assert.match(firstText(result), /resolved worker tool set/);
    assert.equal(result.details.subagentActivationError, failure.subagentActivationError);
  });

  it("maps aborts, worker errors, spawn errors, empty output, and context-window errors", async () => {
    const { createLibrarianTool, MmrLibrarianContextWindowError } = await importSource(LIBRARIAN_MODULE);
    const scenarios = [
      {
        expected: "aborted",
        result: makeWorkerResult({ finalOutput: "", truncatedFinalOutput: "", aborted: true, exitCode: null, signal: "SIGTERM" }),
        pattern: /research was cancelled/i,
      },
      {
        expected: "worker-error",
        result: makeWorkerResult({ finalOutput: "", truncatedFinalOutput: "", exitCode: 7, stderr: "fatal: boom\n" }),
        pattern: /worker exited with code 7[\s\S]*fatal: boom/,
      },
      {
        expected: "spawn-error",
        result: makeWorkerResult({ finalOutput: "", truncatedFinalOutput: "", exitCode: 1, spawnError: "spawn ENOENT", errorMessage: "spawn ENOENT" }),
        pattern: /worker failed to spawn: spawn ENOENT/,
      },
      {
        expected: "empty-output",
        result: makeWorkerResult({ finalOutput: "", truncatedFinalOutput: "", exitCode: 0 }),
        pattern: /no repository findings were produced/i,
      },
      {
        expected: "context-window-exhausted",
        result: new MmrLibrarianContextWindowError("context window exceeded"),
        pattern: /context window limit reached/i,
      },
    ];
    for (const scenario of scenarios) {
      const { runWorker } = makeRunnerSpy(scenario.result);
      const tool = createLibrarianTool({ runWorker, pi: githubHost() });
      const result = await tool.execute("c", { query: "Explain acme/repo" }, undefined, undefined, makeCtx());
      assert.equal(result.details.status, scenario.expected);
      assert.match(firstText(result), scenario.pattern, scenario.expected);
    }
  });
});

describe("librarian blocking-vs-background guidance", () => {
  it("keeps guidelines to a single routing line and states blocking/background in the description", async () => {
    const { createLibrarianTool } = await importSource(LIBRARIAN_MODULE);
    const tool = createLibrarianTool();
    // The Guidelines block carries exactly one routing line; the
    // blocking-vs-background policy renders once in the `## Using workers`
    // block and in the schema description, never in per-tool guidelines.
    assert.equal(tool.promptGuidelines.length, 1);
    assert.match(tool.promptGuidelines[0], /understanding outside the local workspace/);
    for (const guideline of tool.promptGuidelines) {
      assert.doesNotMatch(guideline, /start_task|blocking/i);
    }
    assert.match(
      tool.description,
      /blocking by default/i,
      "librarian description must state it is blocking by default",
    );
    assert.match(
      tool.description,
      /background: true/,
      "librarian description must name the background: true path",
    );
    assert.doesNotMatch(
      tool.description,
      /start_task/,
      "librarian description must not route background runs to the deprecated start_task alias",
    );
  });
});
