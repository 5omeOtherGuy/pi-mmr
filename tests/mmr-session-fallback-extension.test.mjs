import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const FAILING_MODEL = { provider: "claude-subscription", id: "claude-opus-4-8", reasoning: true };
const FALLBACK_MODEL = { provider: "anthropic", id: "claude-opus-4-6", reasoning: true };
const OTHER_MODEL = { provider: "openai", id: "gpt-5.5", reasoning: true };

function lockedSmartState(overrides = {}) {
  return {
    mode: "smart",
    displayName: "Smart",
    source: "command",
    targetModel: "claude-opus-4-8",
    requestedModels: ["claude-opus-4-8", "gpt-5.5"],
    provider: "claude-subscription",
    model: "claude-opus-4-8",
    modelFound: true,
    modelApplied: true,
    modelFallbackApplied: false,
    modelCandidates: [],
    thinkingLevel: "high",
    promptRoute: "default",
    requestedTools: ["Read"],
    activeTools: ["read"],
    missingTools: [],
    deferredTools: [],
    gatedTools: [],
    disabledTools: [],
    featureGates: [],
    availabilityNotes: [],
    appliedAt: "2026-05-26T00:00:00.000Z",
    version: 1,
    resolution: {
      selectedSource: "command",
      rejectedSources: [],
      modelDecision: { fallbackApplied: false },
      toolDecisions: [],
      featureGateDecisions: [],
    },
    ...overrides,
  };
}

async function loadRuntime() {
  return importSource("extensions/mmr-core/runtime.ts");
}

beforeEach(async () => {
  const runtime = await loadRuntime();
  runtime.setMmrModeState(undefined);
  runtime.setMmrSubagentState(undefined);
  const fallbackRuntime = await importSource("extensions/mmr-session-fallback/runtime.ts");
  fallbackRuntime.clearMmrSessionFallbackOverrides();
});

describe("mmr-session-fallback extension", () => {
  it("prompts for a model and thinking level, applies the selection, persists it, and returns a retryable message", async () => {
    const extension = (await importSource("extensions/mmr-session-fallback/index.ts")).default;
    const runtime = await loadRuntime();
    runtime.setMmrModeState(lockedSmartState());

    const { pi, calls, handlers } = createMockPi();
    const { ctx, selectCalls } = createMockExtensionContext({
      sessionId: "session-1",
      models: [FAILING_MODEL, FALLBACK_MODEL, OTHER_MODEL],
      model: FAILING_MODEL,
    });
    ctx.ui.select = async (title, options) => {
      selectCalls.push({ title, options });
      if (/fallback model/i.test(title)) return options.find((option) => option.includes("anthropic/claude-opus-4-6"));
      if (/thinking/i.test(title)) return options.find((option) => option.startsWith("high"));
      return undefined;
    };
    extension(pi);

    const result = await handlers.get("message_end")({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "rate_limit_error: HTTP 429",
      },
    }, ctx);

    assert.equal(calls.setModel.length, 1);
    assert.deepEqual(calls.setModel[0], FALLBACK_MODEL);
    assert.deepEqual(calls.setThinkingLevel, ["high"]);
    assert.equal(calls.appendEntry.length, 1);
    assert.equal(calls.appendEntry[0][0], "mmr-session-fallback.override");
    assert.equal(calls.appendEntry[0][1].selectedProvider, "anthropic");
    assert.equal(calls.appendEntry[0][1].selectedModel, "claude-opus-4-6");
    assert.equal(runtime.getMmrModeState()?.provider, "anthropic");
    assert.equal(runtime.getMmrModeState()?.model, "claude-opus-4-6");
    assert.equal(runtime.getMmrManagedModelOverride()?.model, "claude-opus-4-6");
    assert.equal(result.message.role, "assistant");
    assert.equal(result.message.stopReason, "error");
    assert.match(result.message.errorMessage, /rate limit/i);
    assert.match(result.message.errorMessage, /anthropic\/claude-opus-4-6/);
    assert.equal(selectCalls.length, 2);
  });

  it("offers a fallback for minimalcc-pi silent 200 stream capacity stalls", async () => {
    const extension = (await importSource("extensions/mmr-session-fallback/index.ts")).default;
    const runtime = await loadRuntime();
    runtime.setMmrModeState(lockedSmartState());

    const { pi, calls, handlers } = createMockPi();
    const { ctx, selectCalls } = createMockExtensionContext({
      sessionId: "session-1",
      models: [FAILING_MODEL, FALLBACK_MODEL, OTHER_MODEL],
      model: FAILING_MODEL,
    });
    ctx.ui.select = async (title, options) => {
      selectCalls.push({ title, options });
      if (/fallback model/i.test(title)) return options.find((option) => option.includes("anthropic/claude-opus-4-6"));
      if (/thinking/i.test(title)) return options.find((option) => option.startsWith("high"));
      return undefined;
    };
    extension(pi);

    const result = await handlers.get("message_end")({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "Anthropic Messages API stream made no progress for 45000ms [status=200; request_id=req_x; last_event=toolUseInputDelta; saw_message_stop=false; upstream_capacity_signal=silent_200_stream; retryable=true]",
      },
    }, ctx);

    assert.equal(calls.setModel.length, 1);
    assert.deepEqual(calls.setModel[0], FALLBACK_MODEL);
    assert.deepEqual(calls.setThinkingLevel, ["high"]);
    assert.equal(calls.appendEntry[0][1].reasonKind, "anthropic-overload");
    assert.match(result.message.errorMessage, /upstream capacity|overload/i);
    assert.equal(selectCalls.length, 2);
  });

  it("leaves the provider error unchanged when the user cancels", async () => {
    const extension = (await importSource("extensions/mmr-session-fallback/index.ts")).default;
    const runtime = await loadRuntime();
    runtime.setMmrModeState(lockedSmartState());
    const { pi, calls, handlers } = createMockPi();
    const { ctx } = createMockExtensionContext({ sessionId: "session-1", models: [FAILING_MODEL, FALLBACK_MODEL] });
    extension(pi);

    const result = await handlers.get("message_end")({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: "rate_limit_error: HTTP 429" },
    }, ctx);

    assert.equal(result, undefined);
    assert.deepEqual(calls.setModel, []);
    assert.deepEqual(calls.setThinkingLevel, []);
    assert.deepEqual(calls.appendEntry, []);
  });

  it("does not prompt in Free mode, subagent workers, or sessions that already chose a fallback", async () => {
    const extension = (await importSource("extensions/mmr-session-fallback/index.ts")).default;
    const runtime = await loadRuntime();
    const fallbackRuntime = await importSource("extensions/mmr-session-fallback/runtime.ts");
    const { pi, calls, handlers } = createMockPi();
    const { ctx, selectCalls } = createMockExtensionContext({ sessionId: "session-1", models: [FAILING_MODEL, FALLBACK_MODEL] });
    ctx.ui.select = async (title, options) => {
      selectCalls.push({ title, options });
      return options[0];
    };
    extension(pi);
    const event = {
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: "rate_limit_error: HTTP 429" },
    };

    runtime.setMmrModeState(lockedSmartState({ mode: "free" }));
    assert.equal(await handlers.get("message_end")(event, ctx), undefined);

    runtime.setMmrModeState(lockedSmartState());
    runtime.setMmrSubagentState({
      profile: "finder",
      provider: "google",
      model: "gemini-3.5-flash",
      promptRoute: "standalone",
      activeTools: ["grep"],
      activatedAt: "2026-05-26T00:00:00.000Z",
    });
    assert.equal(await handlers.get("message_end")(event, ctx), undefined);

    runtime.setMmrSubagentState(undefined);
    fallbackRuntime.setMmrSessionFallbackOverride("session-1", {
      version: 1,
      sessionId: "session-1",
      mode: "smart",
      failingProvider: "claude-subscription",
      failingModel: "claude-opus-4-8",
      selectedProvider: "anthropic",
      selectedModel: "claude-opus-4-6",
      thinkingLevel: "high",
      reasonKind: "anthropic-rate-limit",
      appliedAt: "2026-05-26T00:00:00.000Z",
    });
    assert.equal(await handlers.get("message_end")(event, ctx), undefined);

    assert.deepEqual(calls.setModel, []);
    assert.equal(selectCalls.length, 0);
  });

  it("clears runtime and persisted fallback when the user changes model or thinking", async () => {
    const extension = (await importSource("extensions/mmr-session-fallback/index.ts")).default;
    const runtime = await loadRuntime();
    const fallbackRuntime = await importSource("extensions/mmr-session-fallback/runtime.ts");
    const { pi, calls, handlers } = createMockPi();
    const { ctx } = createMockExtensionContext({ sessionId: "session-1", models: [FAILING_MODEL, FALLBACK_MODEL] });
    fallbackRuntime.setMmrSessionFallbackOverride("session-1", {
      version: 1,
      sessionId: "session-1",
      mode: "smart",
      failingProvider: "claude-subscription",
      failingModel: "claude-opus-4-8",
      selectedProvider: "anthropic",
      selectedModel: "claude-opus-4-6",
      thinkingLevel: "high",
      reasonKind: "anthropic-rate-limit",
      appliedAt: "2026-05-26T00:00:00.000Z",
    });
    runtime.setMmrManagedModelOverride({ kind: "session-fallback", provider: "anthropic", model: "claude-opus-4-6", thinkingLevel: "high", appliedAt: "2026-05-26T00:00:00.000Z" });
    extension(pi);

    handlers.get("thinking_level_select")({ type: "thinking_level_select", level: "low", previousLevel: "high" }, ctx);

    assert.equal(fallbackRuntime.getMmrSessionFallbackOverrideSnapshot("session-1"), undefined);
    assert.equal(runtime.getMmrManagedModelOverride(), undefined);
    assert.equal(calls.appendEntry.at(-1)?.[0], "mmr-session-fallback.override");
    assert.equal(calls.appendEntry.at(-1)?.[1].cleared, true);
  });

  it("rehydrates an override on resume and clears it for a new session", async () => {
    const extension = (await importSource("extensions/mmr-session-fallback/index.ts")).default;
    const runtime = await loadRuntime();
    runtime.setMmrModeState(lockedSmartState());
    const { MMR_SESSION_FALLBACK_ENTRY, toPersistedMmrSessionFallbackOverride } = await importSource("extensions/mmr-session-fallback/state.ts");
    const persisted = toPersistedMmrSessionFallbackOverride({
      sessionId: "session-1",
      mode: "smart",
      failingProvider: "claude-subscription",
      failingModel: "claude-opus-4-8",
      selectedProvider: "anthropic",
      selectedModel: "claude-opus-4-6",
      thinkingLevel: "medium",
      reasonKind: "anthropic-rate-limit",
      appliedAt: "2026-05-26T00:00:00.000Z",
    });
    const { pi, calls, handlers } = createMockPi();
    const { ctx, entries } = createMockExtensionContext({ sessionId: "session-1", models: [FAILING_MODEL, FALLBACK_MODEL] });
    entries.push({ type: "custom", customType: MMR_SESSION_FALLBACK_ENTRY, data: persisted });
    extension(pi);

    await handlers.get("session_start")({ type: "session_start", reason: "resume" }, ctx);

    assert.deepEqual(calls.setModel, [FALLBACK_MODEL]);
    assert.deepEqual(calls.setThinkingLevel, ["medium"]);
    assert.equal(runtime.getMmrModeState()?.provider, "anthropic");
    assert.equal(runtime.getMmrManagedModelOverride()?.model, "claude-opus-4-6");

    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);
    const fallbackRuntime = await importSource("extensions/mmr-session-fallback/runtime.ts");
    assert.equal(fallbackRuntime.getMmrSessionFallbackOverrideSnapshot("session-1"), undefined);
    assert.equal(runtime.getMmrManagedModelOverride(), undefined);
  });

  it("sets promptInFlight while a prompt runs and clears it after the prompt settles", async () => {
    const extension = (await importSource("extensions/mmr-session-fallback/index.ts")).default;
    const runtime = await loadRuntime();
    const fallbackRuntime = await importSource("extensions/mmr-session-fallback/runtime.ts");
    runtime.setMmrModeState(lockedSmartState());
    const { pi, handlers } = createMockPi();
    const { ctx, selectCalls } = createMockExtensionContext({
      sessionId: "session-1",
      models: [FAILING_MODEL, FALLBACK_MODEL, OTHER_MODEL],
      model: FAILING_MODEL,
    });

    // Block the first (model) selection on a controllable deferred so the
    // handler is mid-prompt when we assert the in-flight guard.
    let releaseSelect;
    const selectGate = new Promise((resolve) => { releaseSelect = resolve; });
    ctx.ui.select = async (title, options) => {
      selectCalls.push({ title });
      if (/fallback model/i.test(title)) {
        await selectGate;
        return undefined; // cancel after release so the handler unwinds cleanly
      }
      return undefined;
    };
    extension(pi);

    const event = {
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: "rate_limit_error: HTTP 429" },
    };
    const handlerPromise = handlers.get("message_end")(event, ctx);
    await Promise.resolve();

    assert.ok(fallbackRuntime.getMmrSessionFallbackPromptInFlight(), "promptInFlight is set while the prompt runs");

    // Concurrent message-end while in flight is dropped without a second prompt.
    const selectsBefore = selectCalls.length;
    const concurrent = await handlers.get("message_end")(event, ctx);
    assert.equal(concurrent, undefined, "concurrent message-end is dropped while a prompt is in flight");
    assert.equal(selectCalls.length, selectsBefore, "the in-flight guard prevents a second prompt");

    releaseSelect();
    await handlerPromise;
    assert.equal(fallbackRuntime.getMmrSessionFallbackPromptInFlight(), undefined, "finally clears promptInFlight");
  });

  it("clears promptInFlight when the prompt rejects", async () => {
    const extension = (await importSource("extensions/mmr-session-fallback/index.ts")).default;
    const runtime = await loadRuntime();
    const fallbackRuntime = await importSource("extensions/mmr-session-fallback/runtime.ts");
    runtime.setMmrModeState(lockedSmartState());
    const { pi, handlers } = createMockPi();
    const notifications = [];
    const { ctx } = createMockExtensionContext({
      sessionId: "session-1",
      models: [FAILING_MODEL, FALLBACK_MODEL, OTHER_MODEL],
      model: FAILING_MODEL,
    });
    ctx.ui.notify = (message, level) => { notifications.push({ message, level }); };
    ctx.ui.select = async (title) => {
      if (/fallback model/i.test(title)) throw new Error("select boom");
      return undefined;
    };
    extension(pi);

    const result = await handlers.get("message_end")({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: "rate_limit_error: HTTP 429" },
    }, ctx);

    assert.equal(result, undefined, "a rejected prompt returns undefined");
    assert.equal(notifications.at(-1)?.level, "error", "a rejected prompt notifies an error");
    assert.equal(fallbackRuntime.getMmrSessionFallbackPromptInFlight(), undefined, "finally clears promptInFlight on the error path");
  });

  it("does not rehydrate stale overrides for a different current mode route", async () => {
    const extension = (await importSource("extensions/mmr-session-fallback/index.ts")).default;
    const runtime = await loadRuntime();
    runtime.setMmrModeState(lockedSmartState({ provider: "openai-codex", model: "gpt-5.5" }));
    const { MMR_SESSION_FALLBACK_ENTRY, toPersistedMmrSessionFallbackOverride } = await importSource("extensions/mmr-session-fallback/state.ts");
    const persisted = toPersistedMmrSessionFallbackOverride({
      sessionId: "session-1",
      mode: "smart",
      failingProvider: "claude-subscription",
      failingModel: "claude-opus-4-8",
      selectedProvider: "anthropic",
      selectedModel: "claude-opus-4-6",
      thinkingLevel: "medium",
      reasonKind: "anthropic-rate-limit",
      appliedAt: "2026-05-26T00:00:00.000Z",
    });
    const { pi, calls, handlers } = createMockPi();
    const { ctx, entries } = createMockExtensionContext({ sessionId: "session-1", models: [FAILING_MODEL, FALLBACK_MODEL] });
    entries.push({ type: "custom", customType: MMR_SESSION_FALLBACK_ENTRY, data: persisted });
    extension(pi);

    await handlers.get("session_start")({ type: "session_start", reason: "resume" }, ctx);

    assert.deepEqual(calls.setModel, []);
    assert.equal(runtime.getMmrManagedModelOverride(), undefined);
  });
});
