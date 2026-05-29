import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, getPreparedSourceRoot, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const SMART_MODEL = { provider: "claude-subscription", id: "claude-opus-4-8", contextWindow: 1_000_000, maxTokens: 128_000 };
const RUSH_MODEL = { provider: "openai-codex", id: "gpt-5.5", contextWindow: 400_000, maxTokens: 128_000 };
const DEEP_MODEL = { provider: "openai-codex", id: "gpt-5.5", contextWindow: 400_000, maxTokens: 128_000 };

function createContext(models = [SMART_MODEL]) {
  return createMockExtensionContext({ models, hasUI: false, model: models[0] });
}

function createPi(options = {}) {
  return createMockPi({
    activeTools: ["read", "bash", "grep"],
    allTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    thinkingLevel: "medium",
    initialModel: options.model,
  });
}

async function importRuntime() {
  const runtimeUrl = pathToFileURL(path.join(getPreparedSourceRoot(), "extensions/mmr-core/runtime.ts")).href;
  return import(runtimeUrl);
}

beforeEach(async () => {
  const runtime = await importRuntime();
  runtime.setMmrModeState(undefined);
  runtime.clearMmrManagedModelOverride();
});

describe("mmr-core before_provider_request hook", () => {
  it("applies the active locked-mode request policy to Anthropic payloads and leaves system blocks intact", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const { ctx } = createContext([SMART_MODEL]);
    const { pi, handlers } = createPi({ model: SMART_MODEL });
    extension(pi);

    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);

    const payload = {
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      system: [{ type: "text", text: "minimalcc shaped system" }],
      max_tokens: 4096,
    };
    const result = await handlers.get("before_provider_request")({ type: "before_provider_request", payload }, ctx);

    assert.equal(result.max_tokens, 32000);
    assert.deepEqual(result.thinking, { type: "adaptive", display: "summarized" });
    assert.deepEqual(result.output_config, { effort: "medium" });
    assert.deepEqual(result.system, payload.system);
    assert.deepEqual(payload.thinking, undefined, "original payload is not mutated");
  });

  it("emits Anthropic xhigh effort + 64k max_tokens on the wire after the Smart high (alt+r) toggle", async () => {
    // End-to-end wire proof for Smart high under the native Opus 4.8 Option-1
    // map (Pi high -> Anthropic xhigh). The toggle sets Pi thinking level
    // "high"; the before_provider_request hook pins Anthropic effort "xhigh"
    // and max_tokens 64000, matching what minimalcc's own level map would
    // independently produce for Pi "high".
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const { ctx } = createContext([SMART_MODEL]);
    const { pi, handlers, shortcuts } = createPi({ model: SMART_MODEL });
    extension(pi);

    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);
    // Flip Smart medium -> high via the MMR-owned shortcut.
    await shortcuts.get("alt+r").handler(ctx);

    const payload = {
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      system: [{ type: "text", text: "minimalcc shaped system" }],
      max_tokens: 4096,
    };
    const result = await handlers.get("before_provider_request")({ type: "before_provider_request", payload }, ctx);

    assert.equal(result.max_tokens, 64000);
    assert.deepEqual(result.thinking, { type: "adaptive", display: "summarized" });
    assert.deepEqual(result.output_config, { effort: "xhigh" });
    assert.deepEqual(result.system, payload.system);
  });

  it("managed model overrides disable locked-mode request-policy rewriting", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await importRuntime();
    const { ctx } = createContext([SMART_MODEL]);
    const { pi, handlers } = createPi({ model: SMART_MODEL });
    extension(pi);

    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);
    runtime.setMmrManagedModelOverride({
      kind: "session-fallback",
      provider: "anthropic",
      model: "claude-opus-4-6",
      thinkingLevel: "low",
      appliedAt: "2026-05-26T00:00:00.000Z",
    });

    const payload = {
      model: "claude-opus-4-6",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      system: [{ type: "text", text: "minimalcc shaped system" }],
      max_tokens: 4096,
    };
    const result = await handlers.get("before_provider_request")({ type: "before_provider_request", payload }, ctx);

    assert.equal(result, undefined);
    assert.deepEqual(payload, {
      model: "claude-opus-4-6",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      system: [{ type: "text", text: "minimalcc shaped system" }],
      max_tokens: 4096,
    });
  });

  it("switching to free disables request-policy rewriting", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const { ctx } = createContext([SMART_MODEL]);
    const { pi, commands, handlers } = createPi({ model: SMART_MODEL });
    extension(pi);

    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);
    await commands.get("mode").handler("free", ctx);

    const payload = { model: "claude-opus-4-8", messages: [], max_tokens: 4096 };
    const result = await handlers.get("before_provider_request")({ type: "before_provider_request", payload }, ctx);

    assert.equal(result, undefined);
    assert.deepEqual(payload, { model: "claude-opus-4-8", messages: [], max_tokens: 4096 });
  });

  it("rush mode applies OpenAI Responses max output and no-thinking effort", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const { ctx } = createContext([RUSH_MODEL]);
    const { pi, commands, handlers } = createPi({ model: RUSH_MODEL });
    extension(pi);

    await commands.get("mode").handler("rush", ctx);

    const payload = { model: "gpt-5.5", input: [], stream: true, instructions: "system", text: { verbosity: "low" }, max_output_tokens: 4096, reasoning: { effort: "medium" } };
    const result = await handlers.get("before_provider_request")({ type: "before_provider_request", payload }, ctx);

    assert.equal("max_output_tokens" in result, false, "Codex-backed Responses payloads must not carry max_output_tokens");
    assert.deepEqual(result.reasoning, { effort: "none" });
  });

  it("deep mode strips max output while keeping reasoning for openai-codex payloads without Codex markers", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const { ctx } = createContext([DEEP_MODEL]);
    const { pi, commands, handlers } = createPi({ model: DEEP_MODEL });
    extension(pi);

    await commands.get("mode").handler("deep", ctx);

    const payload = { model: "gpt-5.5", input: [], stream: true, max_output_tokens: 4096 };
    const result = await handlers.get("before_provider_request")({ type: "before_provider_request", payload }, ctx);

    assert.equal("max_output_tokens" in result, false, "openai-codex rejects max_output_tokens even when Pi omits Codex-only payload markers");
    assert.deepEqual(result.reasoning, { effort: "medium", summary: "auto" });
  });
});
