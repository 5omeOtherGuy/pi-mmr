import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

function anthropicPayload(overrides = {}) {
  return {
    model: "claude-opus-4-8",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    max_tokens: 1024,
    system: [
      { type: "text", text: "Pi baseline system prompt.", cache_control: { type: "ephemeral" } },
      { type: "text", text: "MMR prompt", cache_control: { type: "ephemeral" } },
    ],
    tools: [{ name: "read" }],
    ...overrides,
  };
}

function openaiPayload(overrides = {}) {
  return {
    model: "gpt-5.5",
    input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    stream: true,
    store: false,
    ...overrides,
  };
}

describe("mmr-core request policy", () => {
  it("applies smart Anthropic adaptive thinking and max_tokens without touching system/messages/tools", async () => {
    const { applyMmrRequestPolicy, MMR_REQUEST_POLICIES } = await importSource("extensions/mmr-core/request-policy.ts");
    const payload = anthropicPayload({ output_config: { some_future_field: true } });
    const originalSystem = JSON.stringify(payload.system);
    const originalMessages = JSON.stringify(payload.messages);
    const originalTools = JSON.stringify(payload.tools);

    const smart = applyMmrRequestPolicy(payload, MMR_REQUEST_POLICIES.smart);

    assert.notEqual(smart, payload);
    assert.equal(smart.max_tokens, 32000);
    assert.deepEqual(smart.thinking, { type: "adaptive", display: "summarized" });
    assert.deepEqual(smart.output_config, { some_future_field: true, effort: "high" });
    assert.equal(JSON.stringify(smart.system), originalSystem);
    assert.equal(JSON.stringify(smart.messages), originalMessages);
    assert.equal(JSON.stringify(smart.tools), originalTools);
    assert.equal(payload.max_tokens, 1024, "original payload is not mutated");
  });

  it("applies large Anthropic adaptive medium reasoning with 32k max_tokens for Opus 4.6", async () => {
    const { applyMmrRequestPolicy, MMR_REQUEST_POLICIES } = await importSource("extensions/mmr-core/request-policy.ts");
    const originalSystem = JSON.stringify(anthropicPayload().system);
    const payload = anthropicPayload({
      model: "claude-opus-4-6",
      max_tokens: 1024,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { some_future_field: true, effort: "low" },
    });

    const result = applyMmrRequestPolicy(payload, MMR_REQUEST_POLICIES.large);

    assert.notEqual(result, payload);
    assert.equal(result.max_tokens, 32000);
    assert.deepEqual(result.thinking, { type: "adaptive", display: "summarized" });
    assert.deepEqual(result.output_config, { some_future_field: true, effort: "medium" });
    assert.equal(JSON.stringify(result.system), originalSystem);
    assert.equal(payload.max_tokens, 1024, "original payload is not mutated");
  });

  it("applies large OpenAI medium reasoning to the gpt-5.4 fallback without a max_output_tokens override", async () => {
    const { applyMmrRequestPolicy, MMR_REQUEST_POLICIES } = await importSource("extensions/mmr-core/request-policy.ts");
    const payload = openaiPayload({ reasoning: { effort: "low", encrypted: true } });

    const result = applyMmrRequestPolicy(payload, MMR_REQUEST_POLICIES.large);

    assert.notEqual(result, payload);
    assert.equal("max_output_tokens" in result, false);
    assert.deepEqual(result.reasoning, { effort: "medium", encrypted: true, summary: "auto" });
    assert.deepEqual(result.input, payload.input);
  });

  it("applies rush OpenAI Responses with reasoning effort none and 128k max output", async () => {
    const { applyMmrRequestPolicy, MMR_REQUEST_POLICIES } = await importSource("extensions/mmr-core/request-policy.ts");
    const payload = openaiPayload({
      max_output_tokens: 4096,
      reasoning: { effort: "medium", encrypted: true },
    });

    const result = applyMmrRequestPolicy(payload, MMR_REQUEST_POLICIES.rush);

    assert.notEqual(result, payload);
    assert.equal(result.max_output_tokens, 128000);
    assert.deepEqual(result.reasoning, { effort: "none", encrypted: true });
    assert.deepEqual(result.input, payload.input);
    assert.deepEqual(payload.reasoning, { effort: "medium", encrypted: true }, "original payload is not mutated");
  });

  it("does not apply an Anthropic budget-thinking override in rush fallback routes", async () => {
    const { applyMmrRequestPolicy, MMR_REQUEST_POLICIES } = await importSource("extensions/mmr-core/request-policy.ts");
    const payload = anthropicPayload({
      model: "claude-haiku-4-5-20251001",
      thinking: { type: "disabled" },
      output_config: { keep: "value" },
    });

    const result = applyMmrRequestPolicy(payload, MMR_REQUEST_POLICIES.rush);

    assert.equal(result, payload);
    assert.equal(MMR_REQUEST_POLICIES.rush.anthropic, undefined);
  });

  it("applies deep OpenAI Responses reasoning and max_output_tokens for the public Responses shape", async () => {
    const { applyMmrRequestPolicy, MMR_REQUEST_POLICIES } = await importSource("extensions/mmr-core/request-policy.ts");
    const payload = openaiPayload({
      max_output_tokens: 4096,
      reasoning: { effort: "low", encrypted: true },
      include: ["reasoning.encrypted_content"],
    });

    const result = applyMmrRequestPolicy(payload, MMR_REQUEST_POLICIES.deep);

    assert.notEqual(result, payload);
    assert.equal(result.max_output_tokens, 128000);
    assert.deepEqual(result.reasoning, { effort: "medium", encrypted: true, summary: "auto" });
    assert.deepEqual(result.input, payload.input);
    assert.deepEqual(result.include, ["reasoning.encrypted_content"]);
    assert.equal(payload.max_output_tokens, 4096, "original payload is not mutated");
  });

  it("skips max_output_tokens for Codex-variant payloads identified by top-level instructions string", async () => {
    const { applyMmrRequestPolicy, MMR_REQUEST_POLICIES } = await importSource("extensions/mmr-core/request-policy.ts");
    const payload = openaiPayload({
      instructions: "You are a helpful assistant.",
      reasoning: { effort: "low" },
    });

    const result = applyMmrRequestPolicy(payload, MMR_REQUEST_POLICIES.deep);

    assert.equal("max_output_tokens" in result, false, "Codex backend rejects max_output_tokens; do not set it");
    assert.deepEqual(result.reasoning, { effort: "medium", summary: "auto" });
    assert.equal(result.instructions, "You are a helpful assistant.");
    assert.deepEqual(result.input, payload.input);
  });

  it("skips max_output_tokens for Codex-variant payloads identified by text.verbosity", async () => {
    const { applyMmrRequestPolicy, MMR_REQUEST_POLICIES } = await importSource("extensions/mmr-core/request-policy.ts");
    const payload = openaiPayload({
      text: { verbosity: "low" },
      reasoning: { effort: "low" },
    });

    const result = applyMmrRequestPolicy(payload, MMR_REQUEST_POLICIES.deep);

    assert.equal("max_output_tokens" in result, false);
    assert.deepEqual(result.reasoning, { effort: "medium", summary: "auto" });
    assert.deepEqual(result.text, { verbosity: "low" });
  });

  it("still strips an inbound max_output_tokens out of Codex-variant payloads (does not echo it back)", async () => {
    const { applyMmrRequestPolicy, MMR_REQUEST_POLICIES } = await importSource("extensions/mmr-core/request-policy.ts");
    const payload = openaiPayload({
      instructions: "sys",
      max_output_tokens: 4096,
      reasoning: { effort: "low" },
    });

    const result = applyMmrRequestPolicy(payload, MMR_REQUEST_POLICIES.deep);

    assert.equal("max_output_tokens" in result, false, "Codex variant must not carry max_output_tokens forward");
  });

  it("uses the resolved provider id to strip max_output_tokens from openai-codex Responses payloads without Codex markers", async () => {
    const { applyMmrRequestPolicy, MMR_REQUEST_POLICIES } = await importSource("extensions/mmr-core/request-policy.ts");
    const payload = openaiPayload({
      max_output_tokens: 4096,
      reasoning: { effort: "low" },
    });

    const result = applyMmrRequestPolicy(payload, MMR_REQUEST_POLICIES.deep, { providerId: "openai-codex" });

    assert.equal("max_output_tokens" in result, false, "openai-codex rejects max_output_tokens even when the payload lacks Codex-only markers");
    assert.deepEqual(result.reasoning, { effort: "medium", summary: "auto" });
  });

  it("leaves free mode and unknown provider payloads untouched", async () => {
    const { applyMmrRequestPolicy, MMR_REQUEST_POLICIES } = await importSource("extensions/mmr-core/request-policy.ts");
    const payload = { model: "future-provider-model", data: { prompt: "hi" } };

    assert.equal(applyMmrRequestPolicy(payload, undefined), payload);
    assert.equal(applyMmrRequestPolicy(payload, MMR_REQUEST_POLICIES.smart), payload);
  });

  it("leaves lookalike custom/chat payloads untouched unless provider-shape markers are present", async () => {
    const { applyMmrRequestPolicy, MMR_REQUEST_POLICIES } = await importSource("extensions/mmr-core/request-policy.ts");
    const openAiChatLikePayload = {
      model: "gpt-4.1",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 4096,
      stream: true,
    };
    const customInputPayload = {
      model: "future-provider-model",
      input: [{ role: "user", content: "hi" }],
      stream: true,
    };
    const bodyBetaOnlyPayload = {
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 4096,
      anthropic_beta: ["interleaved-thinking-2025-05-14"],
    };

    assert.equal(applyMmrRequestPolicy(openAiChatLikePayload, MMR_REQUEST_POLICIES.smart), openAiChatLikePayload);
    assert.equal(applyMmrRequestPolicy(customInputPayload, MMR_REQUEST_POLICIES.deep), customInputPayload);
    assert.equal(applyMmrRequestPolicy(bodyBetaOnlyPayload, MMR_REQUEST_POLICIES.smart), bodyBetaOnlyPayload);
  });

  it("drops stray body-level anthropic_beta from matched Anthropic Messages payloads", async () => {
    const { applyMmrRequestPolicy, MMR_REQUEST_POLICIES } = await importSource("extensions/mmr-core/request-policy.ts");
    const payload = {
      ...anthropicPayload(),
      anthropic_beta: ["interleaved-thinking-2025-05-14"],
    };

    const result = applyMmrRequestPolicy(payload, MMR_REQUEST_POLICIES.smart);

    assert.equal("anthropic_beta" in result, false);
    assert.equal("anthropic_beta" in payload, true, "original payload is not mutated");
  });

  it("does not write runtime-only effectiveMaxInputTokens into provider payloads", async () => {
    const { applyMmrRequestPolicy, MMR_REQUEST_POLICIES } = await importSource("extensions/mmr-core/request-policy.ts");
    const payload = anthropicPayload();

    const result = applyMmrRequestPolicy(payload, MMR_REQUEST_POLICIES.smart);

    assert.equal("effectiveMaxInputTokens" in result, false);
    assert.equal("contextWindow" in result, false);
    assert.equal(MMR_REQUEST_POLICIES.smart.contextWindow, 1000000);
    assert.equal(MMR_REQUEST_POLICIES.smart.effectiveMaxInputTokens, 968000);
  });

  it("carries per-mode context triples and clamps smart's input profile to smaller provider registrations", async () => {
    const { clampPolicyToRegisteredModel, MMR_REQUEST_POLICIES } = await importSource("extensions/mmr-core/request-policy.ts");

    assert.deepEqual(
      {
        contextWindow: MMR_REQUEST_POLICIES.rush.contextWindow,
        maxTokens: MMR_REQUEST_POLICIES.rush.openaiResponses.maxOutputTokens,
        maxInput: MMR_REQUEST_POLICIES.rush.effectiveMaxInputTokens,
      },
      { contextWindow: 400000, maxTokens: 128000, maxInput: 272000 },
    );

    const fullOpus = clampPolicyToRegisteredModel(MMR_REQUEST_POLICIES.smart, { contextWindow: 1_000_000, maxTokens: 128_000 });
    assert.equal(fullOpus.effectiveMaxInputTokens, 968000);
    assert.equal(fullOpus.contextWindow, 1000000);

    const smallCustomOpus = clampPolicyToRegisteredModel(MMR_REQUEST_POLICIES.smart, { contextWindow: 200_000, maxTokens: 32_000 });
    assert.equal(smallCustomOpus.effectiveMaxInputTokens, 168000);
    assert.equal(smallCustomOpus.contextWindow, 200000);

    const large = clampPolicyToRegisteredModel(MMR_REQUEST_POLICIES.large, { contextWindow: 1_000_000, maxTokens: 32_000 });
    assert.equal(large.effectiveMaxInputTokens, 968000);
    assert.equal(large.contextWindow, 1000000);
  });
});

describe("mmr-core thinking-level toggle", () => {
  it("identifies the toggleable modes and their default levels", async () => {
    const { isToggleableMmrMode, getDefaultToggleThinkingLevel, getMmrModeThinkingOptions } =
      await importSource("extensions/mmr-core/request-policy.ts");

    for (const mode of ["smart", "smartGPT", "deep"]) {
      assert.equal(isToggleableMmrMode(mode), true, `${mode} should be toggleable`);
      assert.equal(getDefaultToggleThinkingLevel(mode), "medium");
    }
    for (const mode of ["rush", "large", "free"]) {
      assert.equal(isToggleableMmrMode(mode), false, `${mode} should not be toggleable`);
    }

    assert.deepEqual(getMmrModeThinkingOptions("smart"), [{ level: "medium", anthropicEffort: "high" }, { level: "high", anthropicEffort: "xhigh" }]);
    assert.deepEqual(getMmrModeThinkingOptions("smartGPT"), [{ level: "medium" }, { level: "xhigh" }]);
    assert.deepEqual(getMmrModeThinkingOptions("deep"), [{ level: "medium" }, { level: "xhigh" }]);
  });

  it("alternates between the two configured levels", async () => {
    const { getOtherToggleThinkingLevel } = await importSource("extensions/mmr-core/request-policy.ts");

    assert.equal(getOtherToggleThinkingLevel("smart", "medium"), "high");
    assert.equal(getOtherToggleThinkingLevel("smart", "high"), "medium");
    // Unrecognized/undefined current level lands on the non-default preset.
    assert.equal(getOtherToggleThinkingLevel("smart", undefined), "high");
    assert.equal(getOtherToggleThinkingLevel("smartGPT", "medium"), "xhigh");
    assert.equal(getOtherToggleThinkingLevel("deep", "xhigh"), "medium");
  });

  it("maps Smart high to Anthropic xhigh effort while keeping the 32k output default, without mutating the source", async () => {
    const { applyMmrThinkingLevelToPolicy, MMR_REQUEST_POLICIES } =
      await importSource("extensions/mmr-core/request-policy.ts");

    const smartHigh = applyMmrThinkingLevelToPolicy("smart", MMR_REQUEST_POLICIES.smart, "high");
    // Pi/session level is high; Anthropic adaptive effort is remapped to xhigh
    // (Pi high -> Anthropic xhigh on the Opus route), but the output budget
    // stays at the mode default 32k, so the displayed max input is unchanged.
    assert.equal(smartHigh.anthropic.maxTokens, 32000);
    assert.equal(smartHigh.anthropic.thinking.outputConfigEffort, "xhigh");
    assert.equal(smartHigh.effectiveMaxInputTokens, 968000);
    // OpenAI Responses effort tracks the Pi level (high), not the Anthropic remap.
    assert.equal(smartHigh.openaiResponses.reasoning.effort, "high");
    // Source policy stays at its 32k/high Anthropic default (pure transform).
    assert.equal(MMR_REQUEST_POLICIES.smart.anthropic.maxTokens, 32000);
    assert.equal(MMR_REQUEST_POLICIES.smart.anthropic.thinking.outputConfigEffort, "high");
    assert.equal(MMR_REQUEST_POLICIES.smart.effectiveMaxInputTokens, 968000);
    assert.equal(MMR_REQUEST_POLICIES.smart.openaiResponses.reasoning.effort, "medium");

    // Smart medium aligns to the Option-1 native map: Pi medium -> Anthropic
    // high (32k), while OpenAI Responses effort tracks the Pi level (medium).
    const smartMedium = applyMmrThinkingLevelToPolicy("smart", MMR_REQUEST_POLICIES.smart, "medium");
    assert.equal(smartMedium.anthropic.maxTokens, 32000);
    assert.equal(smartMedium.anthropic.thinking.outputConfigEffort, "high");
    assert.equal(smartMedium.openaiResponses.reasoning.effort, "medium");
    assert.equal(smartMedium.effectiveMaxInputTokens, 968000);

    const gptXhigh = applyMmrThinkingLevelToPolicy("smartGPT", MMR_REQUEST_POLICIES.smartGPT, "xhigh");
    assert.equal(gptXhigh.openaiResponses.reasoning.effort, "xhigh");
    assert.equal(gptXhigh.openaiResponses.maxOutputTokens, 128000);
    assert.equal(MMR_REQUEST_POLICIES.smartGPT.openaiResponses.reasoning.effort, "medium");
  });

  // Boundary-value parity pins for request-policy's compact token formatter,
  // exercised through its public surface (formatMmrPolicyContext renders
  // `<formatTokenCount(contextWindow)> total ...`). This format is
  // INTENTIONALLY DISTINCT from status.ts's footer formatter (Item 2:
  // keep-with-comments). It uses Number.isInteger gating + toFixed rather than
  // Math.round, so e.g. 12345 -> "12.3k" here vs "12k" in the footer. These
  // pins guard against an accidental unifying edit collapsing the two formats.
  it("formats request-policy token counts byte-for-byte across boundary values", async () => {
    const { formatMmrPolicyContext, MMR_REQUEST_POLICIES } = await importSource("extensions/mmr-core/request-policy.ts");
    const cases = [
      [999, "999"],
      [1000, "1k"],
      [1500, "1.5k"],
      [12345, "12.3k"],
      [999999, "1000.0k"],
      [1000000, "1M"],
      [1500000, "1.5M"],
      [9999999, "10.0M"],
      [10000000, "10M"],
    ];
    for (const [input, expected] of cases) {
      const rendered = formatMmrPolicyContext(MMR_REQUEST_POLICIES.smart, { contextWindow: input });
      assert.match(rendered, new RegExp(`^${expected.replace(/[.]/g, "\\.")} total`), `formatTokenCount(${input})`);
    }
  });
});
