import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const MODULE = "extensions/mmr-subagents/fallback.ts";

let mod;
beforeEach(async () => {
  mod = await importSource(MODULE);
  mod.resetMmrWorkerFallbackState();
});

// A registry stub matching the minimal surface the candidate builder uses.
function makeRegistry(models) {
  return {
    getAll: () => models.map((m) => ({ provider: m.provider, id: m.id })),
    hasConfiguredAuth: (m) => models.find((x) => x.provider === m.provider && x.id === m.id)?.auth ?? false,
    isUsingOAuth: (m) => models.find((x) => x.provider === m.provider && x.id === m.id)?.oauth ?? false,
  };
}

describe("isRetryableMmrWorkerModelFailure (#9)", () => {
  it("treats only worker-error as a retryable worker-model failure", () => {
    assert.equal(mod.isRetryableMmrWorkerModelFailure("worker-error"), true);
    for (const status of ["success", "spawn-error", "activation-error", "aborted", "no-agent-start", "empty-output"]) {
      assert.equal(mod.isRetryableMmrWorkerModelFailure(status), false, `${status} must not be retryable`);
    }
  });
});

describe("classifyMmrWorkerRouteBilling (#9)", () => {
  it("classifies subscription, oauth, api-key, and unknown routes", () => {
    const registry = makeRegistry([
      { provider: "claude-subscription", id: "claude-opus-4-6", auth: true },
      { provider: "anthropic", id: "claude-opus-4-6", auth: true },
      { provider: "custom", id: "via-oauth", auth: true, oauth: true },
      { provider: "custom", id: "no-auth", auth: false },
    ]);
    assert.equal(mod.classifyMmrWorkerRouteBilling(registry, { provider: "claude-subscription", id: "claude-opus-4-6" }), "subscription");
    assert.equal(mod.classifyMmrWorkerRouteBilling(registry, { provider: "anthropic", id: "claude-opus-4-6" }), "api-key");
    assert.equal(mod.classifyMmrWorkerRouteBilling(registry, { provider: "custom", id: "via-oauth" }), "subscription");
    assert.equal(mod.classifyMmrWorkerRouteBilling(registry, { provider: "custom", id: "no-auth" }), "unknown");
  });
});

describe("buildMmrWorkerFallbackCandidates (#9)", () => {
  it("excludes the failing route + unauthenticated models, ranks by the profile chain, and labels billing", () => {
    const registry = makeRegistry([
      { provider: "claude-subscription", id: "claude-opus-4-8", auth: true },
      { provider: "anthropic", id: "claude-opus-4-6", auth: true },
      { provider: "openai", id: "gpt-5.5", auth: true },
      { provider: "openai", id: "locked", auth: false },
    ]);
    const preferences = [
      { model: "claude-opus-4-8" },
      { model: "gpt-5.5" },
      { model: "claude-opus-4-6" },
    ];
    const candidates = mod.buildMmrWorkerFallbackCandidates({
      registry,
      preferences,
      failingProvider: "claude-subscription",
      failingModel: "claude-opus-4-8",
    });
    const ids = candidates.map((c) => `${c.provider}/${c.model}`);
    assert.deepEqual(ids, ["openai/gpt-5.5", "anthropic/claude-opus-4-6"], "failing + unauth dropped; ranked by chain order");
    assert.equal(candidates[0].suggested, true, "top chain match is suggested");
    assert.match(candidates[0].label, /Suggested: ⚠ billed · openai\/gpt-5\.5 — API key/);
    assert.equal(candidates[1].billing, "api-key");
  });

  it("marks billed routes with a leading marker while subscription routes stay lighter, keeping labels unique (#5)", () => {
    const registry = makeRegistry([
      { provider: "claude-subscription", id: "claude-opus-4-8", auth: true },
      { provider: "anthropic", id: "claude-opus-4-6", auth: true },
      { provider: "openai", id: "gpt-5.5", auth: true },
    ]);
    const candidates = mod.buildMmrWorkerFallbackCandidates({
      registry,
      preferences: [{ model: "claude-opus-4-8" }],
    });
    const byRoute = new Map(candidates.map((c) => [`${c.provider}/${c.model}`, c]));
    const subscription = byRoute.get("claude-subscription/claude-opus-4-8");
    const apiKey = byRoute.get("anthropic/claude-opus-4-6");
    assert.equal(subscription.billing, "subscription");
    assert.equal(apiKey.billing, "api-key");
    // Billed (api-key) routes carry the leading distinct marker.
    assert.ok(apiKey.label.includes("⚠"), "api-key label carries the billed marker");
    assert.match(apiKey.label, /⚠ billed · anthropic\/claude-opus-4-6 — API key/);
    // Subscription routes stay visually lighter: no marker.
    assert.ok(!subscription.label.includes("⚠"), "subscription label has no billed marker");
    assert.match(subscription.label, /claude-subscription\/claude-opus-4-8 — subscription/);
    // Labels remain unique (used as prompt map keys).
    const labels = candidates.map((c) => c.label);
    assert.equal(new Set(labels).size, labels.length, "labels stay unique");
  });

  it("excludes every provider variant of a bare failing model id", () => {
    const registry = makeRegistry([
      { provider: "anthropic", id: "claude-opus-4-6", auth: true },
      { provider: "claude-subscription", id: "claude-opus-4-6", auth: true },
      { provider: "openai", id: "gpt-5.5", auth: true },
    ]);
    const candidates = mod.buildMmrWorkerFallbackCandidates({
      registry,
      preferences: [{ model: "gpt-5.5" }],
      failingModel: "claude-opus-4-6",
    });
    assert.deepEqual(candidates.map((c) => c.model), ["gpt-5.5"]);
  });
});

describe("failure counting + override scope (#9)", () => {
  it("counts per route key and keeps scopes independent", () => {
    const scopeA = mod.mmrWorkerFallbackScopeKey({ sessionId: "s1", profileName: "oracle" });
    const scopeB = mod.mmrWorkerFallbackScopeKey({ sessionId: "s1", profileName: "finder" });
    const keyA = mod.mmrWorkerFallbackRouteKey(scopeA, "anthropic/x");
    const keyB = mod.mmrWorkerFallbackRouteKey(scopeB, "anthropic/x");
    assert.equal(mod.recordMmrWorkerFallbackFailure(keyA), 1);
    assert.equal(mod.recordMmrWorkerFallbackFailure(keyA), 2);
    assert.equal(mod.recordMmrWorkerFallbackFailure(keyB), 1, "different scope counts independently");
  });

  it("includes parent mode in the scope key (Task routes differ per mode)", () => {
    const smart = mod.mmrWorkerFallbackScopeKey({ sessionId: "s1", profileName: "task-subagent", parentMode: "smart" });
    const rush = mod.mmrWorkerFallbackScopeKey({ sessionId: "s1", profileName: "task-subagent", parentMode: "rush" });
    assert.notEqual(smart, rush);
  });

  it("stores and reads session overrides by scope", () => {
    const scope = mod.mmrWorkerFallbackScopeKey({ sessionId: "s1", profileName: "oracle" });
    assert.equal(mod.getMmrWorkerFallbackOverride(scope), undefined);
    mod.setMmrWorkerFallbackOverride(scope, [{ model: "gpt-5.5" }]);
    assert.deepEqual(mod.getMmrWorkerFallbackOverride(scope), [{ model: "gpt-5.5" }]);
  });
});

// --- Orchestrator -------------------------------------------------------

const REGISTRY = {
  getAll: () => [
    { provider: "claude-subscription", id: "claude-opus-4-8" },
    { provider: "openai", id: "gpt-5.5" },
  ],
  hasConfiguredAuth: () => true,
  isUsingOAuth: (m) => m.provider === "claude-subscription",
};

const CANDIDATE_PREFS = [{ model: "claude-opus-4-8" }, { model: "gpt-5.5" }];

function makeRun(sequence) {
  // sequence: array of { status, route }. Returns a run() closure that
  // records the override it was called with and returns the next outcome.
  const calls = [];
  let i = 0;
  const run = async (runArgs) => {
    const entry = sequence[Math.min(i, sequence.length - 1)];
    i += 1;
    calls.push({ override: runArgs.override });
    return { result: { __status: entry.status }, route: entry.route };
  };
  return { run, calls };
}

const classifyOutcome = (result) => result.__status;

const baseArgs = (overrides) => ({
  ctx: { hasUI: true, ui: { select: async () => undefined } },
  sessionId: "s1",
  registry: REGISTRY,
  toolName: "oracle",
  profileName: "oracle",
  candidatePreferences: CANDIDATE_PREFS,
  classifyOutcome,
  ...overrides,
});

describe("runMmrWorkerWithModelFallback orchestrator (#9)", () => {
  it("returns success without prompting", async () => {
    const { run, calls } = makeRun([{ status: "success", route: "claude-subscription/claude-opus-4-8" }]);
    let prompted = false;
    const outcome = await mod.runMmrWorkerWithModelFallback(baseArgs({
      run,
      ctx: { hasUI: true, ui: { select: async () => { prompted = true; return undefined; } } },
    }));
    assert.equal(outcome.fallbackApplied, false);
    assert.equal(calls.length, 1);
    assert.equal(prompted, false);
  });

  it("does not prompt on the first worker-model failure (below threshold)", async () => {
    const { run, calls } = makeRun([{ status: "worker-error", route: "claude-subscription/claude-opus-4-8" }]);
    let prompted = false;
    await mod.runMmrWorkerWithModelFallback(baseArgs({
      run,
      ctx: { hasUI: true, ui: { select: async () => { prompted = true; return undefined; } } },
    }));
    assert.equal(prompted, false, "first failure must not prompt");
    assert.equal(calls.length, 1);
  });

  it("prompts on the second same-route failure, applies the choice, and re-runs once with the override", async () => {
    // First execute fails (count 1, no prompt).
    const first = makeRun([{ status: "worker-error", route: "claude-subscription/claude-opus-4-8" }]);
    await mod.runMmrWorkerWithModelFallback(baseArgs({ run: first.run }));

    // Second execute fails (count 2) -> prompt -> pick gpt-5.5 -> retry.
    const selectCalls = [];
    const second = makeRun([
      { status: "worker-error", route: "claude-subscription/claude-opus-4-8" },
      { status: "success", route: "openai/gpt-5.5" },
    ]);
    const outcome = await mod.runMmrWorkerWithModelFallback(baseArgs({
      run: second.run,
      ctx: {
        hasUI: true,
        ui: {
          select: async (_title, options) => {
            selectCalls.push(options);
            return options.find((o) => o.includes("gpt-5.5"));
          },
        },
      },
    }));

    assert.equal(selectCalls.length, 1, "prompt fired once on the threshold failure");
    assert.equal(second.calls.length, 2, "ran once, then re-ran with the fallback");
    assert.equal(second.calls[0].override, undefined, "first run used the normal route");
    assert.ok(second.calls[1].override, "retry run received the fallback override");
    assert.equal(second.calls[1].override[0].model, "gpt-5.5");
    assert.equal(outcome.fallbackApplied, true);

    // A subsequent execute uses the stored override immediately, no prompt.
    let prompted = false;
    const third = makeRun([{ status: "success", route: "openai/gpt-5.5" }]);
    const out3 = await mod.runMmrWorkerWithModelFallback(baseArgs({
      run: third.run,
      ctx: { hasUI: true, ui: { select: async () => { prompted = true; return undefined; } } },
    }));
    assert.equal(prompted, false, "stored override skips the prompt");
    assert.ok(third.calls[0].override, "stored override applied to the first run");
    assert.equal(out3.fallbackApplied, true);
  });

  it("resets the consecutive-failure count on a success between failures", async () => {
    // failure (count 1) -> success (reset) -> failure (count 1 again) must
    // NOT reach the threshold, so no prompt fires.
    let prompted = false;
    const ctx = { hasUI: true, ui: { select: async () => { prompted = true; return undefined; } } };
    const f1 = makeRun([{ status: "worker-error", route: "claude-subscription/claude-opus-4-8" }]);
    await mod.runMmrWorkerWithModelFallback(baseArgs({ run: f1.run, ctx }));
    const ok = makeRun([{ status: "success", route: "claude-subscription/claude-opus-4-8" }]);
    await mod.runMmrWorkerWithModelFallback(baseArgs({ run: ok.run, ctx }));
    const f2 = makeRun([{ status: "worker-error", route: "claude-subscription/claude-opus-4-8" }]);
    await mod.runMmrWorkerWithModelFallback(baseArgs({ run: f2.run, ctx }));
    assert.equal(prompted, false, "success between failures must reset the count below threshold");
    assert.equal(f2.calls.length, 1);
  });

  it("never prompts or switches without UI", async () => {
    const r1 = makeRun([{ status: "worker-error", route: "claude-subscription/claude-opus-4-8" }]);
    await mod.runMmrWorkerWithModelFallback(baseArgs({ run: r1.run, ctx: { hasUI: false, ui: { select: async () => "x" } } }));
    const r2 = makeRun([{ status: "worker-error", route: "claude-subscription/claude-opus-4-8" }]);
    const outcome = await mod.runMmrWorkerWithModelFallback(baseArgs({ run: r2.run, ctx: { hasUI: false, ui: { select: async () => "x" } } }));
    assert.equal(outcome.fallbackApplied, false);
    assert.equal(r2.calls.length, 1, "no retry without UI");
    assert.equal(r2.calls[0].override, undefined);
  });

  it("returns the failure unchanged when the user cancels the prompt", async () => {
    const r1 = makeRun([{ status: "worker-error", route: "claude-subscription/claude-opus-4-8" }]);
    await mod.runMmrWorkerWithModelFallback(baseArgs({ run: r1.run }));
    const r2 = makeRun([{ status: "worker-error", route: "claude-subscription/claude-opus-4-8" }]);
    const outcome = await mod.runMmrWorkerWithModelFallback(baseArgs({
      run: r2.run,
      ctx: { hasUI: true, ui: { select: async () => undefined } },
    }));
    assert.equal(outcome.fallbackApplied, false);
    assert.equal(r2.calls.length, 1, "cancel -> no retry");
    const scope = mod.mmrWorkerFallbackScopeKey({ sessionId: "s1", profileName: "oracle" });
    assert.equal(mod.getMmrWorkerFallbackOverride(scope), undefined, "cancel stores no override");
  });

  it("does not count or prompt for non-retryable failures (spawn/activation)", async () => {
    for (const status of ["spawn-error", "activation-error"]) {
      mod.resetMmrWorkerFallbackState();
      let prompted = false;
      const a = makeRun([{ status, route: "claude-subscription/claude-opus-4-8" }]);
      await mod.runMmrWorkerWithModelFallback(baseArgs({ run: a.run, ctx: { hasUI: true, ui: { select: async () => { prompted = true; return "x"; } } } }));
      const b = makeRun([{ status, route: "claude-subscription/claude-opus-4-8" }]);
      await mod.runMmrWorkerWithModelFallback(baseArgs({ run: b.run, ctx: { hasUI: true, ui: { select: async () => { prompted = true; return "x"; } } } }));
      assert.equal(prompted, false, `${status} must never prompt`);
      assert.equal(b.calls.length, 1);
    }
  });
});

describe("override persistence gated on retry route adoption (#4)", () => {
  const scope = () => mod.mmrWorkerFallbackScopeKey({ sessionId: "s1", profileName: "oracle" });
  const pickGpt = {
    hasUI: true,
    ui: { select: async (_title, options) => options.find((o) => o.includes("gpt-5.5")) },
  };

  it("persists the override when the retry actually adopts the chosen route", async () => {
    // First failure (count 1, no prompt).
    const f1 = makeRun([{ status: "worker-error", route: "claude-subscription/claude-opus-4-8" }]);
    await mod.runMmrWorkerWithModelFallback(baseArgs({ run: f1.run }));
    // Threshold failure -> prompt -> retry adopts openai/gpt-5.5.
    const f2 = makeRun([
      { status: "worker-error", route: "claude-subscription/claude-opus-4-8" },
      { status: "success", route: "openai/gpt-5.5" },
    ]);
    const outcome = await mod.runMmrWorkerWithModelFallback(baseArgs({ run: f2.run, ctx: pickGpt }));
    assert.equal(outcome.fallbackApplied, true);
    assert.ok(mod.getMmrWorkerFallbackOverride(scope()), "adopted retry persists the override");
    assert.equal(mod.getMmrWorkerFallbackOverride(scope())[0].model, "gpt-5.5");
  });

  it("does NOT persist the override when the retry route does not adopt the chosen model", async () => {
    const f1 = makeRun([{ status: "worker-error", route: "claude-subscription/claude-opus-4-8" }]);
    await mod.runMmrWorkerWithModelFallback(baseArgs({ run: f1.run }));
    // Threshold failure -> prompt -> but the retry's closure falls back to the
    // original route (the override failed to resolve), so it must NOT persist.
    const f2 = makeRun([
      { status: "worker-error", route: "claude-subscription/claude-opus-4-8" },
      { status: "worker-error", route: "claude-subscription/claude-opus-4-8" },
    ]);
    const outcome = await mod.runMmrWorkerWithModelFallback(baseArgs({ run: f2.run, ctx: pickGpt }));
    assert.equal(outcome.fallbackApplied, true, "the override DID apply to this run");
    assert.equal(outcome.route, "claude-subscription/claude-opus-4-8");
    assert.equal(mod.getMmrWorkerFallbackOverride(scope()), undefined, "non-adopted retry must not persist");

    // No stored override -> a later threshold failure can prompt again (state
    // is not silently poisoned by the bad override).
    let promptedAgain = false;
    const f3 = makeRun([
      { status: "worker-error", route: "claude-subscription/claude-opus-4-8" },
      { status: "success", route: "openai/gpt-5.5" },
    ]);
    await mod.runMmrWorkerWithModelFallback(baseArgs({
      run: f3.run,
      ctx: {
        hasUI: true,
        ui: {
          select: async (_title, options) => {
            promptedAgain = true;
            return options.find((o) => o.includes("gpt-5.5"));
          },
        },
      },
    }));
    assert.equal(promptedAgain, true, "a non-persisted override lets a later failure re-prompt");
  });
});

describe("session_start clears worker-fallback state (#3)", () => {
  const scope = () => mod.mmrWorkerFallbackScopeKey({ sessionId: "s1", profileName: "oracle" });

  async function registerExtension() {
    const { createMmrSubagentsExtension } = await importSource("extensions/mmr-subagents/index.ts");
    const runtime = await importSource("extensions/mmr-core/runtime.ts");
    const handlers = new Map();
    const pi = {
      registerTool: () => {},
      on: (name, handler) => handlers.set(name, handler),
      getActiveTools: () => [],
      getAllTools: () => [],
    };
    createMmrSubagentsExtension()(pi);
    return { handlers, runtime };
  }

  function seedOverride() {
    mod.setMmrWorkerFallbackOverride(scope(), [{ model: "gpt-5.5" }]);
  }

  it("clears state on a new session", async () => {
    const { handlers } = await registerExtension();
    seedOverride();
    assert.ok(mod.getMmrWorkerFallbackOverride(scope()), "precondition: override seeded");
    await handlers.get("session_start")({ reason: "new" });
    assert.equal(mod.getMmrWorkerFallbackOverride(scope()), undefined, "new session wipes the override");
  });

  it("clears state on a fork", async () => {
    const { handlers } = await registerExtension();
    seedOverride();
    await handlers.get("session_start")({ reason: "fork" });
    assert.equal(mod.getMmrWorkerFallbackOverride(scope()), undefined, "fork wipes the override");
  });

  it("does not clear on resume", async () => {
    const { handlers } = await registerExtension();
    seedOverride();
    await handlers.get("session_start")({ reason: "resume" });
    assert.deepEqual(mod.getMmrWorkerFallbackOverride(scope()), [{ model: "gpt-5.5" }], "resume keeps the override");
  });

  it("does not clear inside a subagent worker even on new/fork", async () => {
    const { handlers, runtime } = await registerExtension();
    seedOverride();
    runtime.setMmrSubagentState({
      profile: "oracle",
      provider: "anthropic",
      model: "claude-opus-4-6",
      thinkingLevel: "medium",
      promptRoute: "subagent",
      activeTools: [],
      activatedAt: "2026-05-29T00:00:00.000Z",
    });
    try {
      await handlers.get("session_start")({ reason: "new" });
      assert.deepEqual(
        mod.getMmrWorkerFallbackOverride(scope()),
        [{ model: "gpt-5.5" }],
        "a worker child must not wipe the shared parent state",
      );
    } finally {
      runtime.setMmrSubagentState(undefined);
    }
  });
});
