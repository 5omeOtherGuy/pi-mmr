import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

const RUNTIME_KEY = "__pi_mmr_session_fallback_runtime_v2__";

after(cleanupLoadedSource);
afterEach(() => {
  delete globalThis[RUNTIME_KEY];
});

describe("mmr-session-fallback runtime reload guard", () => {
  it("rebuilds the runtime when a stale-shape singleton is on globalThis", async () => {
    const runtime = await importSource("extensions/mmr-session-fallback/runtime.ts");

    // Simulate an in-place reload leaving an incompatible instance behind:
    // `overrides` is a plain object, not a Map.
    globalThis[RUNTIME_KEY] = { overrides: {} };

    // Accessors read the global at call time; a stale shape must not throw.
    assert.equal(runtime.getMmrSessionFallbackOverrideSnapshot("session-1"), undefined);

    // After rebuild the runtime is usable and round-trips overrides.
    runtime.setMmrSessionFallbackOverride("session-1", { mode: "deep" });
    assert.deepEqual(runtime.getMmrSessionFallbackOverrideSnapshot("session-1"), { mode: "deep" });

    // The stale plain object was replaced by a real Map-backed runtime.
    assert.ok(globalThis[RUNTIME_KEY].overrides instanceof Map);
  });

  it("reuses a compatible singleton across accessors", async () => {
    const runtime = await importSource("extensions/mmr-session-fallback/runtime.ts");

    runtime.setMmrSessionFallbackOverride("session-2", { mode: "rush" });
    const instance = globalThis[RUNTIME_KEY];

    // A subsequent accessor sees the same shared state and same instance.
    assert.deepEqual(runtime.getMmrSessionFallbackOverrideSnapshot("session-2"), { mode: "rush" });
    runtime.clearMmrSessionFallbackOverride("session-2");
    assert.equal(runtime.getMmrSessionFallbackOverrideSnapshot("session-2"), undefined);
    assert.equal(globalThis[RUNTIME_KEY], instance);
  });
});
