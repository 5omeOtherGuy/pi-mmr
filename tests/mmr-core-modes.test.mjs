import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

describe("mmr-core mode table", () => {
  it("defines smart, rush, and large with the documented provider-neutral preferences", async () => {
    const { getMmrMode } = await importSource("extensions/mmr-core/modes.ts");

    assert.deepEqual(getMmrMode("smart").modelPreferences, [
      { model: "claude-opus-4-8" },
      { model: "gpt-5.5" },
    ]);
    assert.equal(getMmrMode("smart").thinkingLevel, "medium");

    assert.deepEqual(getMmrMode("rush").modelPreferences, [
      { model: "gpt-5.5", thinkingLevel: "off" },
      { model: "claude-haiku-4-5-20251001", thinkingLevel: "off" },
      { model: "claude-haiku-4-5", thinkingLevel: "off" },
    ]);
    assert.equal(getMmrMode("rush").thinkingLevel, "off");

    assert.deepEqual(getMmrMode("large").modelPreferences, [
      { model: "claude-opus-4-6" },
      { model: "gpt-5.4" },
    ]);
    assert.equal(getMmrMode("large").thinkingLevel, "medium");

    assert.equal("provider" in getMmrMode("smart"), false);
  });

  it("defines deep with gpt-5.5 and an Opus fallback", async () => {
    const { getMmrMode } = await importSource("extensions/mmr-core/modes.ts");

    assert.deepEqual(getMmrMode("deep").modelPreferences, [
      { model: "gpt-5.5" },
      { model: "claude-opus-4-8" },
    ]);
    assert.equal("provider" in getMmrMode("deep"), false);
    assert.equal(getMmrMode("deep").thinkingLevel, "medium");
  });

  it("defines test as rush behavior with Opus 4.8 medium", async () => {
    const { getMmrMode } = await importSource("extensions/mmr-core/modes.ts");

    const rush = getMmrMode("rush");
    const test = getMmrMode("test");

    assert.deepEqual(test.modelPreferences, [
      { model: "claude-opus-4-8", thinkingLevel: "medium" },
    ]);
    assert.equal(test.thinkingLevel, "medium");
    assert.deepEqual(test.tools, rush.tools);
    assert.equal(test.promptRoute, rush.promptRoute);
    assert.deepEqual(test.featureGates, rush.featureGates);
  });

  it("renders mode list using per-mode request thinking and context metadata", async () => {
    const { formatMmrModeList } = await importSource("extensions/mmr-core/modes.ts");

    const list = formatMmrModeList();

    assert.match(list, /smart\s+claude-opus-4-8 → gpt-5\.5 — thinking: Anthropic adaptive\/high; context: 300k total \/ 64k max out \/ 236k max in/);
    assert.match(list, /rush\s+gpt-5\.5 → claude-haiku-4-5-20251001 → claude-haiku-4-5 — thinking: OpenAI Responses none; context: 128k max out/);
    assert.match(list, /large\s+claude-opus-4-6 → gpt-5\.4 — thinking: Anthropic adaptive\/medium; context: 1M total \/ 32k max out \/ 968k max in/);
    assert.match(list, /deep\s+gpt-5\.5 → claude-opus-4-8 — thinking: Anthropic adaptive\/medium; context: 128k max out/);
  });

  it("does not warn that shipped librarian support is still reserved", async () => {
    const { MMR_MODE_KEYS, getMmrMode } = await importSource("extensions/mmr-core/modes.ts");

    for (const key of MMR_MODE_KEYS) {
      const notes = getMmrMode(key).availabilityNotes ?? [];
      assert.equal(
        notes.some((note) => /librarian.*reserved|reserved.*librarian|future mmr-subagents work/i.test(note)),
        false,
        `${key} must not claim librarian is still future-only`,
      );
    }
  });

  it("keeps task_list in every enforced mode until a mode explicitly adopts Task as replacement", async () => {
    const { MMR_MODE_KEYS, getMmrMode } = await importSource("extensions/mmr-core/modes.ts");

    for (const key of MMR_MODE_KEYS) {
      const mode = getMmrMode(key);
      if (mode.tools.length === 0) continue; // free mode runs without tool enforcement
      assert.ok(
        mode.tools.includes("task_list"),
        `${key} mode must keep task_list until it explicitly adopts Task as replacement`,
      );
    }
  });

  it("defines open as native Pi controls with Smart-equivalent tools, while free remains pure native", async () => {
    const { formatMmrModeList, getMmrMode, isMmrModeKey, MMR_MODE_KEYS } = await importSource("extensions/mmr-core/modes.ts");

    const smart = getMmrMode("smart");
    const open = getMmrMode("open");
    const free = getMmrMode("free");

    assert.deepEqual(MMR_MODE_KEYS, ["smart", "smartGPT", "rush", "test", "large", "deep", "open", "free"]);
    assert.equal(isMmrModeKey("open"), true);
    assert.equal(isMmrModeKey("free"), true);
    assert.equal(open.displayName, "Open");
    assert.deepEqual(open.modelPreferences, []);
    assert.equal(open.thinkingLevel, undefined);
    assert.deepEqual(open.tools, smart.tools);
    assert.equal(open.tools, smart.tools, "open must share Smart's tool intent instead of duplicating it");
    assert.match(open.description, /Smart tools/i);
    assert.equal(free.displayName, "Free");
    assert.deepEqual(free.modelPreferences, []);
    assert.equal(free.thinkingLevel, undefined);
    assert.deepEqual(free.tools, []);
    assert.match(free.description, /native Pi/i);
    assert.match(formatMmrModeList(), /open\s+native Pi controls/i);
    assert.match(formatMmrModeList(), /free\s+native Pi controls/i);
  });
});
