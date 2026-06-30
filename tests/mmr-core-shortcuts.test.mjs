import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, getPreparedSourceRoot, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const SMART_MODEL = { provider: "claude-subscription", id: "claude-opus-4-8" };
const RUSH_MODEL = { provider: "claude-subscription", id: "claude-haiku-4-5" };
const LARGE_MODEL = { provider: "openai-codex", id: "gpt-5.4" };
const DEEP_MODEL = { provider: "openai-codex", id: "gpt-5.5" };
const MODELS = [SMART_MODEL, RUSH_MODEL, LARGE_MODEL, DEEP_MODEL];

function createState(mode) {
  const displayName = mode[0].toUpperCase() + mode.slice(1);
  return {
    mode,
    displayName,
    source: "command",
    targetModel: "",
    requestedModels: [],
    provider: "",
    model: "",
    modelFound: true,
    modelApplied: true,
    modelFallbackApplied: false,
    modelCandidates: [],
    thinkingLevel: "medium",
    promptRoute: "default",
    requestedTools: [],
    activeTools: ["read", "bash"],
    missingTools: [],
    deferredTools: [],
    featureGates: [],
    availabilityNotes: [],
    appliedAt: "2026-05-08T00:00:00.000Z",
  };
}

function createContext() {
  return createMockExtensionContext({ models: MODELS });
}

function createPi() {
  return createMockPi({
    activeTools: ["read", "bash", "grep"],
    allTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
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

describe("mmr-core mode shortcuts", () => {
  it("registers picker and cycle shortcuts", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const { pi, shortcuts } = createPi();

    extension(pi);

    assert.equal(shortcuts.get("ctrl+shift+s")?.description, "Select MMR mode");
    assert.equal(shortcuts.get("alt+m")?.description, "Select MMR mode");
    assert.equal(shortcuts.get("ctrl+space")?.description, "Cycle MMR mode");
    assert.match(shortcuts.get("alt+r")?.description ?? "", /Toggle MMR thinking level/);
  });

  it("toggles the thinking level in place via alt+r without releasing the mode", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await importRuntime();
    runtime.setMmrModeState(createState("smart"));
    const { ctx, notifications } = createContext();
    const { pi, calls, shortcuts } = createPi();
    extension(pi);

    // smart default toggle level is medium; alt+r flips to high, which asks
    // Anthropic for xhigh effort while keeping the 64k output budget.
    await shortcuts.get("alt+r").handler(ctx);

    assert.equal(runtime.getMmrModeState()?.mode, "smart");
    assert.equal(runtime.getMmrModeState()?.thinkingLevel, "high");
    assert.equal(runtime.getMmrModeState()?.effectiveMaxOutputTokens, 64000);
    assert.deepEqual(calls.setThinkingLevel, ["high"]);
    assert.equal(calls.appendEntry.at(-1)?.[1].mode, "smart");
    // Concise notify, not the full "mode activated" banner.
    assert.match(notifications.at(-1)?.message ?? "", /MMR thinking: smart → high, max out 64k/);
    assert.equal(notifications.some((n) => /mode activated/i.test(n.message)), false);

    // Pressing again toggles back to medium with the 64k budget.
    await shortcuts.get("alt+r").handler(ctx);
    assert.equal(runtime.getMmrModeState()?.mode, "smart");
    assert.equal(runtime.getMmrModeState()?.thinkingLevel, "medium");
    assert.equal(runtime.getMmrModeState()?.effectiveMaxOutputTokens, 64000);
  });

  it("alt+r is a no-op notice in non-toggleable modes", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await importRuntime();
    runtime.setMmrModeState(createState("rush"));
    const { ctx, notifications } = createContext();
    const { pi, calls, shortcuts } = createPi();
    extension(pi);

    await shortcuts.get("alt+r").handler(ctx);

    assert.equal(runtime.getMmrModeState()?.mode, "rush");
    assert.deepEqual(calls.setThinkingLevel, []);
    assert.match(notifications.at(-1)?.message ?? "", /only available in smart, smartGPT, smartSonnet, or deep/);
  });

  it("opens a picker that includes large mode", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await importRuntime();
    runtime.setMmrModeState(createState("smart"));
    const { ctx, selectCalls } = createContext();
    ctx.ui.select = async (title, options) => {
      selectCalls.push({ title, options });
      return "large";
    };
    const { pi, calls, shortcuts } = createPi();
    extension(pi);

    await shortcuts.get("alt+m").handler(ctx);

    assert.deepEqual(selectCalls[0].options, ["smart", "smartGPT", "smartSonnet", "rush", "test", "large", "deep", "open", "free"]);
    assert.match(selectCalls[0].title, /current: smart/);
    assert.equal(runtime.getMmrModeState()?.mode, "large");
    assert.equal(calls.setModel.length, 1);
    assert.equal(calls.setModel[0].id, LARGE_MODEL.id);
    assert.equal(calls.appendEntry.at(-1)?.[1].mode, "large");
  });

  it("cycles managed modes forward and skips free", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await importRuntime();
    runtime.setMmrModeState(createState("smart"));
    const { ctx } = createContext();
    const { pi, calls, shortcuts } = createPi();
    extension(pi);

    await shortcuts.get("ctrl+space").handler(ctx);

    assert.equal(runtime.getMmrModeState()?.mode, "smartGPT");
    assert.deepEqual(calls.setThinkingLevel, ["medium"]);
    assert.equal(calls.appendEntry.at(-1)?.[1].mode, "smartGPT");
  });

  it("cycles from free back to smart instead of including free in rotation", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await importRuntime();
    runtime.setMmrModeState(createState("free"));
    const { ctx } = createContext();
    const { pi, calls, shortcuts } = createPi();
    extension(pi);

    await shortcuts.get("ctrl+space").handler(ctx);

    assert.equal(runtime.getMmrModeState()?.mode, "smart");
    assert.equal(calls.setModel.length, 1);
    assert.equal(calls.setModel[0].id, SMART_MODEL.id);
    assert.equal(calls.appendEntry.at(-1)?.[1].mode, "smart");
  });
});
