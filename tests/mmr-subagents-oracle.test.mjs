// Unit tests for the `mmr-subagents` oracle tool.
//
// Behavior pinned here (matches the finder slice's shape; subprocess
// runner and provider wiring are tested elsewhere):
//
//   1. Tool definition advertises name, description, prompt snippet,
//      flat prompt guidelines, and a `{ task, context?, files? }` schema.
//   2. Description carries the full WHEN/WHEN-NOT/usage/examples surface.
//   3. Every promptGuideline literally names `oracle` (Pi flat-guideline
//      requirement).
//   4. Worker tool allowlist matches the mmr-core oracle profile (7
//      tools, including those owned by sibling extensions whose
//      shipping state is independent).
//   5. Model selector prefers GPT-5.5, falls back to Claude Opus 4.6,
//      returns undefined when neither is registered.
//   6. execute() rejects missing/blank task before spawning a worker.
//   7. execute() calls the injected runner with profileName="oracle",
//      cwd, worker tools, oracle-specific system prompt, signal, and
//      selected model. The user prompt carries the task, optional
//      context, and inlined text-file contents.
//   8. execute() resolves `files[]` against cwd, reads text files into
//      the prompt, mentions images by path, and skips files outside
//      cwd or unreadable with a clear note (no silent drops).
//   9. execute() forwards progress as `{ content: [{ type: "text" }] }`.
//  10. execute() returns the worker's truncated final output as visible
//      content and exposes runner metadata in details.
//  11. execute() degrades gracefully on abort, nonzero exit, or
//      subagent activation failure (no empty-success path).
//
// Tests load `oracle.ts` lazily through importSource so the file does
// not need to exist for the suite to compile.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const ORACLE_MODULE = "extensions/mmr-workers/oracle.ts";
const PROMPTS_MODULE = "extensions/mmr-workers/prompts.ts";
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
    finalOutput: "TL;DR: rework auth.\n\nRecommended approach (simple path): ...",
    truncatedFinalOutput: "TL;DR: rework auth.\n\nRecommended approach (simple path): ...",
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
    model: "gpt-5.5",
    stopReason: "end_turn",
    errorMessage: undefined,
    prompt: "Task: review auth",
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
// `getAvailable()` the advisor context-window lookup reads. `models` entries
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
  return mkdtempSync(path.join(os.tmpdir(), "pi-mmr-oracle-test-"));
}

describe("oracle tool definition", () => {
  it("declares the expected name, snippet, description, and schema fields", async () => {
    const { createOracleTool, ORACLE_TOOL_NAME, ORACLE_PROMPT_SNIPPET, ORACLE_DESCRIPTION } =
      await importSource(ORACLE_MODULE);
    assert.equal(ORACLE_TOOL_NAME, "oracle");
    const tool = createOracleTool();
    assert.equal(tool.name, "oracle");
    assert.equal(tool.promptSnippet, ORACLE_PROMPT_SNIPPET);
    assert.equal(tool.description, ORACLE_DESCRIPTION);
    assert.ok(typeof tool.description === "string" && tool.description.length > 0);
    const params = tool.parameters;
    assert.equal(params.type, "object");
    assert.deepEqual(params.required, ["task"]);
    assert.equal(params.additionalProperties, false);
    assert.equal(params.properties.task.type, "string");
    assert.equal(typeof params.properties.task.description, "string");
    assert.equal(params.properties.context.type, "string");
    assert.equal(typeof params.properties.context.description, "string");
    assert.equal(params.properties.files.type, "array");
    assert.equal(params.properties.files.items.type, "string");
    assert.equal(typeof params.properties.files.description, "string");
  });

  it("description carries the full WHEN/WHEN-NOT/usage/examples surface", async () => {
    const { createOracleTool } = await importSource(ORACLE_MODULE);
    const tool = createOracleTool();
    assert.match(tool.description, /Consult the oracle/);
    assert.match(tool.description, /AI advisor/);
    assert.match(tool.description, /GPT-5\.5 reasoning model/);
    assert.match(tool.description, /The oracle has access to the following tools:/);
    assert.match(tool.description, /^- read$/m);
    assert.match(tool.description, /^- grep$/m);
    assert.match(tool.description, /^- find$/m);
    assert.match(tool.description, /^- web_search$/m);
    assert.match(tool.description, /^- read_web_page$/m);
    assert.match(tool.description, /^- read_session$/m);
    assert.match(tool.description, /^- find_session$/m);
    assert.match(tool.description, /You should consult the oracle for:/);
    assert.match(tool.description, /Code reviews and architecture feedback/);
    assert.match(tool.description, /Finding difficult bugs in codepaths that flow across many files/);
    assert.match(tool.description, /Planning complex implementations or refactors/);
    assert.match(tool.description, /Answering complex technical questions that require deep technical reasoning/);
    assert.match(tool.description, /Providing an alternative point of view when you are struggling to solve a problem/);
    assert.match(tool.description, /You should NOT consult the oracle for:/);
    assert.match(tool.description, /use read or grep directly/);
    assert.match(tool.description, /Codebase searches \(use finder\)/);
    assert.match(tool.description, /use read_web_page or web_search/);
    assert.match(tool.description, /do it yourself or use Task/);
    assert.match(tool.description, /Usage guidelines:/);
    assert.match(tool.description, /Be specific about what you want the oracle to review, plan, or debug/);
    assert.match(tool.description, /list them and they will be attached/);
    // Worked examples, each with a JSON args block.
    assert.match(tool.description, /Review the authentication system architecture/);
    assert.match(tool.description, /"task":"Review the authentication architecture and suggest improvements"/);
    assert.match(tool.description, /Plan the implementation of real-time collaboration features/);
    assert.match(tool.description, /Analyze the performance bottlenecks/);
    assert.match(tool.description, /"context":"Users report slow response times/);
    assert.match(tool.description, /Review this API design/);
    assert.match(tool.description, /Debug failing tests after refactor/);

    const params = tool.parameters;
    assert.match(params.properties.task.description, /task or question you want the oracle to help with/i);
    assert.match(params.properties.context.description, /Optional context about the current situation/i);
    assert.match(params.properties.files.description, /Optional list of specific file paths/i);
    assert.match(params.properties.files.description, /will be attached to the oracle input/i);
  });

  it("every prompt guideline names the tool so Pi's flat guidelines stay unambiguous", async () => {
    const { ORACLE_PROMPT_GUIDELINES, createOracleTool } = await importSource(ORACLE_MODULE);
    assert.ok(Array.isArray(ORACLE_PROMPT_GUIDELINES) && ORACLE_PROMPT_GUIDELINES.length > 0);
    for (const guideline of ORACLE_PROMPT_GUIDELINES) {
      assert.match(
        guideline,
        /\boracle\b/i,
        `every guideline must name oracle; offender: "${guideline}"`,
      );
    }
    const tool = createOracleTool();
    assert.deepEqual([...tool.promptGuidelines], [...ORACLE_PROMPT_GUIDELINES]);
  });

  it("keeps guidelines to routing lines and surfaces worked JSON examples only in the description", async () => {
    const { ORACLE_DESCRIPTION, ORACLE_PROMPT_GUIDELINES } = await importSource(ORACLE_MODULE);
    // Guidelines carry routing only: when to consult, plus the `files`
    // formatting rule (the dominant oracle call error). Worked examples and
    // the full WHEN/WHEN-NOT surface live only in the schema description.
    assert.equal(ORACLE_PROMPT_GUIDELINES.length, 2);
    assert.match(ORACLE_PROMPT_GUIDELINES[0], /architecture-level guidance/);
    assert.match(ORACLE_PROMPT_GUIDELINES[0], /advisory/);
    assert.match(ORACLE_PROMPT_GUIDELINES[1], /JSON array of strings/);
    for (const guideline of ORACLE_PROMPT_GUIDELINES) {
      assert.doesNotMatch(guideline, /Example oracle call/);
    }
    // The worked examples cover five scenarios: architecture review (files),
    // planning (no files), performance analysis (context only), API design
    // review (context + files), and debugging a failing test (context +
    // files). Each must embed a parseable JSON object with a `task` field so
    // the model gets a literal, copyable call shape.
    const expectedTaskPhrases = [
      "Review the authentication architecture and suggest improvements",
      "Plan the implementation of real-time collaboration feature",
      "Analyze performance bottlenecks",
      "Review API design",
      "Help debug why tests are failing",
    ];
    const exampleLines = ORACLE_DESCRIPTION.split("\n").filter((line) => line.startsWith("{"));
    assert.equal(
      exampleLines.length,
      expectedTaskPhrases.length,
      `expected ${expectedTaskPhrases.length} worked-example JSON lines in the description, found ${exampleLines.length}`,
    );
    for (const phrase of expectedTaskPhrases) {
      assert.ok(
        exampleLines.some((line) => line.includes(phrase)),
        `expected a worked-example JSON line containing task phrase: "${phrase}"`,
      );
    }
    for (const line of exampleLines) {
      const parsed = JSON.parse(line);
      assert.equal(typeof parsed.task, "string", `worked example must have a string task: "${line}"`);
      assert.ok(parsed.task.length > 0, `worked example task must be non-empty: "${line}"`);
      if (parsed.files !== undefined) {
        assert.ok(Array.isArray(parsed.files), `worked example files must be an array: "${line}"`);
        for (const entry of parsed.files) {
          assert.equal(typeof entry, "string", `worked example files entry must be a string: "${line}"`);
        }
      }
      if (parsed.context !== undefined) {
        assert.equal(typeof parsed.context, "string", `worked example context must be a string: "${line}"`);
      }
    }
  });

  it("worker tool allowlist matches the mmr-core oracle profile", async () => {
    const { ORACLE_WORKER_TOOLS } = await importSource(ORACLE_MODULE);
    assert.deepEqual(
      [...ORACLE_WORKER_TOOLS],
      ["read", "grep", "find", "web_search", "read_web_page", "read_session", "find_session"],
    );
    // Mutation/write tools must never appear in the oracle allowlist.
    for (const forbidden of ["bash", "edit", "write", "apply_patch"]) {
      assert.equal(ORACLE_WORKER_TOOLS.includes(forbidden), false, `${forbidden} must not be in the oracle worker allowlist`);
    }
  });
});

describe("oracle worker system prompt", () => {
  it("re-exports the canonical builder for backward-compatible callers", async () => {
    const { buildOracleWorkerSystemPrompt } = await importSource(ORACLE_MODULE);
    const prompt = buildOracleWorkerSystemPrompt("/abs/repo");
    assert.match(prompt, /You are the Oracle/);
    assert.match(prompt, /Working directory: \/abs\/repo/);
    assert.match(prompt, /Workspace root: \/abs\/repo/);
    assert.match(prompt, /TL;DR/);
    assert.match(prompt, /IMPORTANT: Only your last message is returned/);
  });
});

describe("ORACLE_DEFAULT_MODEL_PREFERENCES", () => {
  it("lists GPT-5.5 first and Claude Opus 4.6 as the fallback", async () => {
    const { ORACLE_DEFAULT_MODEL_PREFERENCES } = await importSource(ORACLE_MODULE);
    const prefs = [...ORACLE_DEFAULT_MODEL_PREFERENCES];
    const firstGpt = prefs.findIndex((entry) => /(^|\/)gpt-5\.5$/.test(entry));
    const firstOpus = prefs.findIndex((entry) => /(^|\/)claude-opus-4-6$/.test(entry));
    assert.notEqual(firstGpt, -1, "expected a GPT-5.5 preference");
    assert.notEqual(firstOpus, -1, "expected a Claude Opus 4.6 preference");
    assert.ok(firstGpt < firstOpus, "GPT-5.5 must precede Claude Opus 4.6");
  });
});

describe("ORACLE_TOOL_CONFIG", () => {
  it("does not carry the removed defaultModelPreferences field", async () => {
    const { ORACLE_TOOL_CONFIG } = await importSource(ORACLE_MODULE);
    assert.ok(
      !("defaultModelPreferences" in ORACLE_TOOL_CONFIG),
      "ORACLE_TOOL_CONFIG must not reintroduce the inert defaultModelPreferences field; model preferences resolve solely through the oracle subagent profile.",
    );
  });
});

describe("oracle execute() seam", () => {
  it("rejects missing or blank task before spawning a worker", async () => {
    const { createOracleTool } = await importSource(ORACLE_MODULE);
    const { runWorker, calls } = makeRunnerSpy();
    const tool = createOracleTool({ runWorker });
    await assert.rejects(tool.execute("c1", undefined, undefined, undefined, { cwd: "/tmp" }), /task/i);
    await assert.rejects(tool.execute("c2", { task: "" }, undefined, undefined, { cwd: "/tmp" }), /task/i);
    await assert.rejects(tool.execute("c3", { task: "   " }, undefined, undefined, { cwd: "/tmp" }), /task/i);
    assert.equal(calls.length, 0);
  });

  it("rejects non-string context and non-array files at the schema boundary", async () => {
    const { createOracleTool } = await importSource(ORACLE_MODULE);
    const { runWorker, calls } = makeRunnerSpy();
    const tool = createOracleTool({ runWorker });
    await assert.rejects(
      tool.execute("c1", { task: "ok", context: 42 }, undefined, undefined, { cwd: "/tmp" }),
      /context/i,
    );
    await assert.rejects(
      tool.execute("c2", { task: "ok", files: "not-an-array" }, undefined, undefined, { cwd: "/tmp" }),
      /files/i,
    );
    await assert.rejects(
      tool.execute("c3", { task: "ok", files: [123] }, undefined, undefined, { cwd: "/tmp" }),
      /files/i,
    );
    assert.equal(calls.length, 0);
  });

  it("calls the runner with profileName='oracle', cwd, tools, system prompt, signal, model", async () => {
    const { createOracleTool, ORACLE_WORKER_TOOLS } = await importSource(ORACLE_MODULE);
    const { runWorker, calls } = makeRunnerSpy();
    const controller = new AbortController();
    const tool = createOracleTool({
      runWorker,
      buildSystemPrompt: (cwd) => `SP for ${cwd}`,
    });
    const result = await tool.execute(
      "call-1",
      { task: "Review the auth module." },
      controller.signal,
      undefined,
      { cwd: "/abs/project", modelRegistry: makeRegistry([{ provider: "openai-codex", id: "gpt-5.5" }]) },
    );
    assert.equal(calls.length, 1);
    const options = calls[0];
    assert.equal(options.profileName, "oracle");
    assert.equal(options.cwd, "/abs/project");
    // Parent must not pass explicit --tools: the child Pi process
    // resolves its own worker tool set via resolveMmrSubagentInvocation
    // against its registered-tool inventory. Passing the raw profile
    // tools (including optional web/history tools) would fail the
    // child's tools.mismatch check whenever those tools are unloaded
    // in the child environment. workerTools still appears in
    // result.details for observability.
    assert.equal(options.tools, undefined);
    assert.equal(options.systemPrompt, "SP for /abs/project");
    // Every run registers in the async-task registry, which owns the worker
    // AbortController; the runner receives the registry signal (adapted from
    // the tool-call signal), never the tool-call signal itself.
    assert.ok(options.signal instanceof AbortSignal, "runner must receive the registry-owned task signal");
    assert.notEqual(options.signal, controller.signal);
    assert.equal(options.signal.aborted, false);
    assert.equal(options.model, "openai-codex/gpt-5.5");
    assert.match(options.prompt, /Task: Review the auth module\./);
    assert.equal(typeof options.outputByteLimit, "number");
    assert.equal(result.details.model, "openai-codex/gpt-5.5");
    assert.equal(result.details.cwd, "/abs/project");
    assert.deepEqual([...result.details.workerTools], [...ORACLE_WORKER_TOOLS]);
  });

  it("routes runtime prompt assembly through assembleMmrSubagentSurface", async () => {
    const { createOracleTool } = await importSource(ORACLE_MODULE);
    const {
      clearMmrSubagentPromptBuilders,
      registerMmrSubagentPromptBuilder,
    } = await importSource(PROMPT_ASSEMBLY_MODULE);
    const { runWorker, calls } = makeRunnerSpy();
    let spyCalls = 0;
    clearMmrSubagentPromptBuilders();
    registerMmrSubagentPromptBuilder("oracle", ({ cwd, profile }) => {
      spyCalls += 1;
      assert.equal(profile.name, "oracle");
      return `oracle surface spy ${cwd}`;
    });
    const tool = createOracleTool({ runWorker });
    await tool.execute("c", { task: "Review" }, undefined, undefined, { cwd: "/tmp/oracle-surface" });
    assert.equal(spyCalls, 1, "execute must call the registered oracle prompt builder via the surface API");
    assert.equal(calls[0].systemPrompt, "oracle surface spy /tmp/oracle-surface");
  });

  it("fails closed when the oracle prompt builder is not registered", async () => {
    const { createOracleTool } = await importSource(ORACLE_MODULE);
    const { clearMmrSubagentPromptBuilders } = await importSource(PROMPT_ASSEMBLY_MODULE);
    const { runWorker, calls } = makeRunnerSpy();
    clearMmrSubagentPromptBuilders();
    const tool = createOracleTool({ runWorker });
    await assert.rejects(
      tool.execute("c", { task: "Review" }, undefined, undefined, { cwd: "/tmp" }),
      /no subagent prompt builder registered.*oracle/i,
    );
    assert.equal(calls.length, 0, "runner must not start without the registered oracle prompt builder");
  });

  it("includes optional context block in the user prompt", async () => {
    const { createOracleTool } = await importSource(ORACLE_MODULE);
    const { runWorker, calls } = makeRunnerSpy();
    const tool = createOracleTool({ runWorker });
    await tool.execute("c", { task: "Plan caching strategy", context: "Hot read path; ~1M qps; mostly cacheable." }, undefined, undefined, { cwd: "/tmp" });
    assert.equal(calls.length, 1);
    assert.match(calls[0].prompt, /Task: Plan caching strategy/);
    assert.match(calls[0].prompt, /Context:/);
    assert.match(calls[0].prompt, /Hot read path; ~1M qps; mostly cacheable\./);
  });

  it("inlines text-file contents from `files[]` into the user prompt", async () => {
    const { createOracleTool } = await importSource(ORACLE_MODULE);
    const { runWorker, calls } = makeRunnerSpy();
    const cwd = makeTempDir();
    try {
      const fileA = path.join(cwd, "src", "auth.ts");
      mkdirSync(path.dirname(fileA), { recursive: true });
      writeFileSync(fileA, "export function login() { return true; }\n");
      const fileB = path.join(cwd, "README.md");
      writeFileSync(fileB, "# Project\n\nDocs.\n");
      const tool = createOracleTool({ runWorker });
      await tool.execute("c", { task: "Review auth", files: ["src/auth.ts", "README.md"] }, undefined, undefined, { cwd });
      assert.equal(calls.length, 1);
      const prompt = calls[0].prompt;
      assert.match(prompt, /### File: src\/auth\.ts/);
      assert.match(prompt, /export function login\(\) \{ return true; \}/);
      assert.match(prompt, /### File: README\.md/);
      assert.match(prompt, /# Project/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("mentions image files by path without embedding binary", async () => {
    const { createOracleTool } = await importSource(ORACLE_MODULE);
    const { runWorker, calls } = makeRunnerSpy();
    const cwd = makeTempDir();
    try {
      const img = path.join(cwd, "screenshot.png");
      writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      const tool = createOracleTool({ runWorker });
      await tool.execute("c", { task: "What does this UI show?", files: ["screenshot.png"] }, undefined, undefined, { cwd });
      const prompt = calls[0].prompt;
      assert.match(prompt, /### Image: screenshot\.png/);
      assert.doesNotMatch(prompt, /\x89PNG/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("skips files outside cwd with a clear note instead of attaching them", async () => {
    const { createOracleTool } = await importSource(ORACLE_MODULE);
    const { runWorker, calls } = makeRunnerSpy();
    const cwd = makeTempDir();
    const outside = makeTempDir();
    try {
      const evil = path.join(outside, "evil.ts");
      writeFileSync(evil, "leak\n");
      const tool = createOracleTool({ runWorker });
      await tool.execute("c", { task: "go", files: [evil] }, undefined, undefined, { cwd });
      const prompt = calls[0].prompt;
      assert.match(prompt, /outside the working directory|not attached/i);
      assert.doesNotMatch(prompt, /leak/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("notes unreadable files instead of failing the call", async () => {
    const { createOracleTool } = await importSource(ORACLE_MODULE);
    const { runWorker, calls } = makeRunnerSpy();
    const cwd = makeTempDir();
    try {
      const tool = createOracleTool({ runWorker });
      await tool.execute("c", { task: "go", files: ["does-not-exist.ts"] }, undefined, undefined, { cwd });
      assert.equal(calls.length, 1);
      const prompt = calls[0].prompt;
      assert.match(prompt, /does-not-exist\.ts/);
      assert.match(prompt, /could not be attached|not attached/i);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("truncates oversized text-file attachments and records the original size", async () => {
    const { createOracleTool } = await importSource(ORACLE_MODULE);
    const { runWorker, calls } = makeRunnerSpy();
    const cwd = makeTempDir();
    try {
      const big = path.join(cwd, "big.txt");
      // 200 KiB of "a" — well above any reasonable per-file cap.
      writeFileSync(big, "a".repeat(200 * 1024));
      const tool = createOracleTool({ runWorker, perFileByteLimit: 1024 });
      await tool.execute("c", { task: "review", files: ["big.txt"] }, undefined, undefined, { cwd });
      const prompt = calls[0].prompt;
      assert.match(prompt, /### File: big\.txt/);
      assert.match(prompt, /truncated/i);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("omits --model when no preferred worker model is available", async () => {
    const { createOracleTool } = await importSource(ORACLE_MODULE);
    const { runWorker, calls } = makeRunnerSpy();
    const tool = createOracleTool({ runWorker });
    await tool.execute("c", { task: "review" }, undefined, undefined, {
      cwd: "/tmp",
      modelRegistry: makeRegistry([{ provider: "openai", id: "gpt-5.4" }]),
    });
    assert.equal("model" in calls[0], false);
  });

  it("resolves the worker route from ctx.modelRegistry", async () => {
    const { createOracleTool } = await importSource(ORACLE_MODULE);
    const { runWorker, calls } = makeRunnerSpy();
    const tool = createOracleTool({ runWorker });
    const ctx = {
      cwd: "/abs/project",
      modelRegistry: makeRegistry([
        { provider: "openai", id: "gpt-5.4" },
        { provider: "openai-codex", id: "gpt-5.5" },
        { provider: "claude-subscription", id: "claude-opus-4-6" },
      ]),
    };
    await tool.execute("c", { task: "review" }, undefined, undefined, ctx);
    assert.equal(calls[0].model, "openai-codex/gpt-5.5");
  });

  it("forwards runner progress as a Pi tool update with renderable child-tool activity", async () => {
    const { createOracleTool } = await importSource(ORACLE_MODULE);
    let capturedUpdate;
    const runWorker = async (options) => {
      options.onUpdate?.({
        messages: [],
        finalOutput: "thinking…",
        truncatedFinalOutput: "thinking…",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        trail: [
          {
            type: "tool",
            toolCallId: "tool-1",
            toolName: "read",
            status: "completed",
            argsPreview: '{"path":"src/auth.ts"}',
            resultPreview: "42 lines",
          },
        ],
      });
      return makeWorkerResult();
    };
    const onUpdate = (partial) => { capturedUpdate = partial; };
    const tool = createOracleTool({ runWorker });
    await tool.execute("c", { task: "go" }, undefined, onUpdate, { cwd: "/tmp" });
    assert.ok(capturedUpdate);
    assert.ok(Array.isArray(capturedUpdate.content) && capturedUpdate.content.length > 0);
    assert.equal(capturedUpdate.content[0].type, "text");
    const readTrailItem = capturedUpdate.details.trail.find((item) => item.type === "tool" && item.toolName === "read");
    assert.ok(readTrailItem, "forwarded progress trail should include the completed read tool entry");
    assert.equal(readTrailItem.status, "completed");

    const fakeTheme = {
      fg(_color, text) { return text; },
      bold(text) { return text; },
    };
    const collapsed = tool.renderResult(
      capturedUpdate,
      { expanded: false, isPartial: true },
      fakeTheme,
      { args: { task: "go" }, showImages: false, isError: false },
    ).render(200).join("\n");
    assert.match(collapsed, /running\.\.\./i);
    assert.doesNotMatch(collapsed, /[▸▾◐●⚠]/);
    assert.match(collapsed, /Ctrl\+O/i);
    assert.doesNotMatch(collapsed, /src\/auth\.ts/);

    const expanded = tool.renderResult(
      capturedUpdate,
      { expanded: true, isPartial: true },
      fakeTheme,
      { args: { task: "go" }, showImages: false, isError: false },
    ).render(200).join("\n");
    assert.match(expanded, /oracle/i);
    assert.match(expanded, /read/);
    assert.match(expanded, /42 lines/);
    assert.match(expanded, /src\/auth\.ts/);
    assert.doesNotMatch(expanded, /→ toolCall/);
  });

  it("returns the worker's truncated final output as visible content and exposes details", async () => {
    const { createOracleTool } = await importSource(ORACLE_MODULE);
    const workerResult = makeWorkerResult({
      truncatedFinalOutput: "TL;DR: ship it.",
      finalOutput: "TL;DR: ship it.",
      args: ["--mode", "json", "-p", "--no-session", "--mmr-subagent", "oracle"],
    });
    const { runWorker } = makeRunnerSpy(workerResult);
    const tool = createOracleTool({ runWorker });
    const result = await tool.execute("c", { task: "go" }, undefined, undefined, { cwd: "/tmp" });
    assert.equal(result.content[0].type, "text");
    assert.match(result.content[0].text, /TL;DR: ship it\./);
    assert.equal(result.details.exitCode, 0);
    assert.deepEqual(result.details.args, workerResult.args);
    assert.equal(result.details.worker, "mmr-subagents.oracle");
  });

  it("returns a graceful aborted message when the worker is cancelled before producing output", async () => {
    const { createOracleTool } = await importSource(ORACLE_MODULE);
    const aborted = makeWorkerResult({
      finalOutput: "",
      truncatedFinalOutput: "",
      aborted: true,
      exitCode: null,
      signal: "SIGTERM",
    });
    const { runWorker } = makeRunnerSpy(aborted);
    const tool = createOracleTool({ runWorker });
    const result = await tool.execute("c", { task: "go" }, undefined, undefined, { cwd: "/tmp" });
    assert.match(result.content[0].text, /cancel|abort/i);
    assert.equal(result.details.aborted, true);
  });

  it("surfaces nonzero exit code with stderr tail when the worker fails to produce output", async () => {
    const { createOracleTool } = await importSource(ORACLE_MODULE);
    const failed = makeWorkerResult({
      finalOutput: "",
      truncatedFinalOutput: "",
      exitCode: 7,
      stderr: "line1\nline2\nfatal: boom\n",
    });
    const { runWorker } = makeRunnerSpy(failed);
    const tool = createOracleTool({ runWorker });
    const result = await tool.execute("c", { task: "go" }, undefined, undefined, { cwd: "/tmp" });
    assert.match(result.content[0].text, /exit/i);
    assert.match(result.content[0].text, /fatal: boom/);
    assert.equal(result.details.exitCode, 7);
  });

  it("surfaces spawn-error errorMessage as visible content when stderr is empty", async () => {
    // Spawn failures (e.g. `spawn ENOENT` when `pi` is missing on PATH)
    // produce exitCode=1 with no stderr; the runner mirrors the error
    // into errorMessage. Visible content must surface the reason instead
    // of just "worker exited with code 1".
    const { createOracleTool } = await importSource(ORACLE_MODULE);
    const failed = makeWorkerResult({
      finalOutput: "",
      truncatedFinalOutput: "",
      exitCode: 1,
      stderr: "",
      errorMessage: "spawn ENOENT",
    });
    const { runWorker } = makeRunnerSpy(failed);
    const tool = createOracleTool({ runWorker });
    const result = await tool.execute("c", { task: "go" }, undefined, undefined, { cwd: "/tmp" });
    assert.match(result.content[0].text, /exit/i);
    assert.match(result.content[0].text, /spawn ENOENT/);
  });

  it("renders a successful oracle run as completed (warning, not failed) when a non-fatal provider error was preserved", async () => {
    const { createOracleTool } = await importSource(ORACLE_MODULE);
    const workerResult = makeWorkerResult({
      finalOutput: "TL;DR: keep the API small.",
      truncatedFinalOutput: "TL;DR: keep the API small.",
      exitCode: 0,
      stopReason: "end_turn",
      errorMessage: "provider returned a transient 429 before the final answer",
    });
    const { runWorker } = makeRunnerSpy(workerResult);
    const tool = createOracleTool({ runWorker });
    const result = await tool.execute("c", { task: "review" }, undefined, undefined, { cwd: "/tmp" });
    assert.equal(result.details.status, "success");
    assert.equal(result.details.errorMessage, workerResult.errorMessage);
    assert.match(result.content[0].text, /keep the API small/);

    const fakeTheme = {
      fg(color, text) { return `[${color}]${text}`; },
      bg(_color, text) { return text; },
      bold(text) { return text; },
    };
    const rendered = tool.renderResult(
      result,
      { expanded: false, isPartial: false },
      fakeTheme,
      { args: { task: "review" }, showImages: false, isError: false },
    ).render(200).join("\n");
    assert.match(rendered, /completed/i);
    assert.doesNotMatch(rendered, /\[error\]/);
    assert.match(rendered, /\[warning\]provider returned a transient 429/);
  });

  it("surfaces nonzero exit even when the worker produced partial output", async () => {
    // A worker that emits some output and then exits nonzero must not
    // visually look like success.
    const { createOracleTool } = await importSource(ORACLE_MODULE);
    const failed = makeWorkerResult({
      finalOutput: "partial advisory\n",
      truncatedFinalOutput: "partial advisory\n",
      exitCode: 7,
      stderr: "fatal: boom\n",
    });
    const { runWorker } = makeRunnerSpy(failed);
    const tool = createOracleTool({ runWorker });
    const result = await tool.execute("c", { task: "go" }, undefined, undefined, { cwd: "/tmp" });
    assert.match(result.content[0].text, /exit/i);
    assert.match(result.content[0].text, /fatal: boom/);
    assert.doesNotMatch(result.content[0].text, /partial advisory/);
    assert.equal(result.details.exitCode, 7);
  });

  it("surfaces a no-agent-start diagnostic when the child exits before agent_start (sibling-extension input hook swallowed the prompt)", async () => {
    // Mirrors the finder regression guard. A sibling extension's `input`
    // handler returning { action: "handled" } in non-interactive mode
    // makes the child exit 0 with no output and no agent_start. The new
    // `no-agent-start` outcome surfaces a directed diagnostic instead of
    // the empty advisory message.
    const { createOracleTool } = await importSource(ORACLE_MODULE);
    const blocked = makeWorkerResult({
      finalOutput: "",
      truncatedFinalOutput: "",
      exitCode: 0,
      stderr: "some-other-extension: blocked the prompt to prevent accidental billing.",
      errorMessage: undefined,
      agentStarted: false,
    });
    const { runWorker } = makeRunnerSpy(blocked);
    const tool = createOracleTool({ runWorker });
    const result = await tool.execute("c", { task: "review" }, undefined, undefined, { cwd: "/tmp" });
    assert.match(result.content[0].text, /exited before the agent loop started/);
    assert.match(result.content[0].text, /another Pi extension's input handler/);
    assert.match(result.content[0].text, /some-other-extension: blocked the prompt/);
    // The new diagnostic intentionally includes the phrase "No advisory
    // output was produced" for context, so we cannot assert the old
    // cheerful message via doesNotMatch(/no advisory output/i). The
    // positive assertions above already prove the new outcome fired and
    // the message ends with the stderr tail (i.e. is not the empty-output
    // "re-run with a more specific task" fallback).
    assert.doesNotMatch(result.content[0].text, /Re-run with a more specific task/);
  });

  it("surfaces errorMessage when the worker exits 0 with no output", async () => {
    // A worker may report an error via the JSON stream and still exit 0
    // without producing final output. The empty-success fallback must
    // not mask that error.
    const { createOracleTool } = await importSource(ORACLE_MODULE);
    const failed = makeWorkerResult({
      finalOutput: "",
      truncatedFinalOutput: "",
      exitCode: 0,
      stderr: "",
      errorMessage: "upstream provider rate-limited",
    });
    const { runWorker } = makeRunnerSpy(failed);
    const tool = createOracleTool({ runWorker });
    const result = await tool.execute("c", { task: "go" }, undefined, undefined, { cwd: "/tmp" });
    assert.match(result.content[0].text, /upstream provider rate-limited/);
    assert.doesNotMatch(result.content[0].text, /no advisory output/i);
  });

  it("surfaces subagent activation failure as an explicit error result", async () => {
    const { createOracleTool } = await importSource(ORACLE_MODULE);
    const failed = makeWorkerResult({
      finalOutput: "",
      truncatedFinalOutput: "",
      exitCode: 0,
      stderr:
        'pi-mmr: subagent activation failed: Unknown subagent profile "no-such". Known profiles: finder, oracle.\n',
      subagentActivationError: 'Unknown subagent profile "no-such". Known profiles: finder, oracle.',
      errorMessage: 'subagent activation failed: Unknown subagent profile "no-such". Known profiles: finder, oracle.',
    });
    const { runWorker } = makeRunnerSpy(failed);
    const tool = createOracleTool({ runWorker });
    const result = await tool.execute("c", { task: "go" }, undefined, undefined, { cwd: "/tmp" });
    assert.match(result.content[0].text, /subagent activation failed/i);
    assert.equal(
      result.details.subagentActivationError,
      'Unknown subagent profile "no-such". Known profiles: finder, oracle.',
    );
    assert.match(result.details.errorMessage ?? "", /subagent activation failed/i);
  });

  it("forwards runnerDeps to the underlying runner so callers can inject spawn/resolveInvocation", async () => {
    const { createOracleTool } = await importSource(ORACLE_MODULE);
    let observedDeps;
    const runWorker = async (_options, deps) => { observedDeps = deps; return makeWorkerResult(); };
    const stubResolve = (args) => ({ command: "/fake/pi", args });
    const tool = createOracleTool({ runWorker, runnerDeps: { resolveInvocation: stubResolve } });
    await tool.execute("c", { task: "go" }, undefined, undefined, { cwd: "/tmp" });
    assert.ok(observedDeps);
    assert.equal(observedDeps.resolveInvocation, stubResolve);
  });

  it("reads settings-driven subagentModelPreferences.oracle on every execute so /mmr-config writes take effect on the next call", async () => {
    // Behavioral pin: parent oracle and child Pi process must agree on
    // the resolved model. The child path already reads
    // loadMmrCoreSettings on every activation; the parent must do the
    // same so a /mmr-config override that names a model not in the
    // default preference list cannot fail with model.mismatch.
    const { createOracleTool, ORACLE_SUBAGENT_PROFILE } =
      await importSource(ORACLE_MODULE);
    const captured = [];
    let loadCalls = 0;
    const { runWorker, calls } = makeRunnerSpy();
    const tool = createOracleTool({
      runWorker,
      loadSubagentModelPreferences: (cwd) => {
        loadCalls += 1;
        captured.push(cwd);
        return {
          subagentModelPreferences: {
            [ORACLE_SUBAGENT_PROFILE]: [
              { model: "claude-opus-4-8", thinkingLevel: "high" },
            ],
          },
        };
      },
    });
    await tool.execute(
      "c1",
      { task: "review" },
      undefined,
      undefined,
      {
        cwd: "/tmp/repo",
        // Registry includes the settings override (claude-opus-4-8) so the
        // resolver picks it over the profile default.
        modelRegistry: makeRegistry([
          { provider: "openai-codex", id: "gpt-5.5" },
          { provider: "claude-subscription", id: "claude-opus-4-8" },
        ]),
      },
    );
    assert.equal(loadCalls, 1, "oracle must read settings exactly once per execute");
    assert.equal(captured[0], "/tmp/repo", "settings loader must be called with ctx.cwd");
    assert.equal(
      calls[0].model,
      "claude-subscription/claude-opus-4-8",
      "runner must receive the settings-driven model, not the profile default",
    );
  });

  it("propagates structured runner spawnError into OracleDetails.spawnError", async () => {
    // The shared progress renderer prefers details.spawnError over
    // raw errorMessage when classifying the worker outcome; oracle must
    // copy the structured discriminator out of MmrWorkerResult so the
    // renderer (and downstream callers) see it on details.
    const { createOracleTool } = await importSource(ORACLE_MODULE);
    const failed = makeWorkerResult({
      finalOutput: "",
      truncatedFinalOutput: "",
      exitCode: 1,
      stderr: "",
      errorMessage: "spawn ENOENT",
      spawnError: "spawn ENOENT",
    });
    const { runWorker } = makeRunnerSpy(failed);
    const tool = createOracleTool({ runWorker });
    const result = await tool.execute("c", { task: "go" }, undefined, undefined, { cwd: "/tmp" });
    assert.equal(result.details.spawnError, "spawn ENOENT");
  });
});

describe("oracle parent↔child route agreement", () => {
  // Proves the production unification (issue-#1 "Option A"): the parent
  // oracle tool and the child Pi process both resolve the worker route
  // through the SAME `selectMmrModelRoute` resolver, so they can never
  // disagree on the `--model`. The parent route string the tool would pass
  // must equal the child's `resolveMmrSubagentInvocation(...).modelArg`,
  // and passing that route back as an explicit `--model` must not trip the
  // child's model.mismatch guard.
  it("parent route equals the child's resolved modelArg for the oracle profile", async () => {
    const { selectMmrModelRoute } = await importSource(MODEL_RESOLVER_MODULE);
    const { resolveMmrSubagentInvocation } = await importSource(SUBAGENT_RESOLVER_MODULE);
    const { getMmrSubagentProfile } = await importSource(PROFILES_MODULE);
    const profile = getMmrSubagentProfile("oracle");
    // Registry includes the profile's primary (GPT-5.5) plus the Claude
    // Opus 4.6 fallback so the resolver has a real route to pick.
    const registry = makeRegistry([
      { provider: "openai-codex", id: "gpt-5.5" },
      { provider: "claude-subscription", id: "claude-opus-4-6" },
    ]);

    // Parent route: exactly what oracle.execute() forms as --model.
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

describe("oracle always-blocking guidance", () => {
  it("states oracle is always blocking in the description (the `## Using workers` block covers guidelines)", async () => {
    const { createOracleTool } = await importSource(ORACLE_MODULE);
    const tool = createOracleTool();
    // The always-blocking constraint renders once in the `## Using workers`
    // block when background-capable workers are active; per-tool guidelines
    // carry routing only.
    for (const guideline of tool.promptGuidelines) {
      assert.doesNotMatch(guideline, /blocking/i);
    }
    assert.match(
      tool.description,
      /always blocking/i,
      "oracle description must state it is always blocking",
    );
    assert.match(
      tool.description,
      /cannot run as a background task/i,
      "oracle description must state it cannot run as a background task",
    );
  });
});
