import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, getPreparedSourceRoot, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const SMART_MODEL = { provider: "claude-subscription", id: "claude-opus-4-8" };

function createContext(models = [SMART_MODEL], options = {}) {
  return createMockExtensionContext({ models, model: options.model });
}

function createPi(options = {}) {
  const activeTools = options.activeTools ?? ["read", "bash", "edit", "write"];
  return createMockPi({
    activeTools,
    // Accept either bare tool names or `{ name, sourceInfo }` entries so tests
    // can opt into Pi's source metadata without changing existing fixtures.
    allTools: options.allTools ?? activeTools.slice(),
    thinkingLevel: options.thinkingLevel ?? "off",
    // Per-name flags model real Pi behavior; the legacy `flagValue` (returned
    // by `getFlag(name)` for every name) is still supported for tests that
    // only read a single flag.
    flags: options.flags,
    flagValue: options.flagValue,
    setModelResult: options.setModelResult ?? true,
  });
}

async function importRuntime() {
  const runtimeUrl = pathToFileURL(path.join(getPreparedSourceRoot(), "extensions/mmr-core/runtime.ts")).href;
  return import(runtimeUrl);
}

async function importOwnedTools() {
  const ownedUrl = pathToFileURL(path.join(getPreparedSourceRoot(), "extensions/mmr-core/owned-tools.ts")).href;
  return import(ownedUrl);
}

beforeEach(async () => {
  const runtime = await importRuntime();
  runtime.setMmrModeState(undefined);
  const owned = await importOwnedTools();
  owned.__resetMmrOwnedToolsForTests();
});

describe("mmr-core free mode: pure Pi (pi-mmr-not-installed equivalence)", () => {
  it("drops MMR-owned tools from baseline when entering free from a locked mode", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const owned = await importOwnedTools();
    // Simulate mmr-patch and mmr-web having registered their concrete
    // Pi tools before mmr-core captures its baseline.
    owned.registerMmrOwnedTool("apply_patch");
    owned.registerMmrOwnedTool("web_search");
    owned.registerMmrOwnedTool("read_web_page");

    const baselineTools = ["read", "bash", "edit", "write", "apply_patch", "web_search", "read_web_page"];
    const { ctx } = createContext();
    const { pi, calls, commands, handlers } = createPi({ activeTools: baselineTools, allTools: baselineTools });
    extension(pi);

    // Session start captures the full Pi baseline (which contains the
    // MMR-owned tools) and applies the default locked mode.
    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);
    calls.setActiveTools.length = 0;
    calls.setModel.length = 0;
    calls.appendEntry.length = 0;

    await commands.get("mode").handler("free", ctx);

    const setActive = calls.setActiveTools.at(-1);
    assert.deepEqual(
      setActive,
      ["read", "bash", "edit", "write"],
      "free mode must restore baseline tools minus MMR-owned concrete tools",
    );
    assert.equal(setActive.includes("apply_patch"), false);
    assert.equal(setActive.includes("web_search"), false);
    assert.equal(setActive.includes("read_web_page"), false);
  });

  it("preserves tools from unrelated extensions in free mode", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const owned = await importOwnedTools();
    owned.registerMmrOwnedTool("apply_patch");
    owned.registerMmrOwnedTool("web_search");

    const baselineTools = ["read", "bash", "edit", "write", "apply_patch", "web_search", "third_party_tool"];
    const { ctx } = createContext();
    const { pi, calls, commands, handlers } = createPi({ activeTools: baselineTools, allTools: baselineTools });
    extension(pi);

    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);
    calls.setActiveTools.length = 0;

    await commands.get("mode").handler("free", ctx);

    const setActive = calls.setActiveTools.at(-1);
    assert.equal(setActive.includes("third_party_tool"), true, "non-MMR extension tool must remain active in free");
    assert.equal(setActive.includes("apply_patch"), false);
    assert.equal(setActive.includes("web_search"), false);
  });

  it("drops MMR-owned tools on native-control opt-out from a locked mode", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const owned = await importOwnedTools();
    owned.registerMmrOwnedTool("apply_patch");

    const baselineTools = ["read", "bash", "edit", "write", "apply_patch"];
    const { ctx } = createContext();
    const { pi, calls, handlers } = createPi({ activeTools: baselineTools, allTools: baselineTools });
    extension(pi);

    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);
    calls.setActiveTools.length = 0;
    calls.setModel.length = 0;

    await handlers.get("model_select")({
      type: "model_select",
      model: { provider: "openai-codex", id: "gpt-5.5" },
      previousModel: SMART_MODEL,
      source: "cycle",
    }, ctx);

    const setActive = calls.setActiveTools.at(-1);
    assert.deepEqual(setActive, ["read", "bash", "edit", "write"]);
    assert.equal(setActive.includes("apply_patch"), false);
  });

  it("drops MMR-owned tools when --mmr-mode free is the initial selection at session start", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const owned = await importOwnedTools();
    owned.registerMmrOwnedTool("apply_patch");
    owned.registerMmrOwnedTool("web_search");
    owned.registerMmrOwnedTool("read_web_page");

    const baselineTools = ["read", "bash", "edit", "write", "apply_patch", "web_search", "read_web_page"];
    const { ctx } = createContext();
    const { pi, calls, handlers } = createPi({
      // Use per-name flags here instead of the legacy `flagValue` shorthand.
      // The legacy form returns the same value for every `getFlag(name)`
      // lookup, which now collides with mmr-core's `--mmr-subagent` flag and
      // would mis-trigger subagent activation. Real Pi keeps each flag
      // isolated by name, so per-name flags model real-world behavior.
      flags: { "mmr-mode": "free" },
      activeTools: baselineTools,
      allTools: baselineTools,
    });
    extension(pi);

    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);

    const setActive = calls.setActiveTools.at(-1);
    assert.deepEqual(setActive, ["read", "bash", "edit", "write"]);
  });

  it("does nothing extra when no MMR-owned tools are registered", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const baselineTools = ["read", "bash", "edit", "write", "third_party_tool"];
    const { ctx } = createContext();
    const { pi, calls, commands, handlers } = createPi({ activeTools: baselineTools, allTools: baselineTools });
    extension(pi);

    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);
    calls.setActiveTools.length = 0;

    await commands.get("mode").handler("free", ctx);

    assert.deepEqual(calls.setActiveTools.at(-1), baselineTools);
  });
});

describe("mmr-core free mode: source-aware MMR ownership", () => {
  const MMR_PATCH_PATH = "/abs/path/to/pi-mmr/src/extensions/mmr-patch/index.ts";
  const THIRD_PARTY_PATH = "/abs/path/to/other-pkg/src/extensions/patch/index.ts";

  it("drops an MMR-owned name when the active registration's source is an MMR extension path", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const owned = await importOwnedTools();
    owned.registerMmrOwnedTool("apply_patch");
    owned.registerMmrOwnedExtensionPath(MMR_PATCH_PATH);

    const baselineTools = ["read", "bash", "edit", "write", "apply_patch"];
    const { ctx } = createContext();
    const { pi, calls, commands, handlers } = createPi({
      activeTools: baselineTools,
      allTools: [
        "read",
        "bash",
        "edit",
        "write",
        { name: "apply_patch", sourceInfo: { path: MMR_PATCH_PATH } },
      ],
    });
    extension(pi);

    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);
    calls.setActiveTools.length = 0;

    await commands.get("mode").handler("free", ctx);

    const setActive = calls.setActiveTools.at(-1);
    assert.equal(setActive.includes("apply_patch"), false, "MMR-owned name + MMR source must be dropped");
  });

  it("preserves an MMR-owned name when the active registration's source is a third-party extension", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const owned = await importOwnedTools();
    owned.registerMmrOwnedTool("apply_patch");
    // mmr-patch path is registered, but the currently-active apply_patch
    // tool was contributed by a third-party extension at a different path.
    owned.registerMmrOwnedExtensionPath(MMR_PATCH_PATH);

    const baselineTools = ["read", "bash", "edit", "write", "apply_patch"];
    const { ctx } = createContext();
    const { pi, calls, commands, handlers } = createPi({
      activeTools: baselineTools,
      allTools: [
        "read",
        "bash",
        "edit",
        "write",
        { name: "apply_patch", sourceInfo: { path: THIRD_PARTY_PATH } },
      ],
    });
    extension(pi);

    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);
    calls.setActiveTools.length = 0;

    await commands.get("mode").handler("free", ctx);

    const setActive = calls.setActiveTools.at(-1);
    assert.equal(
      setActive.includes("apply_patch"),
      true,
      "MMR-owned name + third-party source must be preserved in free mode",
    );
  });

  it("falls back to name-based filtering when sourceInfo is missing", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const owned = await importOwnedTools();
    owned.registerMmrOwnedTool("apply_patch");
    owned.registerMmrOwnedExtensionPath(MMR_PATCH_PATH);

    const baselineTools = ["read", "bash", "edit", "write", "apply_patch"];
    const { ctx } = createContext();
    // allTools omits sourceInfo entirely (bare {name}) — Pi cannot tell
    // us the source. Fall back to dropping by name to stay conservative.
    const { pi, calls, commands, handlers } = createPi({
      activeTools: baselineTools,
      allTools: baselineTools,
    });
    extension(pi);

    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);
    calls.setActiveTools.length = 0;

    await commands.get("mode").handler("free", ctx);

    const setActive = calls.setActiveTools.at(-1);
    assert.equal(setActive.includes("apply_patch"), false, "missing sourceInfo must fall back to name-based drop");
  });

  it("keeps non-MMR-owned tool names regardless of source", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const owned = await importOwnedTools();
    owned.registerMmrOwnedTool("apply_patch");
    owned.registerMmrOwnedExtensionPath(MMR_PATCH_PATH);

    const baselineTools = ["read", "bash", "edit", "write", "unrelated_tool"];
    const { ctx } = createContext();
    // Even if an unrelated tool somehow reports an MMR extension path as
    // its source (highly unlikely; defensive), an unowned name must never
    // be filtered.
    const { pi, calls, commands, handlers } = createPi({
      activeTools: baselineTools,
      allTools: [
        "read",
        "bash",
        "edit",
        "write",
        { name: "unrelated_tool", sourceInfo: { path: MMR_PATCH_PATH } },
      ],
    });
    extension(pi);

    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);
    calls.setActiveTools.length = 0;

    await commands.get("mode").handler("free", ctx);

    const setActive = calls.setActiveTools.at(-1);
    assert.equal(
      setActive.includes("unrelated_tool"),
      true,
      "unowned name must always be preserved regardless of source",
    );
  });
});
