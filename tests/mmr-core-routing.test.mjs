import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

describe("mmr-core mode routing", () => {
  it("chooses explicit flag mode before session, settings, and default", async () => {
    const { resolveMmrModeSelection } = await importSource("extensions/mmr-core/routing.ts");

    assert.deepEqual(
      resolveMmrModeSelection({
        flagValue: "rush",
        persistedMode: "deep",
        settingsMode: "large",
      }),
      { mode: "rush", source: "flag", warnings: [], rejectedSources: [] },
    );
  });

  it("chooses session mode before settings and default when no flag is provided", async () => {
    const { resolveMmrModeSelection } = await importSource("extensions/mmr-core/routing.ts");

    assert.deepEqual(
      resolveMmrModeSelection({
        persistedMode: "deep",
        settingsMode: "large",
      }),
      { mode: "deep", source: "session", warnings: [], rejectedSources: [] },
    );
  });

  it("chooses settings mode before default and reports invalid settings", async () => {
    const { resolveMmrModeSelection } = await importSource("extensions/mmr-core/routing.ts");

    assert.deepEqual(resolveMmrModeSelection({ settingsMode: "large" }), {
      mode: "large",
      source: "settings",
      warnings: [],
      rejectedSources: [],
    });

    assert.deepEqual(resolveMmrModeSelection({ settingsMode: "test" }), {
      mode: "test",
      source: "settings",
      warnings: [],
      rejectedSources: [],
    });

    assert.deepEqual(resolveMmrModeSelection({ settingsMode: "smartSonnet" }), {
      mode: "smartSonnet",
      source: "settings",
      warnings: [],
      rejectedSources: [],
    });

    assert.deepEqual(resolveMmrModeSelection({ settingsMode: "fast" }), {
      mode: "smart",
      source: "default",
      warnings: ['Ignoring invalid settings MMR mode "fast".'],
      rejectedSources: [{ source: "settings", value: "fast", reason: "invalid mode" }],
    });
  });

  it("captures all invalid sources as rejectedSources", async () => {
    const { resolveMmrModeSelection } = await importSource("extensions/mmr-core/routing.ts");

    const result = resolveMmrModeSelection({
      flagValue: "warp",
      persistedMode: "bogus",
      settingsMode: "fast",
    });

    assert.equal(result.mode, "smart");
    assert.equal(result.source, "default");
    assert.deepEqual(result.rejectedSources, [
      { source: "flag", value: "warp", reason: "invalid mode" },
      { source: "session", value: "bogus", reason: "invalid mode" },
      { source: "settings", value: "fast", reason: "invalid mode" },
    ]);
  });

  it("accepts open and free from flags and persisted session state", async () => {
    const { resolveMmrModeSelection } = await importSource("extensions/mmr-core/routing.ts");

    assert.deepEqual(resolveMmrModeSelection({ flagValue: "open", persistedMode: "deep" }), {
      mode: "open",
      source: "flag",
      warnings: [],
      rejectedSources: [],
    });

    assert.deepEqual(resolveMmrModeSelection({ flagValue: "free", persistedMode: "deep" }), {
      mode: "free",
      source: "flag",
      warnings: [],
      rejectedSources: [],
    });

    assert.deepEqual(resolveMmrModeSelection({ persistedMode: "free", settingsMode: "smart" }), {
      mode: "free",
      source: "session",
      warnings: [],
      rejectedSources: [],
    });
  });
});
