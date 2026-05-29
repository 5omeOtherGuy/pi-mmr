import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const MODULE = "extensions/mmr-core/subagent-model-override-env.ts";

describe("subagent model-preference env channel (#9)", () => {
  it("round-trips a normalized preference list", async () => {
    const mod = await importSource(MODULE);
    const prefs = [
      { model: "claude-opus-4-6", providers: ["claude-subscription"], thinkingLevel: "high" },
      { model: "gpt-5.5" },
    ];
    const serialized = mod.serializeMmrSubagentModelPreferencesEnv(prefs);
    assert.equal(typeof serialized, "string");
    const parsed = mod.parseMmrSubagentModelPreferencesEnv(serialized);
    assert.deepEqual(parsed, prefs);
  });

  it("serializes empty/absent lists to undefined so the var is omitted", async () => {
    const mod = await importSource(MODULE);
    assert.equal(mod.serializeMmrSubagentModelPreferencesEnv(undefined), undefined);
    assert.equal(mod.serializeMmrSubagentModelPreferencesEnv([]), undefined);
  });

  it("normalizes string shorthand entries via the settings parser", async () => {
    const mod = await importSource(MODULE);
    const parsed = mod.parseMmrSubagentModelPreferencesEnv(JSON.stringify(["claude-subscription/claude-opus-4-6", "gpt-5.5"]));
    assert.deepEqual(parsed, [
      { providers: ["claude-subscription"], model: "claude-opus-4-6" },
      { model: "gpt-5.5" },
    ]);
  });

  it("falls safe to undefined for missing/blank/malformed/non-array payloads", async () => {
    const mod = await importSource(MODULE);
    assert.equal(mod.parseMmrSubagentModelPreferencesEnv(undefined), undefined);
    assert.equal(mod.parseMmrSubagentModelPreferencesEnv(""), undefined);
    assert.equal(mod.parseMmrSubagentModelPreferencesEnv("   "), undefined);
    assert.equal(mod.parseMmrSubagentModelPreferencesEnv("{not json"), undefined);
    assert.equal(mod.parseMmrSubagentModelPreferencesEnv(JSON.stringify({ model: "x" })), undefined);
    // Array with only unparseable entries collapses to undefined, never a
    // weakened override.
    assert.equal(mod.parseMmrSubagentModelPreferencesEnv(JSON.stringify([42, null, {}])), undefined);
  });
});
