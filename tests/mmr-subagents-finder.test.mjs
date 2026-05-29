// Unit tests for the `mmr-subagents` finder tool — written test-first to
// pin observable behavior before implementing src/extensions/mmr-subagents/finder.ts.
//
// Behavior pinned here (does NOT include the subprocess runner, which has
// its own tests, or the provider/extension wiring, which is exercised in
// mmr-subagents-extension.test.mjs):
//
//   1. The tool definition advertises a name, description, prompt snippet,
//      flat prompt guidelines, and a `{ query: string }`-only schema.
//   2. Every prompt guideline explicitly names `finder` (Pi's flat
//      guidelines requirement — bullets can't say "this tool").
//   3. The worker tool allowlist is read-only: `grep`, `find`, `read`, and
//      nothing else (no bash, no edit/write, no network).
//   4. The model selector prefers GPT-5.4 Mini, falls back to Claude Haiku,
//      and returns undefined when neither is available.
//   5. execute() rejects missing/blank `query` before spawning a worker.
//   6. execute() calls the injected runner exactly once with the parent
//      cwd, the user query, the worker tool allowlist, a finder-specific
//      system prompt that names Pi-native tool names, the parent abort
//      signal, and the selected model.
//   7. execute() forwards progress updates as `{ content: [{ type: "text" }] }`
//      so Pi can surface in-flight status to the model.
//   8. execute() returns the worker's truncated final output as visible
//      content and exposes runner metadata (model, exitCode, usage,
//      stderr, args) under `details`.
//   9. execute() degrades gracefully when the worker returns no final
//      output (aborted, nonzero exit, or empty success).
//
// Tests load `finder.ts` lazily via importSource so the file does not need
// to exist for the suite to *compile*; the imports execute inside each
// `it`, yielding a runtime RED until the production file ships.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, beforeEach, describe, it } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

initTheme(undefined, false);

after(cleanupLoadedSource);

const FINDER_MODULE = "extensions/mmr-subagents/finder.ts";
const PROMPTS_MODULE = "extensions/mmr-subagents/prompts.ts";
const PROMPT_ASSEMBLY_MODULE = "extensions/mmr-core/subagent-prompt-assembly.ts";
const MODEL_RESOLVER_MODULE = "extensions/mmr-core/model-resolver.ts";
const SUBAGENT_RESOLVER_MODULE = "extensions/mmr-core/subagent-resolver.ts";
const PROFILES_MODULE = "extensions/mmr-core/subagent-profiles.ts";

beforeEach(async () => {
  const { clearMmrSubagentPromptBuilders } = await importSource(PROMPT_ASSEMBLY_MODULE);
  const { registerMmrSubagentsPromptBuilders } = await importSource(PROMPTS_MODULE);
  clearMmrSubagentPromptBuilders();
  registerMmrSubagentsPromptBuilders();
});

function makeWorkerResult(overrides = {}) {
  return {
    messages: [],
    finalOutput: "1 file matched.\n\n[src/foo.ts#L1-L20](file:///abs/src/foo.ts#L1-L20)",
    truncatedFinalOutput: "1 file matched.\n\n[src/foo.ts#L1-L20](file:///abs/src/foo.ts#L1-L20)",
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
    model: "gpt-5.4-mini",
    stopReason: "end_turn",
    errorMessage: undefined,
    prompt: "find auth handlers",
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
    ...overrides,
  };
}

function makeRunnerSpy(result = makeWorkerResult()) {
  const calls = [];
  const runWorker = async (options) => {
    calls.push(options);
    return result;
  };
  return { runWorker, calls };
}

// Registry stub matching the shape `selectMmrModelRoute` consumes, plus the
// `getAvailable()` the finder context-window lookup reads. `models` entries
// are `{ provider, id, contextWindow? }`.
function makeRegistry(models) {
  return {
    getAll: () => models,
    find: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
    hasConfiguredAuth: () => true,
    isUsingOAuth: (model) => model.provider.endsWith("subscription") || model.provider.endsWith("codex"),
    getAvailable: () => models,
  };
}

function makeTempDir() {
  return mkdtempSync(path.join(os.tmpdir(), "pi-mmr-finder-test-"));
}

describe("finder tool definition", () => {
  it("declares the expected name, snippet, description, and required query parameter", async () => {
    const { createFinderTool, FINDER_TOOL_NAME, FINDER_PROMPT_SNIPPET, FINDER_DESCRIPTION } =
      await importSource(FINDER_MODULE);
    assert.equal(FINDER_TOOL_NAME, "finder");
    const tool = createFinderTool();
    assert.equal(tool.name, "finder");
    assert.equal(tool.promptSnippet, FINDER_PROMPT_SNIPPET);
    assert.equal(tool.description, FINDER_DESCRIPTION);
    assert.ok(typeof tool.description === "string" && tool.description.length > 0, "description must be non-empty");
    assert.ok(tool.parameters && typeof tool.parameters === "object", "parameters must be a schema object");
    const params = tool.parameters;
    assert.equal(params.type, "object");
    assert.deepEqual(params.required, ["query"]);
    assert.equal(params.properties.query.type, "string");
    assert.equal(typeof params.properties.query.description, "string");
  });

  it("description and schema give rich finder usage guidance", async () => {
    const { createFinderTool } = await importSource(FINDER_MODULE);
    const tool = createFinderTool();
    assert.match(tool.description, /Intelligently search your codebase/i);
    assert.match(tool.description, /functionality or concepts rather than exact matches/i);
    assert.match(tool.description, /Anytime you want to chain multiple grep calls/i);
    assert.match(tool.description, /WHEN TO USE THIS TOOL/);
    assert.match(tool.description, /locate code by behavior or concept/i);
    assert.match(tool.description, /multiple greps in sequence/i);
    assert.match(tool.description, /correlate.*several areas of the codebase/i);
    assert.match(tool.description, /filter broad terms.*config.*logger.*cache/i);
    assert.match(tool.description, /JWT authentication headers/i);
    assert.match(tool.description, /file-watcher retry logic/i);
    assert.match(tool.description, /codebase-location questions/i);
    assert.match(tool.description, /WHEN NOT TO USE THIS TOOL/i);
    assert.match(tool.description, /exact file path.*read directly/i);
    assert.match(tool.description, /specific symbols or exact strings.*find or grep/i);
    assert.match(tool.description, /create, modify files, or run terminal commands/i);
    assert.match(tool.description, /Always run multiple independent search strategies in parallel to maximise speed/i);
    assert.match(tool.description, /precise engineering request/i);
    assert.match(tool.description, /Find every place we build an HTTP error response/i);
    assert.match(tool.description, /error handling search/i);
    assert.match(tool.description, /Express middleware/i);
    assert.match(tool.description, /fs\.watch debounce/i);
    assert.match(tool.description, /success criteria/i);
    assert.match(tool.description, /all JWT verification calls/i);
    assert.match(tool.description, /vague or exploratory commands/i);
    assert.match(tool.description, /Find watchdog-related files under core and server\/src/i);
    assert.match(tool.description, /Find files named watchdog anywhere/i);
    assert.match(tool.description, /scoped grep searches/i);

    const params = tool.parameters;
    assert.match(params.properties.query.description, /technical terms/i);
    assert.match(params.properties.query.description, /file types/i);
    assert.match(params.properties.query.description, /expected code patterns/i);
    assert.match(params.properties.query.description, /concrete artifacts/i);
    assert.match(params.properties.query.description, /APIs/i);
    assert.match(params.properties.query.description, /scoped directories/i);
    assert.match(params.properties.query.description, /explicit success criteria/i);
    assert.match(params.properties.query.description, /found the right thing/i);
  });

  it("every prompt guideline names the tool (`finder ...`) so Pi's flat guidelines stay unambiguous", async () => {
    const { FINDER_PROMPT_GUIDELINES, createFinderTool } = await importSource(FINDER_MODULE);
    assert.ok(Array.isArray(FINDER_PROMPT_GUIDELINES) && FINDER_PROMPT_GUIDELINES.length > 0);
    for (const guideline of FINDER_PROMPT_GUIDELINES) {
      assert.match(
        guideline,
        /\bfinder\b/,
        `every guideline must name finder; offender: "${guideline}"`,
      );
    }
    const tool = createFinderTool();
    assert.deepEqual([...tool.promptGuidelines], [...FINDER_PROMPT_GUIDELINES]);
  });

  it("worker tool allowlist is read-only (no bash, no edit/write, no network)", async () => {
    const { FINDER_WORKER_TOOLS } = await importSource(FINDER_MODULE);
    assert.deepEqual([...FINDER_WORKER_TOOLS].sort(), ["find", "grep", "read"]);
    for (const forbidden of ["bash", "edit", "write", "apply_patch", "web_search", "read_web_page"]) {
      assert.equal(
        FINDER_WORKER_TOOLS.includes(forbidden),
        false,
        `${forbidden} must not be in the finder worker allowlist`,
      );
    }
  });
});

describe("finder worker system prompt", () => {
  it("includes the working directory and only references Pi-native search/read tools", async () => {
    const { buildFinderWorkerSystemPrompt } = await importSource(FINDER_MODULE);
    const prompt = buildFinderWorkerSystemPrompt("/abs/repo");
    assert.match(prompt, /\/abs\/repo/);
    assert.match(prompt, /Workspace root: \/abs\/repo/);
    assert.match(prompt, /\bgrep\b/);
    assert.match(prompt, /\bfind\b/);
    assert.match(prompt, /\bread\b/);
    assert.match(prompt, /8\+ parallel tool calls/);
    assert.match(prompt, /within 3 turns/);
    assert.match(prompt, /source code files \(\.ts, \.js, \.py, \.go, \.rs, \.java, etc\.\)/);
    assert.match(prompt, /find ALL occurrences/);
    assert.match(prompt, /Search breadth-first/);
    assert.match(prompt, /core\/\*\*\/\*watchdog\*/);
    assert.match(prompt, /Ultra concise/);
    assert.match(prompt, /read.*line: content.*prefixes/i);
    assert.match(prompt, /omit ranges when you cannot verify them/i);
    assert.match(prompt, /5-10 lines of buffer/);
    assert.match(prompt, /JWT tokens are created in the auth middleware/);
    assert.doesNotMatch(prompt, /\bbash\b/);
    assert.doesNotMatch(prompt, /\bedit\b/);
    assert.doesNotMatch(prompt, /\bwrite\b/);
  });

  it("falls back to a safe placeholder when cwd is missing", async () => {
    const { buildFinderWorkerSystemPrompt } = await importSource(FINDER_MODULE);
    const prompt = buildFinderWorkerSystemPrompt("");
    assert.doesNotMatch(prompt, /Working directory: \n/);
    assert.match(prompt, /Working directory:\s+\S/);
  });
});

describe("FINDER_DEFAULT_MODEL_PREFERENCES", () => {
  it("lists the provider-pinned Flash route first, then GPT-5.4 Mini, then Claude Haiku 4.5 as fallbacks", async () => {
    const { FINDER_DEFAULT_MODEL_PREFERENCES } = await importSource(FINDER_MODULE);
    const prefs = [...FINDER_DEFAULT_MODEL_PREFERENCES];
    const firstGemini = prefs.findIndex((entry) => /gemini-3\.5-flash-extra-low$/.test(entry));
    const firstGptMini = prefs.findIndex((entry) => /gpt-5\.4-mini$/.test(entry));
    const firstHaiku = prefs.findIndex((entry) => /claude-haiku-4-5$/.test(entry));
    assert.notEqual(firstGemini, -1, "expected a Gemini 3.5 Flash preference");
    assert.notEqual(firstGptMini, -1, "expected a GPT-5.4 Mini preference");
    assert.notEqual(firstHaiku, -1, "expected a Claude Haiku 4.5 preference");
    assert.ok(firstGemini < firstGptMini, "Gemini 3.5 Flash must precede GPT-5.4 Mini in preferences");
    assert.ok(firstGptMini < firstHaiku, "GPT-5.4 Mini must precede Claude Haiku 4.5 in preferences");
  });
});

describe("sanitizeFinderFileLinks", () => {
  it("leaves valid in-workspace file line ranges unchanged", async () => {
    const { sanitizeFinderFileLinks } = await importSource(FINDER_MODULE);
    const cwd = makeTempDir();
    try {
      const file = path.join(cwd, "src", "foo.ts");
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "one\ntwo\nthree\nfour\n", { flag: "w" });
      const input = `See [src/foo.ts#L2-L3](${pathToFileUri(file)}#L2-L3).`;
      assert.equal(sanitizeFinderFileLinks(input, cwd), input);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("clamps in-workspace ranges whose end is past EOF", async () => {
    const { sanitizeFinderFileLinks } = await importSource(FINDER_MODULE);
    const cwd = makeTempDir();
    try {
      const file = path.join(cwd, "finder.ts");
      writeFileSync(file, Array.from({ length: 464 }, (_, i) => `line ${i + 1}`).join("\n"));
      const input = `Relevant: [finder.ts#L450-L553](${pathToFileUri(file)}#L450-L553)`;
      const output = sanitizeFinderFileLinks(input, cwd);
      assert.match(output, /finder\.ts#L450-L464/);
      assert.match(output, /#L450-L464\)/);
      assert.doesNotMatch(output, /L553/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("strips impossible in-workspace ranges whose start is past EOF", async () => {
    const { sanitizeFinderFileLinks } = await importSource(FINDER_MODULE);
    const cwd = makeTempDir();
    try {
      const file = path.join(cwd, "finder.ts");
      writeFileSync(file, Array.from({ length: 464 }, (_, i) => `line ${i + 1}`).join("\n"));
      const input = `Bad: [finder.ts#L544-L553](${pathToFileUri(file)}#L544-L553)`;
      const output = sanitizeFinderFileLinks(input, cwd);
      assert.equal(output, `Bad: [finder.ts](${pathToFileUri(file)})`);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rewrites outside-cwd file links to plain display text and leaves malformed links unchanged", async () => {
    const { sanitizeFinderFileLinks } = await importSource(FINDER_MODULE);
    const cwd = makeTempDir();
    const outside = makeTempDir();
    try {
      const outsideFile = path.join(outside, "outside.ts");
      writeFileSync(outsideFile, "one\n");
      const malformed = "[bad](file:///not-a-real-file#not-lines)";
      const input = [
        `[outside.ts#L10-L20](${pathToFileUri(outsideFile)}#L10-L20)`,
        malformed,
      ].join("\n");
      const output = sanitizeFinderFileLinks(input, cwd);
      const [outsideLine, malformedLine] = output.split("\n");
      assert.equal(outsideLine, "outside.ts#L10-L20");
      assert.equal(malformedLine, malformed);
      assert.ok(!outsideLine.includes("file://"), "outside-cwd link must not stay a live file:// link");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("leaves a valid in-workspace link unchanged even when an outside-cwd link is also present", async () => {
    const { sanitizeFinderFileLinks } = await importSource(FINDER_MODULE);
    const cwd = makeTempDir();
    const outside = makeTempDir();
    try {
      const insideFile = path.join(cwd, "inside.ts");
      writeFileSync(insideFile, "a\nb\nc\nd\n");
      const outsideFile = path.join(outside, "outside.ts");
      writeFileSync(outsideFile, "one\n");
      const insideLink = `[inside.ts#L2-L3](${pathToFileUri(insideFile)}#L2-L3)`;
      const outsideLink = `[outside.ts#L10-L20](${pathToFileUri(outsideFile)}#L10-L20)`;
      const input = `${insideLink}\n${outsideLink}`;
      const output = sanitizeFinderFileLinks(input, cwd);
      const [first, second] = output.split("\n");
      assert.equal(first, insideLink);
      assert.equal(second, "outside.ts#L10-L20");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

function pathToFileUri(file) {
  return pathToFileURL(file).href;
}

describe("finder read result line numbers", () => {
  it("adds offset-aware line numbers to read output", async () => {
    const { addLineNumbersToFinderReadText } = await importSource(FINDER_MODULE);
    assert.equal(addLineNumbersToFinderReadText("alpha\nbeta\ngamma", 98), " 98: alpha\n 99: beta\n100: gamma");
  });
});

describe("finder execute() seam", () => {
  it("rejects missing blank or extra query parameters before spawning a worker", async () => {
    const { createFinderTool } = await importSource(FINDER_MODULE);
    const { runWorker, calls } = makeRunnerSpy();
    const tool = createFinderTool({ runWorker });
    await assert.rejects(tool.execute("c1", undefined, undefined, undefined, { cwd: "/tmp" }), /query/i);
    await assert.rejects(tool.execute("c2", { query: "" }, undefined, undefined, { cwd: "/tmp" }), /query/i);
    await assert.rejects(tool.execute("c3", { query: "   " }, undefined, undefined, { cwd: "/tmp" }), /query/i);
    await assert.rejects(
      tool.execute("c4", { query: "find auth checks", extra: true }, undefined, undefined, { cwd: "/tmp" }),
      /additional properties/i,
    );
    assert.equal(calls.length, 0, "runner must not be invoked when params are invalid");
  });

  it("calls the injected runner with cwd, query, worker tools, system prompt, signal, and selected model", async () => {
    const { createFinderTool, FINDER_WORKER_TOOLS } = await importSource(FINDER_MODULE);
    const { runWorker, calls } = makeRunnerSpy();
    const controller = new AbortController();
    const tool = createFinderTool({
      runWorker,
      buildSystemPrompt: (cwd) => `SP for ${cwd}`,
    });
    const result = await tool.execute(
      "call-1",
      { query: "where is the auth middleware?" },
      controller.signal,
      undefined,
      { cwd: "/abs/project", modelRegistry: makeRegistry([{ provider: "openai-codex", id: "gpt-5.4-mini" }]) },
    );
    assert.equal(calls.length, 1);
    const options = calls[0];
    assert.equal(options.prompt, "where is the auth middleware?");
    assert.equal(options.cwd, "/abs/project");
    // Parent omits explicit --tools so the child Pi process resolves
    // its own worker tool set via resolveMmrSubagentInvocation against
    // its registered-tool inventory. workerTools still appears in
    // result.details for parent-side observability.
    assert.equal(options.tools, undefined);
    assert.equal(options.systemPrompt, "SP for /abs/project");
    assert.equal(options.signal, controller.signal);
    assert.equal(options.model, "openai-codex/gpt-5.4-mini");
    assert.equal(options.profileName, "finder", "finder must call runMmrSubagentWorker with profileName='finder'");
    assert.equal("subagentProfile" in options, false, "runner contract uses profileName; the retired subagentProfile field must not leak into options");
    assert.equal(options.noExtensions, undefined, "finder must not request the legacy --no-extensions escape hatch");
    assert.equal(typeof options.outputByteLimit, "number");
    assert.ok(options.outputByteLimit > 0);
    assert.equal(result.details.model, "openai-codex/gpt-5.4-mini");
    assert.equal(result.details.cwd, "/abs/project");
    assert.deepEqual([...result.details.workerTools], [...FINDER_WORKER_TOOLS]);
  });

  it("routes runtime prompt assembly through assembleMmrSubagentSurface", async () => {
    const { createFinderTool } = await importSource(FINDER_MODULE);
    const {
      clearMmrSubagentPromptBuilders,
      registerMmrSubagentPromptBuilder,
    } = await importSource(PROMPT_ASSEMBLY_MODULE);
    const { runWorker, calls } = makeRunnerSpy();
    let spyCalls = 0;
    clearMmrSubagentPromptBuilders();
    registerMmrSubagentPromptBuilder("finder", ({ cwd, profile }) => {
      spyCalls += 1;
      assert.equal(profile.name, "finder");
      return `surface spy ${cwd}`;
    });
    const tool = createFinderTool({ runWorker });
    await tool.execute("c", { query: "find foo" }, undefined, undefined, { cwd: "/tmp/finder-surface" });
    assert.equal(spyCalls, 1, "execute must call the registered finder prompt builder via the surface API");
    assert.equal(calls[0].systemPrompt, "surface spy /tmp/finder-surface");
  });

  it("fails closed when the finder prompt builder is not registered", async () => {
    const { createFinderTool } = await importSource(FINDER_MODULE);
    const { clearMmrSubagentPromptBuilders } = await importSource(PROMPT_ASSEMBLY_MODULE);
    const { runWorker, calls } = makeRunnerSpy();
    clearMmrSubagentPromptBuilders();
    const tool = createFinderTool({ runWorker });
    await assert.rejects(
      tool.execute("c", { query: "find foo" }, undefined, undefined, { cwd: "/tmp" }),
      /no subagent prompt builder registered.*finder/i,
    );
    assert.equal(calls.length, 0, "runner must not start without the registered finder prompt builder");
  });

  it("omits --model when no preferred worker model is available", async () => {
    const { createFinderTool } = await importSource(FINDER_MODULE);
    const { runWorker, calls } = makeRunnerSpy();
    const tool = createFinderTool({ runWorker });
    await tool.execute("c", { query: "find foo" }, undefined, undefined, {
      cwd: "/tmp",
      modelRegistry: makeRegistry([{ provider: "openai", id: "gpt-5.5" }]),
    });
    assert.equal(calls.length, 1);
    assert.equal("model" in calls[0], false, "options.model must be omitted when no preference matches");
  });

  it("resolves the worker route from ctx.modelRegistry and reads its context window via getAvailable()", async () => {
    const { createFinderTool } = await importSource(FINDER_MODULE);
    const { runWorker, calls } = makeRunnerSpy();
    const tool = createFinderTool({ runWorker });
    const ctx = {
      cwd: "/abs/project",
      modelRegistry: makeRegistry([
        { provider: "openai", id: "gpt-5.5" },
        { provider: "openai-codex", id: "gpt-5.4-mini", contextWindow: 300_000 },
        { provider: "claude-subscription", id: "claude-haiku-4-5" },
      ]),
    };
    const result = await tool.execute("c", { query: "find foo" }, undefined, undefined, ctx);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].model,
      "openai-codex/gpt-5.4-mini",
      "default execute() must read available models from ctx.modelRegistry.getAvailable() and prefer GPT-5.4 Mini",
    );
    assert.equal(result.details.contextWindow, 300_000);
  });

  it("uses the antigravity Flash route and its context window from ctx.modelRegistry", async () => {
    const { createFinderTool } = await importSource(FINDER_MODULE);
    const { runWorker, calls } = makeRunnerSpy();
    const tool = createFinderTool({ runWorker });
    const ctx = {
      cwd: "/abs/project",
      modelRegistry: makeRegistry([
        { provider: "google", id: "gemini-3.5-flash", contextWindow: 128_000 },
        { provider: "antigravity", id: "gemini-3.5-flash-extra-low", contextWindow: 1_000_000 },
        { provider: "openai-codex", id: "gpt-5.4-mini", contextWindow: 300_000 },
      ]),
    };
    const result = await tool.execute("c", { query: "find foo" }, undefined, undefined, ctx);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, "antigravity/gemini-3.5-flash-extra-low");
    assert.equal(result.details.contextWindow, 1_000_000);
  });

  it("defaults to ctx.modelRegistry.getAvailable() and falls back to Claude Haiku 4.5 when no GPT-5.4 Mini route is registered", async () => {
    const { createFinderTool } = await importSource(FINDER_MODULE);
    const { runWorker, calls } = makeRunnerSpy();
    const tool = createFinderTool({ runWorker });
    const ctx = {
      cwd: "/tmp",
      modelRegistry: makeRegistry([
        { provider: "openai", id: "gpt-5.5" },
        { provider: "claude-subscription", id: "claude-haiku-4-5" },
      ]),
    };
    await tool.execute("c", { query: "x" }, undefined, undefined, ctx);
    assert.equal(calls[0].model, "claude-subscription/claude-haiku-4-5");
  });

  it("omits --model in default mode when ctx has no modelRegistry", async () => {
    const { createFinderTool } = await importSource(FINDER_MODULE);
    const { runWorker, calls } = makeRunnerSpy();
    const tool = createFinderTool({ runWorker });
    await tool.execute("c", { query: "x" }, undefined, undefined, { cwd: "/tmp" });
    assert.equal("model" in calls[0], false);
  });

  it("forwards runner progress as a Pi tool update with renderable child-tool activity", async () => {
    const { createFinderTool } = await importSource(FINDER_MODULE);
    let capturedUpdate;
    const runWorker = async (options) => {
      options.onUpdate?.({
        messages: [],
        finalOutput: "partial progress",
        truncatedFinalOutput: "partial progress",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        trail: [
          {
            type: "tool",
            toolCallId: "tool-1",
            toolName: "grep",
            status: "running",
            argsPreview: '{"pattern":"auth","path":"src"}',
          },
        ],
      });
      return makeWorkerResult();
    };
    const onUpdate = (partial) => { capturedUpdate = partial; };
    const tool = createFinderTool({ runWorker });
    await tool.execute("c", { query: "find" }, undefined, onUpdate, { cwd: "/tmp" });
    assert.ok(capturedUpdate, "execute must forward at least one progress update when the runner emits onUpdate");
    assert.ok(Array.isArray(capturedUpdate.content) && capturedUpdate.content.length > 0);
    assert.equal(capturedUpdate.content[0].type, "text");
    assert.match(capturedUpdate.content[0].text, /partial progress/);
    const grepTrailItem = capturedUpdate.details.trail.find((item) => item.type === "tool" && item.toolName === "grep");
    assert.ok(grepTrailItem, "forwarded progress trail should include the running grep tool entry");
    assert.equal(grepTrailItem.status, "running");

    const fakeTheme = {
      fg(_color, text) { return text; },
      bold(text) { return text; },
    };
    const collapsed = tool.renderResult(
      capturedUpdate,
      { expanded: false, isPartial: true },
      fakeTheme,
      { args: { query: "find" }, showImages: false, isError: false },
    ).render(200).join("\n");
    assert.match(collapsed, /running\.\.\./i);
    assert.doesNotMatch(collapsed, /[▸▾◐●⚠]/);
    assert.match(collapsed, /Ctrl\+O/i);
    assert.doesNotMatch(collapsed, /grep/);
    assert.doesNotMatch(collapsed, /auth/);

    const expanded = tool.renderResult(
      capturedUpdate,
      { expanded: true, isPartial: true },
      fakeTheme,
      { args: { query: "find" }, showImages: false, isError: false },
    ).render(200).join("\n");
    assert.match(expanded, /finder/i);
    assert.match(expanded, /grep/);
    assert.match(expanded, /running\.\.\./);
    assert.match(expanded, /auth/);
  });

  it("returns the worker's truncated final output as visible content and exposes runner metadata in details", async () => {
    const { createFinderTool } = await importSource(FINDER_MODULE);
    const workerResult = makeWorkerResult({
      truncatedFinalOutput: "found it\n\n[a.ts#L1-L10](file:///abs/a.ts#L1-L10)",
      finalOutput: "found it\n\n[a.ts#L1-L10](file:///abs/a.ts#L1-L10)",
      args: ["--mode", "json", "-p", "--no-session", "--tools", "grep,find,read"],
      stderr: "  warning: noisy line\n",
      exitCode: 0,
    });
    const { runWorker } = makeRunnerSpy(workerResult);
    const tool = createFinderTool({ runWorker });
    const result = await tool.execute("c", { query: "find auth" }, undefined, undefined, { cwd: "/tmp" });
    assert.equal(result.content[0].type, "text");
    assert.match(result.content[0].text, /found it/);
    assert.equal(result.details.exitCode, 0);
    assert.equal(result.details.stderr, "  warning: noisy line\n");
    assert.deepEqual(result.details.args, workerResult.args);
    assert.equal(typeof result.details.usage.turns, "number");
    assert.equal(result.details.worker, "mmr-subagents.finder");
  });

  it("renders a successful finder run as completed (warning, not failed) when a non-fatal provider error was preserved", async () => {
    const { createFinderTool } = await importSource(FINDER_MODULE);
    const workerResult = makeWorkerResult({
      truncatedFinalOutput: "verified settings with file:line evidence",
      finalOutput: "verified settings with file:line evidence",
      exitCode: 0,
      stopReason: "end_turn",
      errorMessage: "Antigravity request failed with HTTP 429: capacity exhausted. Resets in 0s.",
    });
    const { runWorker } = makeRunnerSpy(workerResult);
    const tool = createFinderTool({ runWorker });
    const result = await tool.execute("c", { query: "verify settings" }, undefined, undefined, { cwd: "/tmp" });
    assert.equal(result.details.status, "success");
    assert.equal(result.details.errorMessage, workerResult.errorMessage);
    assert.match(result.content[0].text, /verified settings/);

    const fakeTheme = {
      fg(color, text) { return `[${color}]${text}`; },
      bg(_color, text) { return text; },
      bold(text) { return text; },
    };
    const rendered = tool.renderResult(
      result,
      { expanded: false, isPartial: false },
      fakeTheme,
      { args: { query: "verify settings" }, showImages: false, isError: false },
    ).render(200).join("\n");
    assert.match(rendered, /completed/i);
    assert.doesNotMatch(rendered, /\[error\]/);
    assert.match(rendered, /\[warning\]Antigravity request failed with HTTP 429/);
  });

  it("sanitizes finder trail assistant links so expanded rows do not re-render raw file URLs", async () => {
    const { createFinderTool } = await importSource(FINDER_MODULE);
    const cwd = makeTempDir();
    const outside = makeTempDir();
    try {
      const outsideFile = path.join(outside, "secret.ts");
      writeFileSync(outsideFile, "secret\n");
      const rawLink = `Found [secret.ts#L1-L2](${pathToFileUri(outsideFile)}#L1-L2)`;
      const workerResult = makeWorkerResult({
        truncatedFinalOutput: rawLink,
        finalOutput: rawLink,
        trail: [
          { type: "assistant", text: rawLink },
        ],
      });
      const { runWorker } = makeRunnerSpy(workerResult);
      const tool = createFinderTool({ runWorker });
      const result = await tool.execute("c", { query: "find secret" }, undefined, undefined, { cwd });
      const fakeTheme = {
        fg(_color, text) { return text; },
        bold(text) { return text; },
      };
      const rendered = tool.renderResult(
        result,
        { expanded: true, isPartial: false },
        fakeTheme,
        { args: { query: "find secret" }, showImages: false, isError: false, cwd },
      ).render(200).join("\n");

      assert.doesNotMatch(result.content[0].text, /file:\/\//);
      assert.doesNotMatch(rendered, /file:\/\//);
      assert.equal((rendered.match(/secret\.ts#L1-L2/g) ?? []).length, 1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("sanitizes impossible line ranges in visible worker output", async () => {
    const { createFinderTool } = await importSource(FINDER_MODULE);
    const cwd = makeTempDir();
    try {
      const file = path.join(cwd, "finder.ts");
      writeFileSync(file, Array.from({ length: 464 }, (_, i) => `line ${i + 1}`).join("\n"));
      const workerResult = makeWorkerResult({
        truncatedFinalOutput: `Bad link [finder.ts#L544-L553](${pathToFileUri(file)}#L544-L553)`,
        finalOutput: `Bad link [finder.ts#L544-L553](${pathToFileUri(file)}#L544-L553)`,
      });
      const { runWorker } = makeRunnerSpy(workerResult);
      const tool = createFinderTool({ runWorker });
      const result = await tool.execute("c", { query: "find" }, undefined, undefined, { cwd });
      assert.equal(result.content[0].text, `Bad link [finder.ts](${pathToFileUri(file)})`);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("returns a graceful aborted message when the worker is cancelled before producing output", async () => {
    const { createFinderTool } = await importSource(FINDER_MODULE);
    const aborted = makeWorkerResult({
      finalOutput: "",
      truncatedFinalOutput: "",
      aborted: true,
      exitCode: null,
      signal: "SIGTERM",
    });
    const { runWorker } = makeRunnerSpy(aborted);
    const tool = createFinderTool({ runWorker });
    const result = await tool.execute("c", { query: "x" }, undefined, undefined, { cwd: "/tmp" });
    assert.match(result.content[0].text, /cancel|abort/i);
    assert.equal(result.details.aborted, true);
  });

  it("forwards runnerDeps to the underlying runner so callers can inject spawn/resolveInvocation", async () => {
    const { createFinderTool } = await importSource(FINDER_MODULE);
    let observedDeps;
    const runWorker = async (_options, deps) => {
      observedDeps = deps;
      return makeWorkerResult();
    };
    const stubResolve = (args) => ({ command: "/fake/pi", args });
    const tool = createFinderTool({ runWorker, runnerDeps: { resolveInvocation: stubResolve } });
    await tool.execute("c", { query: "find" }, undefined, undefined, { cwd: "/tmp" });
    assert.ok(observedDeps, "runner deps must be forwarded");
    assert.equal(observedDeps.resolveInvocation, stubResolve);
  });

  it("surfaces nonzero exit code with stderr tail when the worker fails to produce output", async () => {
    const { createFinderTool } = await importSource(FINDER_MODULE);
    const failed = makeWorkerResult({
      finalOutput: "",
      truncatedFinalOutput: "",
      exitCode: 7,
      stderr: "line1\nline2\nfatal: boom\n",
    });
    const { runWorker } = makeRunnerSpy(failed);
    const tool = createFinderTool({ runWorker });
    const result = await tool.execute("c", { query: "x" }, undefined, undefined, { cwd: "/tmp" });
    assert.match(result.content[0].text, /exit/i);
    assert.match(result.content[0].text, /fatal: boom/);
    assert.equal(result.details.exitCode, 7);
  });

  it("surfaces spawn-error errorMessage as visible content when stderr is empty", async () => {
    // Spawn failures (e.g. `spawn ENOENT` when `pi` is missing on PATH)
    // produce exitCode=1 with no stderr; the runner mirrors the error
    // into errorMessage. Visible content must surface the reason instead
    // of just "worker exited with code 1" so callers can diagnose it
    // without inspecting details.
    const { createFinderTool } = await importSource(FINDER_MODULE);
    const failed = makeWorkerResult({
      finalOutput: "",
      truncatedFinalOutput: "",
      exitCode: 1,
      stderr: "",
      errorMessage: "spawn ENOENT",
    });
    const { runWorker } = makeRunnerSpy(failed);
    const tool = createFinderTool({ runWorker });
    const result = await tool.execute("c", { query: "x" }, undefined, undefined, { cwd: "/tmp" });
    assert.match(result.content[0].text, /exit/i);
    assert.match(result.content[0].text, /spawn ENOENT/);
  });

  it("surfaces nonzero exit even when the worker produced partial output", async () => {
    // A worker that emits some output and then exits nonzero must not
    // visually look like success: failure-state precedence puts the
    // exit-code failure before normal output.
    const { createFinderTool } = await importSource(FINDER_MODULE);
    const failed = makeWorkerResult({
      finalOutput: "partial finding\n",
      truncatedFinalOutput: "partial finding\n",
      exitCode: 7,
      stderr: "fatal: boom\n",
    });
    const { runWorker } = makeRunnerSpy(failed);
    const tool = createFinderTool({ runWorker });
    const result = await tool.execute("c", { query: "x" }, undefined, undefined, { cwd: "/tmp" });
    assert.match(result.content[0].text, /exit/i);
    assert.match(result.content[0].text, /fatal: boom/);
    assert.doesNotMatch(result.content[0].text, /partial finding/);
    assert.equal(result.details.exitCode, 7);
  });

  it("surfaces a no-agent-start diagnostic when the child exits before agent_start (sibling-extension input hook swallowed the prompt)", async () => {
    // Specific regression guard: when a sibling extension's `input` event
    // handler returns { action: "handled" } in non-interactive mode, the
    // child Pi process exits 0 with no usable output AND agent_start
    // never fires. The cheerful "no relevant evidence found" message
    // misled operators into rewording their query when the real cause is
    // upstream. The new `no-agent-start` outcome surfaces an actionable
    // hint instead, and includes the stderr tail so the blocking
    // extension's diagnostic is visible.
    const { createFinderTool } = await importSource(FINDER_MODULE);
    const blocked = makeWorkerResult({
      finalOutput: "",
      truncatedFinalOutput: "",
      exitCode: 0,
      stderr: "some-other-extension: blocked the prompt to prevent accidental billing.",
      errorMessage: undefined,
      agentStarted: false,
    });
    const { runWorker } = makeRunnerSpy(blocked);
    const tool = createFinderTool({ runWorker });
    const result = await tool.execute("c", { query: "x" }, undefined, undefined, { cwd: "/tmp" });
    assert.match(result.content[0].text, /exited before the agent loop started/);
    assert.match(result.content[0].text, /another Pi extension's input handler/);
    assert.match(result.content[0].text, /some-other-extension: blocked the prompt/);
    assert.doesNotMatch(result.content[0].text, /no relevant evidence/i);
  });

  it("surfaces errorMessage when the worker exits 0 with no output", async () => {
    // A worker may report an error via the JSON stream and still exit 0
    // without producing final output. The empty-success fallback must
    // not mask that error; visible content should surface it.
    const { createFinderTool } = await importSource(FINDER_MODULE);
    const failed = makeWorkerResult({
      finalOutput: "",
      truncatedFinalOutput: "",
      exitCode: 0,
      stderr: "",
      errorMessage: "upstream provider rate-limited",
    });
    const { runWorker } = makeRunnerSpy(failed);
    const tool = createFinderTool({ runWorker });
    const result = await tool.execute("c", { query: "x" }, undefined, undefined, { cwd: "/tmp" });
    assert.match(result.content[0].text, /upstream provider rate-limited/);
    assert.doesNotMatch(result.content[0].text, /no relevant evidence/i);
  });

  it("surfaces subagent activation failure as a clear error result instead of an empty success", async () => {
    // Pi currently exits 0 even when an extension's session_start throws.
    // The runner detects the `pi-mmr: subagent activation failed: ...`
    // marker on stderr and surfaces it via
    // MmrWorkerResult.subagentActivationError. Finder MUST translate
    // that into a user-visible error message AND expose the activation
    // reason on FinderDetails so callers/operators see the cause
    // without grepping stderr by hand.
    const { createFinderTool } = await importSource(FINDER_MODULE);
    const failed = makeWorkerResult({
      finalOutput: "",
      truncatedFinalOutput: "",
      exitCode: 0,
      stderr:
        'pi-mmr: subagent activation failed: Unknown subagent profile "no-such-profile". Known profiles: finder.\n',
      subagentActivationError:
        'Unknown subagent profile "no-such-profile". Known profiles: finder.',
      errorMessage:
        'subagent activation failed: Unknown subagent profile "no-such-profile". Known profiles: finder.',
    });
    const { runWorker } = makeRunnerSpy(failed);
    const tool = createFinderTool({ runWorker });
    const result = await tool.execute("c", { query: "x" }, undefined, undefined, { cwd: "/tmp" });
    assert.match(
      result.content[0].text,
      /subagent activation failed/i,
      "visible content must surface the activation failure, not pretend success",
    );
    assert.match(result.content[0].text, /no-such-profile/);
    assert.equal(
      result.details.subagentActivationError,
      'Unknown subagent profile "no-such-profile". Known profiles: finder.',
      "FinderDetails must expose the structured activation error so callers can branch on it",
    );
    assert.match(
      result.details.errorMessage ?? "",
      /subagent activation failed/i,
    );
  });

  it("reads settings-driven subagentModelPreferences.finder on every execute so /mmr-config writes take effect on the next call", async () => {
    // Behavioral pin: parent finder and child Pi process must agree on
    // the resolved model. The child path already reads
    // loadMmrCoreSettings on every activation; the parent must do the
    // same so a /mmr-config override that names a model not in the
    // default preference list cannot fail with model.mismatch.
    const { createFinderTool, FINDER_SUBAGENT_PROFILE } =
      await importSource(FINDER_MODULE);
    const captured = [];
    let loadCalls = 0;
    const { runWorker, calls } = makeRunnerSpy();
    const tool = createFinderTool({
      runWorker,
      // Inject a deterministic settings loader so the test doesn't touch
      // the filesystem; production default delegates to
      // loadMmrCoreSettings(cwd).settings.
      loadSubagentModelPreferences: (cwd) => {
        loadCalls += 1;
        captured.push(cwd);
        return {
          subagentModelPreferences: {
            [FINDER_SUBAGENT_PROFILE]: [
              { model: "gemini-3.5-flash", thinkingLevel: "minimal" },
            ],
          },
        };
      },
    });
    await tool.execute(
      "c1",
      { query: "x" },
      undefined,
      undefined,
      {
        cwd: "/tmp/repo",
        // Registry includes the settings override (google/gemini-3.5-flash)
        // so the resolver picks it over the profile default.
        modelRegistry: makeRegistry([
          { provider: "openai-codex", id: "gpt-5.4-mini" },
          { provider: "google", id: "gemini-3.5-flash" },
        ]),
      },
    );
    assert.equal(loadCalls, 1, "finder must read settings exactly once per execute");
    assert.equal(captured[0], "/tmp/repo", "settings loader must be called with ctx.cwd");
    assert.equal(
      calls[0].model,
      "google/gemini-3.5-flash",
      "runner must receive the settings-driven model, not the profile default",
    );
  });

  it("propagates structured runner spawnError into FinderDetails.spawnError", async () => {
    // The shared progress renderer prefers details.spawnError over
    // raw errorMessage when classifying the worker outcome; finder must
    // copy the structured discriminator out of MmrWorkerResult so the
    // renderer (and downstream callers) see it on details.
    const { createFinderTool } = await importSource(FINDER_MODULE);
    const failed = makeWorkerResult({
      finalOutput: "",
      truncatedFinalOutput: "",
      exitCode: 1,
      stderr: "",
      errorMessage: "spawn ENOENT",
      spawnError: "spawn ENOENT",
    });
    const { runWorker } = makeRunnerSpy(failed);
    const tool = createFinderTool({ runWorker });
    const result = await tool.execute("c", { query: "x" }, undefined, undefined, { cwd: "/tmp" });
    assert.equal(result.details.spawnError, "spawn ENOENT");
  });
});

describe("finder parent↔child route agreement", () => {
  // Proves the production unification (issue-#1 "Option A"): the parent
  // finder tool and the child Pi process both resolve the worker route
  // through the SAME `selectMmrModelRoute` resolver, so they can never
  // disagree on the `--model`. The parent route string the tool would pass
  // must equal the child's `resolveMmrSubagentInvocation(...).modelArg`,
  // and passing that route back as an explicit `--model` must not trip the
  // child's model.mismatch guard.
  it("parent route equals the child's resolved modelArg for the finder profile", async () => {
    const { selectMmrModelRoute } = await importSource(MODEL_RESOLVER_MODULE);
    const { resolveMmrSubagentInvocation } = await importSource(SUBAGENT_RESOLVER_MODULE);
    const { getMmrSubagentProfile } = await importSource(PROFILES_MODULE);
    const profile = getMmrSubagentProfile("finder");
    // Registry includes the profile's provider-pinned primary plus both
    // fallbacks so the resolver has a real route to pick.
    const registry = makeRegistry([
      { provider: "antigravity", id: "gemini-3.5-flash-extra-low" },
      { provider: "openai-codex", id: "gpt-5.4-mini" },
      { provider: "claude-subscription", id: "claude-haiku-4-5" },
    ]);

    // Parent route: exactly what finder.execute() forms as --model.
    const parentSelected = selectMmrModelRoute({
      modelPreferences: profile.modelPreferences,
      modeThinkingLevel: profile.thinkingLevel,
      registry,
    }).selected;
    assert.ok(parentSelected, "parent must resolve a route");
    const parentModelArg = `${parentSelected.provider}/${parentSelected.model}`;

    // Child resolution: same profile + registry through the per-invocation resolver.
    const child = resolveMmrSubagentInvocation({
      profile,
      registry,
      registeredTools: [...profile.tools],
    });
    assert.equal(child.ok, true, "child resolution must succeed");
    assert.equal(child.modelArg, parentModelArg, "parent and child must resolve the same route");

    // When the parent passes that --model explicitly, child resolution must not mismatch.
    const childWithExplicit = resolveMmrSubagentInvocation({
      profile,
      registry,
      registeredTools: [...profile.tools],
      explicitModel: parentModelArg,
    });
    assert.equal(childWithExplicit.ok, true, "explicit parent --model must agree with the child route");
    assert.equal(childWithExplicit.modelArg, parentModelArg);
  });
});
