import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, getPreparedSourceRoot, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

function createContext(models = [], options = {}) {
  return createMockExtensionContext({ models, authenticated: Boolean(options.authenticated) });
}

function createPi(options = {}) {
  return createMockPi({
    activeTools: options.activeTools ?? ["read", "bash"],
    allTools: options.allTools ?? ["read", "bash"],
    setModelResult: options.setModelResult ?? false,
  });
}

async function importRuntime() {
  const runtimeUrl = pathToFileURL(path.join(getPreparedSourceRoot(), "extensions/mmr-core/runtime.ts")).href;
  return import(runtimeUrl);
}

describe("mmr-core mode activation", () => {
  it("fails clear and keeps previous mode state/tools when no deep model route is usable", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await importRuntime();
    const previousState = {
      mode: "smart",
      displayName: "Smart",
      source: "command",
      targetModel: "claude-opus-4-8",
      requestedModels: ["claude-opus-4-8"],
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
      featureGates: [],
      availabilityNotes: [],
      appliedAt: "2026-05-08T00:00:00.000Z",
    };
    runtime.setMmrModeState(previousState);

    const { pi, calls, commands } = createPi();
    const { ctx, notifications } = createContext();
    extension(pi);

    await commands.get("mode").handler("deep", ctx);

    assert.equal(runtime.getMmrModeState(), previousState);
    assert.deepEqual(calls.setActiveTools, []);
    assert.deepEqual(calls.setThinkingLevel, []);
    assert.deepEqual(calls.appendEntry, []);
    assert.equal(notifications.at(-1)?.level, "error");
    assert.match(notifications.at(-1)?.message, /Could not activate Deep mode/);
    assert.match(notifications.at(-1)?.message, /gpt-5\.5/);
    assert.match(notifications.at(-1)?.message, /claude-opus-4-8/);
    assert.doesNotMatch(notifications.at(-1)?.message, /gpt-5\.4/);
  });

  it("fails closed and keeps previous state/tools/model when no active tools resolve", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await importRuntime();
    const previousState = {
      mode: "smart",
      displayName: "Smart",
      source: "command",
      targetModel: "claude-opus-4-8",
      requestedModels: ["claude-opus-4-8"],
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
      featureGates: [],
      availabilityNotes: [],
      appliedAt: "2026-05-08T00:00:00.000Z",
    };
    runtime.setMmrModeState(previousState);

    const { pi, calls, commands } = createPi({
      allTools: [{ name: "unrelated" }],
      setModelResult: true,
    });
    const { ctx, notifications } = createContext([{ provider: "openai-codex", id: "gpt-5.5" }], { authenticated: true });
    extension(pi);

    await commands.get("mode").handler("deep", ctx);

    assert.equal(runtime.getMmrModeState(), previousState);
    assert.deepEqual(calls.setModel, []);
    assert.deepEqual(calls.setActiveTools, []);
    assert.deepEqual(calls.setThinkingLevel, []);
    assert.deepEqual(calls.appendEntry, []);
    assert.equal(notifications.at(-1)?.level, "error");
    assert.match(notifications.at(-1)?.message, /Could not activate Deep mode/);
    assert.match(notifications.at(-1)?.message, /no active tools/i);
    assert.match(notifications.at(-1)?.message, /Current MMR mode unchanged: Smart \(smart\)/);
  });

  it("includes edit and write in setActiveTools when deep activates with Pi-native tools", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await importRuntime();
    runtime.setMmrModeState(undefined);

    const { pi, calls, commands } = createPi({
      allTools: [
        { name: "read" },
        { name: "bash" },
        { name: "edit" },
        { name: "write" },
        { name: "grep" },
        { name: "find" },
        { name: "ls" },
      ],
      setModelResult: true,
    });
    const { ctx } = createContext([{ provider: "openai-codex", id: "gpt-5.5" }], { authenticated: true });
    extension(pi);

    await commands.get("mode").handler("deep", ctx);

    assert.equal(calls.setActiveTools.length, 1);
    assert.equal(calls.setActiveTools[0].includes("edit"), true);
    assert.equal(calls.setActiveTools[0].includes("write"), true);
  });

  it("applies the per-mode thinking level for each locked mode", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await importRuntime();
    runtime.setMmrModeState(undefined);

    const models = [
      { provider: "claude-subscription", id: "claude-opus-4-8" },
      { provider: "claude-subscription", id: "claude-haiku-4-5" },
      { provider: "openai-codex", id: "gpt-5.4" },
      { provider: "openai-codex", id: "gpt-5.5" },
    ];
    const { pi, calls, commands } = createPi({
      allTools: [
        { name: "read" },
        { name: "bash" },
        { name: "edit" },
        { name: "write" },
        { name: "grep" },
        { name: "find" },
        { name: "ls" },
      ],
      setModelResult: true,
    });
    const { ctx } = createContext(models, { authenticated: true });
    extension(pi);

    await commands.get("mode").handler("smart", ctx);
    await commands.get("mode").handler("rush", ctx);
    await commands.get("mode").handler("large", ctx);
    await commands.get("mode").handler("deep", ctx);

    assert.deepEqual(calls.setThinkingLevel, ["medium", "off", "medium", "medium"]);
  });

  it("falls rush back to Haiku 4.5 with thinking off when GPT routes are unavailable", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await importRuntime();
    runtime.setMmrModeState(undefined);

    const { pi, calls, commands } = createPi({
      allTools: [
        { name: "read" },
        { name: "bash" },
        { name: "edit" },
        { name: "write" },
        { name: "grep" },
        { name: "find" },
      ],
      setModelResult: true,
    });
    const { ctx } = createContext([
      { provider: "claude-subscription", id: "claude-haiku-4-5" },
    ], { authenticated: true });
    extension(pi);

    await commands.get("mode").handler("rush", ctx);

    assert.equal(calls.setModel.at(-1)?.provider, "claude-subscription");
    assert.equal(calls.setModel.at(-1)?.id, "claude-haiku-4-5");
    assert.equal(calls.setThinkingLevel.at(-1), "off");
    assert.equal(runtime.getMmrModeState()?.modelFallbackApplied, true);
    assert.match(runtime.getMmrModeState()?.modelFallbackReason ?? "", /gpt-5\.5/);
  });

  it("surfaces deferred tool diagnostics in the activation notification warnings list", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await importRuntime();
    runtime.setMmrModeState(undefined);

    const { pi, commands } = createPi({
      allTools: [
        { name: "read" },
        { name: "bash" },
        { name: "edit" },
        { name: "write" },
        { name: "grep" },
        { name: "find" },
        { name: "ls" },
      ],
      setModelResult: true,
    });
    const { ctx, notifications } = createContext([{ provider: "openai-codex", id: "gpt-5.5" }], { authenticated: true });
    extension(pi);

    await commands.get("mode").handler("deep", ctx);

    const activation = notifications.at(-1);
    assert.equal(activation.level, "warning");
    // Built-in deferred rules name the owning extension in the diagnostic.
    assert.match(activation.message, /oracle: deferred until mmr-subagents ships/);
    assert.match(activation.message, /finder: deferred until mmr-subagents ships/);
    assert.match(activation.message, /web_search: deferred until mmr-web ships/);
    assert.match(activation.message, /chart: deferred until mmr-tasks ships/);
    assert.match(activation.message, /code_review: deferred until mmr-subagents ships/);
  });
});
