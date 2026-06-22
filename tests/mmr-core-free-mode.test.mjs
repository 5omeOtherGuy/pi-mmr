import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, getPreparedSourceRoot, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const SMART_MODEL = { provider: "claude-subscription", id: "claude-opus-4-8" };
const RUSH_MODEL = { provider: "claude-subscription", id: "claude-haiku-4-5" };
const FREE_MODEL = { provider: "openai", id: "gpt-5.4" };

function createLockedState(overrides = {}) {
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
    thinkingLevel: "medium",
    promptRoute: "default",
    requestedTools: ["Read", "Bash"],
    activeTools: ["read", "bash"],
    missingTools: [],
    deferredTools: [],
    featureGates: [],
    availabilityNotes: [],
    appliedAt: "2026-05-08T00:00:00.000Z",
    ...overrides,
  };
}

function createContext(models = [SMART_MODEL], options = {}) {
  return createMockExtensionContext({ models, model: options.model });
}

function createPi(options = {}) {
  const onModelSet = options.emitInternalEvents
    ? async (model, { handlers, eventContext }) => {
        if (!eventContext) return;
        const thinkingHandler = handlers.get("thinking_level_select");
        if (thinkingHandler) await thinkingHandler({ type: "thinking_level_select", level: "medium", previousLevel: "high" }, eventContext);
        const modelHandler = handlers.get("model_select");
        if (modelHandler) await modelHandler({ type: "model_select", model, previousModel: undefined, source: "set" }, eventContext);
      }
    : undefined;
  const onThinkingLevelSet = options.emitInternalEvents
    ? (level, { handlers, eventContext }) => {
        if (!eventContext) return;
        const thinkingHandler = handlers.get("thinking_level_select");
        void thinkingHandler?.({ type: "thinking_level_select", level, previousLevel: "off" }, eventContext);
      }
    : undefined;
  return createMockPi({
    activeTools: options.activeTools ?? ["read", "bash", "grep"],
    allTools: options.allTools ?? ["read", "bash", "edit", "write", "grep", "find", "ls"],
    thinkingLevel: options.thinkingLevel ?? "off",
    flagValue: options.flagValue,
    setModelResult: options.setModelResult ?? true,
    onModelSet,
    onThinkingLevelSet,
  });
}

async function importRuntime() {
  const runtimeUrl = pathToFileURL(path.join(getPreparedSourceRoot(), "extensions/mmr-core/runtime.ts")).href;
  return import(runtimeUrl);
}

beforeEach(async () => {
  const runtime = await importRuntime();
  runtime.setMmrModeState(undefined);
});

describe("mmr-core free mode", () => {
  it("/mode open activates Smart-equivalent tools without model, thinking, request, or prompt policy", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await importRuntime();
    runtime.setMmrModeState(createLockedState());
    const openTools = ["read", "bash", "write", "edit", "web_search", "read_web_page", "read_session", "find_session", "Task", "task_list", "finder", "code_review"];
    const { ctx } = createContext([SMART_MODEL], { model: FREE_MODEL });
    const { pi, calls, commands, handlers } = createPi({ activeTools: ["read", "bash", "web_search"], allTools: openTools, thinkingLevel: "high" });
    extension(pi);

    await commands.get("mode").handler("open", ctx);

    const state = runtime.getMmrModeState();
    assert.equal(state?.mode, "open");
    assert.equal(state?.modelApplied, false);
    assert.deepEqual(state?.requestedModels, []);
    assert.equal(state?.provider, "");
    assert.equal(state?.model, "");
    assert.equal(state?.thinkingLevel, undefined);
    assert.equal(state?.effectiveContextWindow, undefined);
    assert.deepEqual(state?.activeTools, openTools);
    assert.deepEqual(calls.setActiveTools, [openTools]);
    assert.deepEqual(calls.setModel, []);
    assert.deepEqual(calls.setThinkingLevel, []);
    assert.equal(calls.appendEntry.at(-1)?.[1].mode, "open");

    const payload = { model: "claude-opus-4-8", messages: [], max_tokens: 4096 };
    const requestResult = await handlers.get("before_provider_request")({ type: "before_provider_request", payload }, ctx);
    assert.equal(requestResult, undefined);
    assert.deepEqual(payload, { model: "claude-opus-4-8", messages: [], max_tokens: 4096 });

    const promptResult = await handlers.get("before_agent_start")({ systemPrompt: "BASE", systemPromptOptions: { selectedTools: openTools } });
    assert.equal(promptResult, undefined);
  });

  it("native model/thinking changes keep open active because controls are Pi-native", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await importRuntime();
    const openTools = ["read", "bash", "write", "edit", "Task", "task_list"];
    const { ctx, notifications } = createContext([SMART_MODEL, FREE_MODEL], { model: FREE_MODEL });
    const { pi, calls, commands, handlers } = createPi({ activeTools: ["read", "bash"], allTools: openTools, thinkingLevel: "medium" });
    extension(pi);

    await commands.get("mode").handler("open", ctx);
    calls.setActiveTools.length = 0;
    calls.appendEntry.length = 0;
    notifications.length = 0;

    await handlers.get("model_select")({ type: "model_select", model: FREE_MODEL, previousModel: SMART_MODEL, source: "cycle" }, ctx);
    await handlers.get("thinking_level_select")({ type: "thinking_level_select", level: "high", previousLevel: "medium" }, ctx);

    assert.equal(runtime.getMmrModeState()?.mode, "open");
    assert.deepEqual(calls.setActiveTools, []);
    assert.deepEqual(calls.setModel, []);
    assert.deepEqual(calls.setThinkingLevel, []);
    assert.deepEqual(calls.appendEntry, []);
    assert.equal(notifications.some((notification) => /switched to Free mode/.test(notification.message)), false);
  });

  it("/mode free restores baseline tools, persists free, and leaves model/thinking untouched", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await importRuntime();
    runtime.setMmrModeState(createLockedState());
    const { ctx, notifications } = createContext();
    const { pi, calls, commands } = createPi({ activeTools: ["read", "bash", "grep"] });
    extension(pi);

    await commands.get("mode").handler("free", ctx);

    const state = runtime.getMmrModeState();
    assert.equal(state?.mode, "free");
    assert.equal(state?.modelApplied, false);
    assert.deepEqual(state?.activeTools, ["read", "bash", "grep"]);
    assert.deepEqual(calls.setActiveTools, [["read", "bash", "grep"]]);
    assert.deepEqual(calls.setModel, []);
    assert.deepEqual(calls.setThinkingLevel, []);
    assert.equal(calls.appendEntry.length, 1);
    assert.equal(calls.appendEntry[0][0], "mmr-core.mode-state");
    assert.equal(calls.appendEntry[0][1].mode, "free");
    assert.match(notifications.at(-1)?.message, /Free mode activated/i);
  });

  it("/mode free restores the model, thinking level, and tools captured before MMR activation", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await importRuntime();
    runtime.setMmrModeState(undefined);
    const { ctx } = createContext([SMART_MODEL, FREE_MODEL], { model: FREE_MODEL });
    const { pi, calls, commands, handlers } = createPi({ activeTools: ["read", "bash", "grep"], thinkingLevel: "medium" });
    extension(pi);

    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);
    assert.equal(runtime.getMmrModeState()?.mode, "smart");
    calls.setActiveTools.length = 0;
    calls.setModel.length = 0;
    calls.setThinkingLevel.length = 0;
    calls.appendEntry.length = 0;

    await commands.get("mode").handler("free", ctx);

    assert.equal(runtime.getMmrModeState()?.mode, "free");
    assert.deepEqual(calls.setActiveTools, [["read", "bash", "grep"]]);
    assert.deepEqual(calls.setModel, [FREE_MODEL]);
    assert.deepEqual(calls.setThinkingLevel, ["medium"]);
    assert.equal(calls.appendEntry.at(-1)?.[1].mode, "free");
  });

  it("free mode disables the MMR prompt layer and tool-call blocking", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await importRuntime();
    const { pi, handlers } = createPi();
    runtime.setMmrModeState(createLockedState({ mode: "free", displayName: "Free", modelApplied: false, provider: "", model: "", activeTools: ["read"] }));
    extension(pi);

    const promptResult = await handlers.get("before_agent_start")({ systemPrompt: "BASE", systemPromptOptions: {} });
    const toolResult = await handlers.get("tool_call")({ toolName: "write" });

    assert.equal(promptResult, undefined);
    assert.equal(toolResult, undefined);
  });

  it("switches to free with a warning when the user changes model while a locked mode is active", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await importRuntime();
    const { ctx, notifications } = createContext([SMART_MODEL]);
    const { pi, calls, handlers, setEventContext } = createPi({ activeTools: ["read", "bash", "grep"] });
    setEventContext(ctx);
    extension(pi);

    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);
    assert.equal(runtime.getMmrModeState()?.mode, "smart");
    calls.setActiveTools.length = 0;
    calls.setModel.length = 0;
    calls.setThinkingLevel.length = 0;
    calls.appendEntry.length = 0;
    notifications.length = 0;

    await handlers.get("model_select")({ type: "model_select", model: { provider: "openai-codex", id: "gpt-5.5" }, previousModel: SMART_MODEL, source: "cycle" }, ctx);

    assert.equal(runtime.getMmrModeState()?.mode, "free");
    assert.deepEqual(calls.setActiveTools, [["read", "bash", "grep"]]);
    assert.deepEqual(calls.setModel, []);
    assert.deepEqual(calls.setThinkingLevel, []);
    assert.equal(calls.appendEntry.at(-1)?.[1].mode, "free");
    assert.equal(calls.appendEntry.at(-1)?.[1].source, "native");
    assert.equal(notifications.at(-1)?.level, "warning");
    assert.match(notifications.at(-1)?.message, /MMR switched to Free mode because the Pi model\/thinking setting changed/);
    assert.match(notifications.at(-1)?.message, /Native Pi model\/thinking controls are active/);
    assert.match(notifications.at(-1)?.message, /MMR mode prompt is disabled/);
    assert.match(notifications.at(-1)?.message, /MMR tool allowlist is disabled/);
    assert.match(notifications.at(-1)?.message, /Standard Pi tools are restored/);
    assert.match(notifications.at(-1)?.message, /\/mode smart/);
  });

  it("switches to free with a warning when the user changes thinking while a locked mode is active", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await importRuntime();
    const { ctx, notifications } = createContext([SMART_MODEL]);
    const { pi, calls, handlers } = createPi({ activeTools: ["read", "bash", "grep"] });
    extension(pi);

    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);
    assert.equal(runtime.getMmrModeState()?.mode, "smart");
    calls.setActiveTools.length = 0;
    calls.setModel.length = 0;
    calls.setThinkingLevel.length = 0;
    calls.appendEntry.length = 0;
    notifications.length = 0;

    await handlers.get("thinking_level_select")({ type: "thinking_level_select", level: "high", previousLevel: "medium" }, ctx);

    assert.equal(runtime.getMmrModeState()?.mode, "free");
    assert.deepEqual(calls.setActiveTools, [["read", "bash", "grep"]]);
    assert.deepEqual(calls.setModel, []);
    assert.deepEqual(calls.setThinkingLevel, []);
    assert.equal(calls.appendEntry.at(-1)?.[1].mode, "free");
    assert.equal(notifications.at(-1)?.level, "warning");
    assert.match(notifications.at(-1)?.message, /MMR switched to Free mode/);
  });

  it("keeps persisted free mode on session start without model or thinking routing", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await importRuntime();
    const { ctx, entries, statuses, footers } = createContext([SMART_MODEL]);
    const { pi, calls, handlers } = createPi({ activeTools: ["read", "bash", "grep"] });
    entries.push({
      type: "custom",
      customType: "mmr-core.mode-state",
      data: { mode: "free", source: "command", provider: "", model: "", activeTools: ["read", "bash"], missingTools: [], deferredTools: [], appliedAt: "2026-05-08T00:00:00.000Z" },
    });
    extension(pi);

    await handlers.get("session_start")({ type: "session_start", reason: "resume" }, ctx);

    assert.equal(runtime.getMmrModeState()?.mode, "free");
    assert.deepEqual(calls.setActiveTools, [["read", "bash", "grep"]]);
    assert.deepEqual(calls.setModel, []);
    assert.deepEqual(calls.setThinkingLevel, []);
    assert.deepEqual(calls.appendEntry, []);
    assert.equal(statuses.at(-1)?.value, undefined);
    assert.equal(footers.at(-1), undefined);
  });

  it("does not switch to free for Pi restore model events", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await importRuntime();
    runtime.setMmrModeState(createLockedState());
    const { ctx, notifications } = createContext([SMART_MODEL]);
    const { pi, calls, handlers } = createPi();
    extension(pi);

    await handlers.get("model_select")({ type: "model_select", model: SMART_MODEL, previousModel: undefined, source: "restore" }, ctx);

    assert.equal(runtime.getMmrModeState()?.mode, "smart");
    assert.deepEqual(calls.setActiveTools, []);
    assert.deepEqual(calls.appendEntry, []);
    assert.deepEqual(notifications, []);
  });

  it("does not switch to free for managed model and thinking updates outside mode activation", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await importRuntime();
    runtime.setMmrModeState(createLockedState());
    const { ctx, notifications } = createContext([SMART_MODEL, FREE_MODEL]);
    const { pi, calls, handlers, setEventContext } = createPi({ emitInternalEvents: true });
    setEventContext(ctx);
    extension(pi);

    await runtime.runMmrManagedModelUpdate(async () => {
      await pi.setModel(FREE_MODEL);
      pi.setThinkingLevel("low");
    });

    assert.equal(runtime.getMmrModeState()?.mode, "smart");
    assert.deepEqual(calls.setModel, [FREE_MODEL]);
    assert.deepEqual(calls.setThinkingLevel, ["low"]);
    assert.deepEqual(calls.setActiveTools, []);
    assert.deepEqual(calls.appendEntry, []);
    assert.equal(notifications.some((notification) => /switched to Free mode/.test(notification.message)), false);
    assert.equal(handlers.has("model_select"), true);
    assert.equal(handlers.has("thinking_level_select"), true);
  });

  it("does not switch to free for MMR-initiated model and thinking changes", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await importRuntime();
    runtime.setMmrModeState(createLockedState());
    const { ctx, notifications } = createContext([RUSH_MODEL]);
    const { pi, calls, commands, setEventContext } = createPi({ emitInternalEvents: true });
    setEventContext(ctx);
    extension(pi);

    await commands.get("mode").handler("rush", ctx);

    assert.equal(runtime.getMmrModeState()?.mode, "rush");
    assert.deepEqual(calls.appendEntry.map((entry) => entry[1].mode), ["rush"]);
    assert.equal(notifications.some((notification) => /switched to Free mode/.test(notification.message)), false);
  });
});
