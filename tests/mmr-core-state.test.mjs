import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

describe("mmr-core persisted state", () => {
  it("restores the latest valid MMR mode state from Pi custom entries", async () => {
    const { findLatestPersistedModeState, MMR_MODE_STATE_ENTRY } = await importSource("extensions/mmr-core/state.ts");

    const state = findLatestPersistedModeState([
      {
        type: "custom",
        customType: MMR_MODE_STATE_ENTRY,
        data: { mode: "rush", source: "command", provider: "claude-subscription", model: "claude-haiku-4-5" },
      },
      {
        type: "custom",
        customType: MMR_MODE_STATE_ENTRY,
        data: { mode: "not-a-mode", source: "command" },
      },
      {
        type: "custom",
        customType: MMR_MODE_STATE_ENTRY,
        data: { mode: "deep", source: "command", provider: "openai", model: "gpt-5.5" },
      },
    ]);

    assert.equal(state?.mode, "deep");
    assert.equal(state?.source, "command");
    assert.equal(state?.provider, "openai");
    assert.equal(state?.targetModel, "gpt-5.5");
  });

  it("serializes state with MMR naming and no legacy compatibility fields", async () => {
    const { createMmrModeState, toPersistedModeState } = await importSource("extensions/mmr-core/state.ts");
    const { getMmrMode } = await importSource("extensions/mmr-core/modes.ts");

    const state = createMmrModeState({
      mode: getMmrMode("rush"),
      source: "command",
      modelResolution: {
        targetModel: "claude-haiku-4-5",
        requestedModels: ["claude-haiku-4-5", "gpt-5.4-mini"],
        selectedProvider: "claude-subscription",
        selectedModel: "claude-haiku-4-5",
        selectedThinkingLevel: "medium",
        modelFound: true,
        modelApplied: true,
        fallbackApplied: false,
        candidates: [],
      },
      tools: { requestedTools: ["Read"], activeTools: ["read"], missingTools: [], decisions: [] },
      effectiveMaxInputTokens: 136000,
      baselineCaptured: true,
      baselineModel: "openai/gpt-5.4",
      appliedAt: "2026-05-08T00:00:00.000Z",
    });

    assert.deepEqual(toPersistedModeState(state), {
      version: 1,
      mode: "rush",
      source: "command",
      targetModel: "claude-haiku-4-5",
      requestedModels: ["claude-haiku-4-5", "gpt-5.4-mini"],
      provider: "claude-subscription",
      model: "claude-haiku-4-5",
      modelFallbackApplied: false,
      modelFallbackReason: undefined,
      thinkingLevel: "medium",
      activeTools: ["read"],
      missingTools: [],
      deferredTools: [],
      gatedTools: [],
      disabledTools: [],
      appliedAt: "2026-05-08T00:00:00.000Z",
    });
  });

  it("persists and restores native-control modes without model routing fields", async () => {
    const { createMmrModeState, findLatestPersistedModeState, MMR_MODE_STATE_ENTRY, toPersistedModeState } = await importSource("extensions/mmr-core/state.ts");
    const { getMmrMode } = await importSource("extensions/mmr-core/modes.ts");

    for (const mode of ["open", "free"]) {
      const activeTools = mode === "open" ? ["read", "bash", "Task"] : ["read", "bash"];
      const state = createMmrModeState({
        mode: getMmrMode(mode),
        source: "command",
        modelResolution: {
          targetModel: "",
          requestedModels: [],
          modelFound: false,
          modelApplied: false,
          fallbackApplied: false,
          candidates: [],
        },
        tools: { requestedTools: mode === "open" ? activeTools : [], activeTools, missingTools: [], decisions: [] },
        appliedAt: "2026-05-08T00:00:00.000Z",
      });

      const persisted = toPersistedModeState(state);

      assert.deepEqual(persisted, {
        version: 1,
        mode,
        source: "command",
        targetModel: "",
        requestedModels: [],
        provider: "",
        model: "",
        modelFallbackApplied: false,
        modelFallbackReason: undefined,
        thinkingLevel: undefined,
        activeTools,
        missingTools: [],
        deferredTools: [],
        gatedTools: [],
        disabledTools: [],
        appliedAt: "2026-05-08T00:00:00.000Z",
      });
      assert.equal(findLatestPersistedModeState([{ type: "custom", customType: MMR_MODE_STATE_ENTRY, data: persisted }])?.mode, mode);
    }
  });

  it("writes version 1 on every persisted state", async () => {
    const { createMmrModeState, toPersistedModeState, MMR_MODE_STATE_VERSION } = await importSource("extensions/mmr-core/state.ts");
    const { getMmrMode } = await importSource("extensions/mmr-core/modes.ts");

    assert.equal(MMR_MODE_STATE_VERSION, 1);

    const state = createMmrModeState({
      mode: getMmrMode("smart"),
      source: "command",
      modelResolution: {
        targetModel: "gpt-5.5",
        requestedModels: ["gpt-5.5"],
        selectedProvider: "openai",
        selectedModel: "gpt-5.5",
        modelFound: true,
        modelApplied: true,
        fallbackApplied: false,
        candidates: [],
      },
      tools: { requestedTools: ["Read"], activeTools: ["read"], missingTools: [], decisions: [] },
      appliedAt: "2026-05-08T00:00:00.000Z",
    });

    assert.equal(state.version, 1);
    assert.equal(toPersistedModeState(state).version, 1);
  });

  it("restores legacy unversioned persisted state and ignores future or malformed versions", async () => {
    const { findLatestPersistedModeState, MMR_MODE_STATE_ENTRY } = await importSource("extensions/mmr-core/state.ts");

    const legacyOnly = findLatestPersistedModeState([
      {
        type: "custom",
        customType: MMR_MODE_STATE_ENTRY,
        data: { mode: "rush", source: "command", provider: "openai", model: "gpt-5.4-mini" },
      },
    ]);
    assert.equal(legacyOnly?.mode, "rush");
    assert.equal(legacyOnly?.version, 1, "legacy state should be normalized to version 1");

    const ignoresFuture = findLatestPersistedModeState([
      {
        type: "custom",
        customType: MMR_MODE_STATE_ENTRY,
        data: { version: 1, mode: "smart", source: "command", provider: "openai", model: "gpt-5.5" },
      },
      {
        type: "custom",
        customType: MMR_MODE_STATE_ENTRY,
        data: { version: 999, mode: "deep", source: "command", provider: "openai", model: "gpt-5.5" },
      },
    ]);
    assert.equal(ignoresFuture?.mode, "smart", "future version must be skipped, falling back to last v1");

    const ignoresMalformed = findLatestPersistedModeState([
      {
        type: "custom",
        customType: MMR_MODE_STATE_ENTRY,
        data: { version: "oops", mode: "deep", source: "command" },
      },
    ]);
    assert.equal(ignoresMalformed, undefined);
  });

  it("sanitizes invalid source/thinkingLevel values when restoring persisted state", async () => {
    const { findLatestPersistedModeState, MMR_MODE_STATE_ENTRY } = await importSource("extensions/mmr-core/state.ts");

    const restored = findLatestPersistedModeState([
      {
        type: "custom",
        customType: MMR_MODE_STATE_ENTRY,
        data: {
          version: 1,
          mode: "smart",
          source: "not-a-real-source",
          provider: "openai",
          model: "gpt-5.5",
          thinkingLevel: "ludicrous",
          activeTools: ["read"],
        },
      },
    ]);

    assert.equal(restored?.mode, "smart");
    assert.equal(restored?.source, "session", "invalid source must be coerced to the session default, not propagated");
    assert.equal(restored?.thinkingLevel, undefined, "invalid thinkingLevel must be dropped, not propagated");

    const restoredObjectSource = findLatestPersistedModeState([
      {
        type: "custom",
        customType: MMR_MODE_STATE_ENTRY,
        data: {
          version: 1,
          mode: "deep",
          source: { evil: true },
          provider: "openai",
          model: "gpt-5.5",
          activeTools: [],
        },
      },
    ]);
    assert.equal(restoredObjectSource?.source, "session");

    const restoredValid = findLatestPersistedModeState([
      {
        type: "custom",
        customType: MMR_MODE_STATE_ENTRY,
        data: {
          version: 1,
          mode: "rush",
          source: "flag",
          provider: "anthropic",
          model: "claude-haiku-4-5",
          thinkingLevel: "high",
          activeTools: ["read"],
        },
      },
    ]);
    assert.equal(restoredValid?.source, "flag");
    assert.equal(restoredValid?.thinkingLevel, "high");
  });

  it("includes resolution decisions on createMmrModeState", async () => {
    const { createMmrModeState } = await importSource("extensions/mmr-core/state.ts");
    const { getMmrMode } = await importSource("extensions/mmr-core/modes.ts");

    const state = createMmrModeState({
      mode: getMmrMode("smart"),
      source: "flag",
      rejectedSources: [{ source: "settings", value: "fast", reason: "invalid mode" }],
      modelResolution: {
        targetModel: "gpt-5.5",
        requestedModels: ["claude-opus-4-8", "gpt-5.5"],
        selectedProvider: "openai",
        selectedModel: "gpt-5.5",
        modelFound: true,
        modelApplied: true,
        fallbackApplied: true,
        fallbackReason: "first option not registered",
        candidates: [],
      },
      tools: {
        requestedTools: ["Read", "oracle"],
        activeTools: ["read"],
        missingTools: ["oracle"],
        decisions: [
          { requested: "Read", chosen: "read", candidates: ["read"] },
          { requested: "oracle", candidates: ["oracle"] },
        ],
      },
      appliedAt: "2026-05-08T00:00:00.000Z",
    });

    assert.equal(state.resolution.selectedSource, "flag");
    assert.deepEqual(state.resolution.rejectedSources, [{ source: "settings", value: "fast", reason: "invalid mode" }]);
    assert.deepEqual(state.resolution.modelDecision, { fallbackApplied: true, reason: "first option not registered" });
    assert.equal(state.resolution.toolDecisions.length, 2);
    assert.equal(state.resolution.toolDecisions[1].requested, "oracle");
    // smart mode has reserved feature gates such as mmr-subagents.
    assert.ok(state.resolution.featureGateDecisions.length > 0);
    for (const decision of state.resolution.featureGateDecisions) {
      assert.equal(decision.status, "missing");
      assert.match(decision.reason, /reserved|deferred|not yet/i);
    }
  });
});
