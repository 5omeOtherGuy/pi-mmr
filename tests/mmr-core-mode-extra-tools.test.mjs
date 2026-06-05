import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const RUNTIME_MODULE = "extensions/mmr-core/runtime.ts";

describe("mmr-core mode-extra-tool provider hook", () => {
  it("contributes extra tool names per mode + cwd, deduped, and survives a throwing provider", async () => {
    const { registerMmrModeExtraToolProvider, resolveMmrModeExtraTools } = await importSource(RUNTIME_MODULE);

    registerMmrModeExtraToolProvider({
      name: "test-a",
      getExtraTools: ({ modeKey }) => (modeKey === "deep" ? ["sa__alpha", "sa__beta"] : []),
    });
    registerMmrModeExtraToolProvider({
      name: "test-b",
      getExtraTools: ({ modeKey }) => (modeKey === "deep" ? ["sa__beta", "sa__gamma"] : ["sa__smartonly"]),
    });
    registerMmrModeExtraToolProvider({
      name: "test-throws",
      getExtraTools: () => { throw new Error("boom"); },
    });

    const deep = resolveMmrModeExtraTools("deep", "/repo");
    assert.deepEqual(deep, ["sa__alpha", "sa__beta", "sa__gamma"], "deduped union; throwing provider ignored");
    const smart = resolveMmrModeExtraTools("smart", "/repo");
    assert.deepEqual(smart, ["sa__smartonly"]);
  });

  it("replaces a provider registered under the same name (in-process reload)", async () => {
    const { registerMmrModeExtraToolProvider, resolveMmrModeExtraTools } = await importSource(RUNTIME_MODULE);
    registerMmrModeExtraToolProvider({ name: "reload", getExtraTools: () => ["sa__old"] });
    registerMmrModeExtraToolProvider({ name: "reload", getExtraTools: () => ["sa__new"] });
    const result = resolveMmrModeExtraTools("deep", "/repo");
    assert.ok(result.includes("sa__new"));
    assert.ok(!result.includes("sa__old"), "same-name provider replaced, not stacked");
  });
});
