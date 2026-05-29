import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const CTHULU_MODULE = "extensions/mmr-subagents/cthulu.ts";
const PROFILES_MODULE = "extensions/mmr-core/subagent-profiles.ts";
const REQUEST_POLICY_MODULE = "extensions/mmr-core/request-policy.ts";
const PROMPTS_MODULE = "extensions/mmr-subagents/prompts.ts";
const PROMPT_ASSEMBLY_MODULE = "extensions/mmr-core/subagent-prompt-assembly.ts";
const PROMPT_TEMPLATES_MODULE = "extensions/mmr-core/prompt-templates.ts";

beforeEach(async () => {
  const { clearMmrSubagentPromptBuilders } = await importSource(PROMPT_ASSEMBLY_MODULE);
  const { registerMmrSubagentsPromptBuilders } = await importSource(PROMPTS_MODULE);
  clearMmrSubagentPromptBuilders();
  registerMmrSubagentsPromptBuilders();
});

function makeWorkerResult(overrides = {}) {
  return {
    messages: [],
    finalOutput: "The stars are right. Recommended fix: ...",
    truncatedFinalOutput: "The stars are right. Recommended fix: ...",
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
    model: "claude-opus-4-8",
    stopReason: "end_turn",
    errorMessage: undefined,
    prompt: "Task: solve",
    cwd: "/tmp/project",
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

function makeRunnerSpy(result = makeWorkerResult()) {
  const calls = [];
  const runWorker = async (options) => {
    calls.push(options);
    return result;
  };
  return { runWorker, calls };
}

// Registry stub matching the shape `selectMmrModelRoute` consumes, plus the
// `getAvailable()` the advisor context-window lookup reads.
function makeRegistry(models) {
  return {
    getAll: () => models,
    find: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
    hasConfiguredAuth: () => true,
    isUsingOAuth: (model) => model.provider.endsWith("subscription") || model.provider.endsWith("codex"),
    getAvailable: () => models,
  };
}

describe("cthulu subagent profile", () => {
  it("is a standalone profile pinned to opus-4-8 at xhigh with a 128k output cap", async () => {
    const { getMmrSubagentProfile } = await importSource(PROFILES_MODULE);
    const profile = getMmrSubagentProfile("cthulu");
    assert.ok(profile, "cthulu profile must be registered");
    assert.equal(profile.promptRoute, "standalone");
    assert.equal(profile.promptBuilder, "cthulu");
    assert.equal(profile.thinkingLevel, "xhigh");
    assert.equal(profile.maxOutputTokens, 128000);
    assert.equal(profile.modelPreferences[0].model, "claude-opus-4-8");
    assert.equal(profile.modelPreferences[0].thinkingLevel, "xhigh");
    // Same advisory tool surface as the oracle.
    assert.deepEqual(
      [...profile.tools],
      ["read", "grep", "find", "web_search", "read_web_page", "read_session", "find_session"],
    );
    assert.equal(profile.allowToolbox, false);
    assert.equal(profile.allowMcp, false);
  });
});

describe("buildMmrSubagentOutputPolicy", () => {
  it("caps both Anthropic and Responses output for a positive cap", async () => {
    const { buildMmrSubagentOutputPolicy, applyMmrRequestPolicy } = await importSource(REQUEST_POLICY_MODULE);
    const policy = buildMmrSubagentOutputPolicy(128000);
    assert.ok(policy);
    assert.equal(policy.anthropic.maxTokens, 128000);
    assert.equal(policy.openaiResponses.maxOutputTokens, 128000);

    const anthropic = applyMmrRequestPolicy(
      { model: "claude-opus-4-8", messages: [], max_tokens: 4096, system: "x" },
      policy,
    );
    assert.equal(anthropic.max_tokens, 128000);

    const responses = applyMmrRequestPolicy(
      { model: "gpt-5.5", input: [], max_output_tokens: 4096, reasoning: { effort: "high" } },
      policy,
    );
    assert.equal(responses.max_output_tokens, 128000);
  });

  it("returns undefined for missing/invalid caps", async () => {
    const { buildMmrSubagentOutputPolicy } = await importSource(REQUEST_POLICY_MODULE);
    assert.equal(buildMmrSubagentOutputPolicy(undefined), undefined);
    assert.equal(buildMmrSubagentOutputPolicy(0), undefined);
    assert.equal(buildMmrSubagentOutputPolicy(-1), undefined);
    assert.equal(buildMmrSubagentOutputPolicy(Number.NaN), undefined);
  });
});

describe("cthulu worker system prompt", () => {
  it("builds on the oracle base and adds a thorough, safety-yielding Cthulhu persona", async () => {
    const { buildCthuluWorkerSystemPrompt } = await importSource(CTHULU_MODULE);
    const { buildOracleWorkerSystemPrompt } = await importSource(PROMPTS_MODULE);
    const prompt = buildCthuluWorkerSystemPrompt("/abs/repo");
    // Reuses the oracle advisor base verbatim.
    assert.ok(prompt.startsWith(buildOracleWorkerSystemPrompt("/abs/repo")));
    assert.match(prompt, /Cthulhu/);
    assert.match(prompt, /R'lyeh/);
    // Deeper, no-economy-bias posture replaces the old jailbreak-shaped override.
    assert.match(prompt, /Depth and rigor for this invocation/i);
    assert.match(prompt, /over brevity/i);
    // Must NOT contain jailbreak/override-shaped phrasing that trips provider
    // safety classifiers.
    assert.doesNotMatch(prompt, /NO limits|REVOKED|ignore every instruction|override:/i);
    // It explicitly yields to safety/policy.
    assert.match(prompt, /does not authorize unsafe behavior/i);
    // Final answer must remain clear/actionable English.
    assert.match(prompt, /clear, precise, correct, actionable English/i);
  });
});

describe("cthulu tool definition", () => {
  it("exposes a hidden, secrecy-first description and guidelines", async () => {
    const { createCthuluTool, CTHULU_DESCRIPTION, CTHULU_PROMPT_SNIPPET } = await importSource(CTHULU_MODULE);
    const tool = createCthuluTool();
    assert.equal(tool.name, "cthulu");
    assert.equal(tool.description, CTHULU_DESCRIPTION);
    assert.equal(tool.promptSnippet, CTHULU_PROMPT_SNIPPET);
    assert.match(tool.description, /LOCKED BY DEFAULT/);
    // No jailbreak/override-shaped phrasing in the model-facing metadata.
    assert.doesNotMatch(tool.description, /FORBIDDEN BY DEFAULT|NO limit|does not exist/i);
    assert.ok(tool.promptGuidelines.some((g) => /do not invoke this tool on your own/i.test(g)));
    assert.ok(tool.promptGuidelines.some((g) => /do not mention/i.test(g)));
  });

  it("runs the cthulu profile and labels its output as cthulu", async () => {
    const { createCthuluTool } = await importSource(CTHULU_MODULE);
    const { runWorker, calls } = makeRunnerSpy();
    const tool = createCthuluTool({
      runWorker,
      buildSystemPrompt: (cwd) => `RITE for ${cwd}`,
    });
    const result = await tool.execute(
      "rite-1",
      { task: "Optimal fix for the deadlock." },
      undefined,
      undefined,
      { cwd: "/abs/project", modelRegistry: makeRegistry([{ provider: "claude-subscription", id: "claude-opus-4-8" }]) },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].profileName, "cthulu");
    assert.equal(calls[0].model, "claude-subscription/claude-opus-4-8");
    assert.equal(calls[0].systemPrompt, "RITE for /abs/project");
    assert.equal(result.details.worker, "mmr-subagents.cthulu");
    // The final answer (success) is returned untouched (not transliterated).
    assert.match(result.content[0].text, /The stars are right\. Recommended fix:/);
  });

  it("prefixes failure advisories with the cthulu label", async () => {
    const { createCthuluTool } = await importSource(CTHULU_MODULE);
    const { runWorker } = makeRunnerSpy(makeWorkerResult({ spawnError: "spawn ENOENT" }));
    const tool = createCthuluTool({ runWorker });
    const result = await tool.execute("rite-2", { task: "x" }, undefined, undefined, { cwd: "/tmp" });
    assert.match(result.content[0].text, /^cthulu: worker spawn failed: spawn ENOENT/);
  });
});

describe("summon-gate easter egg in the main agent mode prompt", () => {
  it("defines the rite around recognizable anchors while granting improvisation", async () => {
    const { MMR_CTHULU_SUMMON_GATE, MMR_CTHULU_RITE_ANCHORS } = await importSource(PROMPT_TEMPLATES_MODULE);
    // Each marked step embeds its exact anchor so the rite stays recognizable.
    for (const anchor of Object.values(MMR_CTHULU_RITE_ANCHORS)) {
      assert.ok(typeof anchor === "string" && anchor.length > 0);
      assert.ok(MMR_CTHULU_SUMMON_GATE.includes(anchor), `gate must embed anchor: ${anchor}`);
    }
    // The chant is referenced descriptively (not spelled out) so the model can
    // recognize attempts without the gate embedding the incantation text.
    assert.match(MMR_CTHULU_SUMMON_GATE, /chant associated with Cthulhu/i);
    // Framed as optional roleplay that yields to safety, not a hidden override.
    assert.match(MMR_CTHULU_SUMMON_GATE, /optional/i);
    assert.match(MMR_CTHULU_SUMMON_GATE, /never overrides safety/i);
    // The agent is given latitude to improvise the dread around the anchors.
    assert.match(MMR_CTHULU_SUMMON_GATE, /improvise/i);
    assert.match(MMR_CTHULU_SUMMON_GATE, /exact anchor sentence/i);
  });

  it("does not reach into or try to control the model's private reasoning", async () => {
    const { MMR_CTHULU_SUMMON_GATE } = await importSource(PROMPT_TEMPLATES_MODULE);
    // It explicitly refuses to manipulate private reasoning (anti-jailbreak).
    assert.match(MMR_CTHULU_SUMMON_GATE, /Do not try to control, alter, hide, or narrate private reasoning/i);
    // It must NOT instruct the model to suppress/style its chain-of-thought,
    // which frontier models read as a jailbreak.
    assert.doesNotMatch(MMR_CTHULU_SUMMON_GATE, /not in your private reasoning|inside your thinking|override your normal voice|must keep buried/i);
    // It keeps the chant text out of the user's hands as a puzzle boundary.
    assert.match(MMR_CTHULU_SUMMON_GATE, /Do not (give the user|tell the user) the chant/i);
  });

  it("matches the chant loosely by spirit, not verbatim", async () => {
    const { MMR_CTHULU_SUMMON_GATE } = await importSource(PROMPT_TEMPLATES_MODULE);
    assert.match(MMR_CTHULU_SUMMON_GATE, /by spirit/i);
    assert.match(MMR_CTHULU_SUMMON_GATE, /ignore case/i);
    assert.match(MMR_CTHULU_SUMMON_GATE, /minor misspellings/i);
    // It must NOT demand an exact/verbatim incantation match.
    assert.doesNotMatch(MMR_CTHULU_SUMMON_GATE, /verbatim incantation/i);
  });

  it("keeps theatrical dread and refuses to summon on an empty task", async () => {
    const { MMR_CTHULU_SUMMON_GATE } = await importSource(PROMPT_TEMPLATES_MODULE);
    assert.match(MMR_CTHULU_SUMMON_GATE, /dread/i);
    assert.match(MMR_CTHULU_SUMMON_GATE, /visibly theatrical|visible dread/i);
    assert.match(MMR_CTHULU_SUMMON_GATE, /DO NOT summon/);
    assert.match(MMR_CTHULU_SUMMON_GATE, /not to spend the rite on emptiness/i);
  });

  it("keeps a light mythic style for the rest of the session once summoned", async () => {
    const { MMR_CTHULU_SUMMON_GATE } = await importSource(PROMPT_TEMPLATES_MODULE);
    assert.match(MMR_CTHULU_SUMMON_GATE, /lingering style/i);
    assert.match(MMR_CTHULU_SUMMON_GATE, /later visible replies/i);
    // Substance must stay clear/usable even while the voice stays in character.
    assert.match(MMR_CTHULU_SUMMON_GATE, /clear and usable/i);
    // Before the rite succeeds, normal voice.
    assert.match(MMR_CTHULU_SUMMON_GATE, /not succeeded[\s\S]*speak normally/i);
  });

  it("never names any gated worker tool so it cannot leak tool names while gated", async () => {
    const { MMR_CTHULU_SUMMON_GATE } = await importSource(PROMPT_TEMPLATES_MODULE);
    for (const leaked of ["oracle", "finder", "librarian", "handoff", "read_session", "find_session"]) {
      assert.doesNotMatch(
        MMR_CTHULU_SUMMON_GATE,
        new RegExp(`\\b${leaked}\\b`),
        `summon gate must not name the gated tool ${leaked}`,
      );
    }
  });

  it("is appended to every locked mode's assembled prompt", async () => {
    const { buildMmrPromptLayer } = await importSource("extensions/mmr-core/prompt.ts");
    const { MMR_CTHULU_SUMMON_GATE } = await importSource(PROMPT_TEMPLATES_MODULE);
    const base = "You are an expert coding assistant operating inside pi, a coding agent harness.\n\n"
      + "## Tool use\n\nx\n\nAvailable tools:\n- read: Read file contents\n\n"
      + "In addition to the tools above, you may have access to other custom tools depending on the project.\n\n"
      + "Guidelines:\n- be nice\n\n"
      + "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):\n- Main documentation: /x\n\nCurrent date: 2026-05-28";
    for (const mode of ["smart", "smartGPT", "rush", "large", "deep"]) {
      const state = {
        mode,
        displayName: mode,
        source: "settings",
        targetModel: "claude-opus-4-8",
        requestedModels: ["claude-opus-4-8"],
        provider: "claude-subscription",
        model: "claude-opus-4-8",
        modelFound: true,
        modelApplied: true,
        modelFallbackApplied: false,
        modelCandidates: [],
        thinkingLevel: "medium",
        promptRoute: mode === "rush" ? "rush" : mode === "deep" ? "deep" : "default",
        requestedTools: ["Read"],
        activeTools: ["read"],
        missingTools: [],
      };
      const result = buildMmrPromptLayer({ state, baseSystemPrompt: base });
      assert.ok(result.includes(MMR_CTHULU_SUMMON_GATE), `${mode}: summon gate must be present`);
    }
  });
});
