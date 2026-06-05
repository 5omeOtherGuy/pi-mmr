import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const CUSTOM_RUNTIME_MODULE = "extensions/mmr-subagents/custom-runtime.ts";
const CUSTOM_LOADER_MODULE = "extensions/mmr-subagents/custom-loader.ts";
const PROFILES_MODULE = "extensions/mmr-core/subagent-profiles.ts";
const PROMPT_ASSEMBLY_MODULE = "extensions/mmr-core/subagent-prompt-assembly.ts";

beforeEach(async () => {
  const { clearMmrDynamicSubagentProfiles } = await importSource(PROFILES_MODULE);
  const { clearMmrSubagentPromptBuilders } = await importSource(PROMPT_ASSEMBLY_MODULE);
  clearMmrDynamicSubagentProfiles();
  clearMmrSubagentPromptBuilders();
});

function makeRegistry(models) {
  return {
    getAll: () => models,
    getAvailable: () => models,
    find: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
    hasConfiguredAuth: () => true,
  };
}

function makeWorkerResult(overrides = {}) {
  return {
    messages: [],
    finalOutput: "custom answer",
    truncatedFinalOutput: "custom answer",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    trail: [],
    prompt: "",
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

describe("mmr-subagents custom Markdown runtime", () => {
  it("discovers .claude/agents synchronously, registers sa__ tools, profiles, and prompt builders at extension activation", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "pi-mmr-custom-runtime-"));
    try {
      const agents = path.join(root, ".claude", "agents");
      mkdirSync(agents, { recursive: true });
      writeFileSync(
        path.join(agents, "reviewer.md"),
        [
          "---",
          "name: Repo Reviewer",
          "description: Reviews repository changes.",
          "model: openai-codex/gpt-5.5",
          "tools: Read, Bash",
          "---",
          "Review the repository.",
        ].join("\n"),
      );

      const { createMmrSubagentsExtension } = await importSource("extensions/mmr-subagents/index.ts");
      const { getMmrSubagentProfile } = await importSource(PROFILES_MODULE);
      const { getMmrSubagentPromptBuilder } = await importSource(PROMPT_ASSEMBLY_MODULE);
      const { pi, tools } = createMockPi({ activeTools: ["read", "bash"], allTools: ["read", "bash"] });

      createMmrSubagentsExtension({ customSubagents: { cwd: root, homeDir: path.join(root, "home") } })(pi);

      assert.ok(tools.has("sa__repo_reviewer"));
      assert.equal(getMmrSubagentProfile("sa__repo_reviewer")?.displayName, "Repo Reviewer");
      assert.equal(getMmrSubagentPromptBuilder("sa__repo_reviewer")?.({ profile: getMmrSubagentProfile("sa__repo_reviewer"), cwd: root, baseSystemPrompt: "" }), "Review the repository.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("executes a custom subagent through the shared runner with parent-active tool filtering and inherited model override", async () => {
    const { parseMmrCustomSubagentMarkdown } = await importSource(CUSTOM_LOADER_MODULE);
    const { registerMmrCustomSubagentDefinition } = await importSource(CUSTOM_RUNTIME_MODULE);
    const definition = parseMmrCustomSubagentMarkdown({
      filePath: path.join("/repo", ".claude", "agents", "writer.md"),
      markdown: [
        "---",
        "type: subagent",
        "name: Test Writer",
        "description: Writes focused tests.",
        "model: inherit",
        "thinkingLevel: high",
        "tools: read, bash, write",
        "isolatedContext: true",
        "---",
        "Write tests only.",
      ].join("\n"),
    });
    assert.ok(definition);

    const runCalls = [];
    const runner = { run: async (options) => { runCalls.push(options); return makeWorkerResult({ prompt: options.prompt, cwd: options.cwd }); } };
    const { pi, tools } = createMockPi({ activeTools: ["read", "bash"], allTools: ["read", "bash", "write"] });
    registerMmrCustomSubagentDefinition(pi, definition, { runner });

    const result = await tools.get("sa__test_writer").execute(
      "call-1",
      { task: "add unit tests" },
      undefined,
      undefined,
      {
        cwd: "/repo",
        model: { provider: "openai-codex", id: "gpt-5.5", contextWindow: 1234 },
        modelRegistry: makeRegistry([{ provider: "openai-codex", id: "gpt-5.5", contextWindow: 1234 }]),
      },
    );

    assert.equal(result.content[0].text, "custom answer");
    assert.equal(runCalls.length, 1);
    assert.equal(runCalls[0].profileName, "sa__test_writer");
    assert.equal(runCalls[0].prompt, "add unit tests");
    assert.equal(runCalls[0].systemPrompt, "Write tests only.");
    assert.equal(runCalls[0].systemPromptDelivery, "replace");
    assert.equal(runCalls[0].model, "openai-codex/gpt-5.5");
    assert.deepEqual(runCalls[0].modelPreferencesOverride, [{ providers: ["openai-codex"], model: "gpt-5.5" }]);
    assert.deepEqual(runCalls[0].tools, ["read", "bash"], "write is registered but not active in the parent, so it is denied");
    assert.equal(result.details.model, "openai-codex/gpt-5.5");
    assert.equal(result.details.contextWindow, 1234);
    assert.deepEqual(result.details.workerTools, ["read", "bash"]);
    assert.equal(result.details.fallbackNotice, undefined, "a fully-declared worker gets no fallback notice");
  });

  it("wires a declared thinkingLevel/effort onto the registered profile", async () => {
    const { parseMmrCustomSubagentMarkdown } = await importSource(CUSTOM_LOADER_MODULE);
    const { registerMmrCustomSubagentDefinition } = await importSource(CUSTOM_RUNTIME_MODULE);
    const { getMmrSubagentProfile } = await importSource(PROFILES_MODULE);
    const definition = parseMmrCustomSubagentMarkdown({
      filePath: path.join("/repo", ".claude", "agents", "thinker.md"),
      markdown: [
        "---",
        "type: subagent",
        "name: Deep Thinker",
        "description: Thinks hard.",
        "model: inherit",
        "effort: high",
        "tools: read",
        "---",
        "Think.",
      ].join("\n"),
    });
    assert.ok(definition);
    assert.equal(definition.thinkingLevel, "high", "effort is an alias for thinkingLevel");
    const { pi } = createMockPi({ activeTools: ["read"], allTools: ["read"] });
    registerMmrCustomSubagentDefinition(pi, definition, { runner: { run: async () => makeWorkerResult() } });
    assert.equal(getMmrSubagentProfile("sa__deep_thinker")?.thinkingLevel, "high");
  });

  it("defaults to the standard toolset and surfaces a fallback notice when no tools field is present", async () => {
    const { parseMmrCustomSubagentMarkdown } = await importSource(CUSTOM_LOADER_MODULE);
    const { registerMmrCustomSubagentDefinition } = await importSource(CUSTOM_RUNTIME_MODULE);
    const definition = parseMmrCustomSubagentMarkdown({
      filePath: path.join("/repo", ".claude", "agents", "prompt-only.md"),
      markdown: [
        "---",
        "type: subagent",
        "name: Prompt Only",
        "description: Answers from its prompt only.",
        "---",
        "Respond using only the task prompt.",
      ].join("\n"),
    });
    assert.ok(definition);
    assert.equal(definition.toolsDeclared, false);

    const runCalls = [];
    const runner = { run: async (options) => { runCalls.push(options); return makeWorkerResult({ prompt: options.prompt, cwd: options.cwd }); } };
    const { pi, tools } = createMockPi({ activeTools: ["read", "bash"], allTools: ["read", "bash"] });
    registerMmrCustomSubagentDefinition(pi, definition, { runner });

    const result = await tools.get("sa__prompt_only").execute(
      "call-1",
      { task: "summarize the design" },
      undefined,
      undefined,
      {
        cwd: "/repo",
        model: { provider: "openai-codex", id: "gpt-5.5", contextWindow: 1234 },
        modelRegistry: makeRegistry([{ provider: "openai-codex", id: "gpt-5.5", contextWindow: 1234 }]),
      },
    );

    assert.deepEqual(runCalls[0].tools, ["read", "bash"], "no tools field defaults to the standard toolset, intersected with active tools");
    assert.deepEqual(result.details.workerTools, ["read", "bash"]);
    assert.ok(typeof result.details.fallbackNotice === "string" && result.details.fallbackNotice.includes("standard toolset"));
    assert.match(result.details.fallbackNotice, /No model selected/);
    assert.equal(result.content[0].text, "custom answer", "the fallback notice is details/render-only and never injected into model-consumed content");
  });

  it("builds a fallback notice covering model, thinking, and tools states", async () => {
    const { buildMmrCustomSubagentFallbackNotice } = await importSource(CUSTOM_RUNTIME_MODULE);
    const base = {
      name: "Prompt Only",
      toolName: "sa__prompt_only",
      description: "d",
      filePath: "/repo/.claude/agents/prompt-only.md",
      baseDir: "/repo/.claude/agents",
      systemPrompt: "p",
      model: "inherit",
      modelDeclared: true,
      thinkingLevel: "high",
      toolPatterns: [],
      skills: [],
      isolatedContext: false,
    };
    // Tools omitted -> standard toolset default.
    const omitted = buildMmrCustomSubagentFallbackNotice({ ...base, toolsDeclared: false }, ["read"]);
    assert.match(omitted, /defaulting to the standard toolset/);
    // Tools declared but empty -> ran with no tools.
    const empty = buildMmrCustomSubagentFallbackNotice({ ...base, toolsDeclared: true }, []);
    assert.match(empty, /ran with no tools/);
    // Model and thinking omitted -> their own lines.
    const noModelNoThinking = buildMmrCustomSubagentFallbackNotice(
      { ...base, modelDeclared: false, thinkingLevel: undefined, toolsDeclared: true },
      ["read"],
    );
    assert.match(noModelNoThinking, /No model selected/);
    assert.match(noModelNoThinking, /No effort\/thinking level selected/);
    // Fully declared with tools -> no notice.
    assert.equal(
      buildMmrCustomSubagentFallbackNotice({ ...base, toolsDeclared: true }, ["read"]),
      undefined,
    );
  });
});
