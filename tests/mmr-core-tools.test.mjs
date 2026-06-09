import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

describe("mmr-core tool registry", () => {
  it("resolves requested tool names by identity against the live Pi inventory", async () => {
    const { createMmrToolRegistry } = await importSource("extensions/mmr-core/tool-registry.ts");
    const registry = createMmrToolRegistry();

    const resolved = registry.resolve(["read", "bash", "find"], ["read", "bash", "find"]);

    assert.deepEqual(resolved.activeTools, ["read", "bash", "find"]);
    assert.deepEqual(resolved.missingTools, []);
    assert.deepEqual(resolved.deferredTools, []);
    assert.deepEqual(resolved.gatedTools, []);
    assert.deepEqual(resolved.disabledTools, []);

    const readDecision = resolved.decisions.find((d) => d.requested === "read");
    assert.equal(readDecision.status, "active");
    assert.equal(readDecision.chosen, "read");
    assert.deepEqual(readDecision.chosenTools, ["read"]);
    assert.equal(readDecision.owner, "mmr-core");
    assert.match(readDecision.diagnostic, /read/);
  });

  it("does not translate legacy aliases or capitalized Pi-style names", async () => {
    const { createMmrToolRegistry } = await importSource("extensions/mmr-core/tool-registry.ts");
    const registry = createMmrToolRegistry();

    // Legacy aliases and capitalized variants are no longer recognized: they
    // are treated as unknown names with no identity match against Pi tools.
    const resolved = registry.resolve(
      ["Read", "Bash", "Edit", "Write", "Grep", "LS", "glob", "edit_file", "create_file", "shell_command"],
      ["read", "bash", "edit", "write", "grep", "ls", "find"],
    );

    assert.deepEqual(resolved.activeTools, []);
    assert.deepEqual(
      [...resolved.missingTools].sort(),
      ["Bash", "Edit", "Grep", "LS", "Read", "Write", "create_file", "edit_file", "glob", "shell_command"],
    );
    for (const decision of resolved.decisions) {
      assert.equal(decision.status, "missing");
      assert.equal(decision.owner, "mmr-core");
    }
  });

  it("classifies known extension-owned tools as deferred when Pi has not registered them", async () => {
    const { createMmrToolRegistry } = await importSource("extensions/mmr-core/tool-registry.ts");
    const registry = createMmrToolRegistry();

    const resolved = registry.resolve(["oracle", "finder", "web_search", "chart"], ["read", "bash"]);

    assert.deepEqual(resolved.activeTools, []);
    assert.deepEqual(resolved.missingTools, []);
    assert.deepEqual([...resolved.deferredTools].sort(), ["chart", "finder", "oracle", "web_search"]);

    const oracleDecision = resolved.decisions.find((d) => d.requested === "oracle");
    assert.equal(oracleDecision.status, "deferred");
    assert.equal(oracleDecision.owner, "mmr-subagents");
    assert.match(oracleDecision.diagnostic, /mmr-subagents/);

    const chartDecision = resolved.decisions.find((d) => d.requested === "chart");
    assert.equal(chartDecision.status, "deferred");
    assert.equal(chartDecision.owner, "mmr-tasks");

    const webDecision = resolved.decisions.find((d) => d.requested === "web_search");
    assert.equal(webDecision.owner, "mmr-web");
  });

  it("reports a tool with no provider claim, no catalog entry, and no identity match as missing", async () => {
    const { createMmrToolRegistry } = await importSource("extensions/mmr-core/tool-registry.ts");
    const registry = createMmrToolRegistry();

    const resolved = registry.resolve(["definitely_not_a_tool"], ["read", "bash"]);

    assert.deepEqual(resolved.activeTools, []);
    assert.deepEqual(resolved.missingTools, ["definitely_not_a_tool"]);
    assert.deepEqual(resolved.deferredTools, []);
    const decision = resolved.decisions[0];
    assert.equal(decision.status, "missing");
    assert.equal(decision.chosen, undefined);
    assert.match(decision.diagnostic, /no Pi tool/);
  });

  it("treats apply_patch as identity-only with no fallback to edit+write", async () => {
    const { createMmrToolRegistry } = await importSource("extensions/mmr-core/tool-registry.ts");
    const registry = createMmrToolRegistry();

    const concrete = registry.resolve(["apply_patch"], ["apply_patch", "edit", "write"]);
    assert.deepEqual(concrete.activeTools, ["apply_patch"]);
    assert.equal(concrete.decisions[0].status, "active");
    assert.equal(concrete.decisions[0].owner, "mmr-patch");

    // Without a concrete apply_patch tool, the decision is deferred (no
    // fallback to edit+write). Callers that want narrow edit/write tools
    // must request `edit` and `write` directly.
    const fallback = registry.resolve(["apply_patch"], ["edit", "write"]);
    assert.deepEqual(fallback.activeTools, []);
    assert.deepEqual(fallback.deferredTools, ["apply_patch"]);
    assert.equal(fallback.decisions[0].status, "deferred");
    assert.equal(fallback.decisions[0].owner, "mmr-patch");
  });

  it("credits the catalog owner when Pi registers an extension-owned tool without a provider claim", async () => {
    // This covers Pi loaders that give each extension an isolated module
    // cache, where mmr-web's `registerMmrToolProvider(...)` call cannot
    // reach mmr-core's registry instance. The exact-name catalog still
    // credits mmr-web as the owner once the concrete Pi tool is exposed.
    const { createMmrToolRegistry } = await importSource("extensions/mmr-core/tool-registry.ts");
    const registry = createMmrToolRegistry();

    const both = registry.resolve(
      ["web_search", "read_web_page"],
      ["read", "bash", "edit", "write", "web_search", "read_web_page"],
    );
    assert.equal(both.activeTools.includes("web_search"), true);
    assert.equal(both.activeTools.includes("read_web_page"), true);
    const search = both.decisions.find((d) => d.requested === "web_search");
    const reader = both.decisions.find((d) => d.requested === "read_web_page");
    assert.equal(search.status, "active");
    assert.equal(search.owner, "mmr-web");
    assert.deepEqual(search.chosenTools, ["web_search"]);
    assert.equal(reader.status, "active");
    assert.equal(reader.owner, "mmr-web");
    assert.deepEqual(reader.chosenTools, ["read_web_page"]);

    // Mixed availability: only the reader tool is registered.
    const readerOnly = registry.resolve(
      ["web_search", "read_web_page"],
      ["read", "bash", "edit", "write", "read_web_page"],
    );
    const searchOnly = readerOnly.decisions.find((d) => d.requested === "web_search");
    assert.equal(searchOnly.status, "deferred");
    assert.equal(searchOnly.owner, "mmr-web");
    assert.equal(
      readerOnly.decisions.find((d) => d.requested === "read_web_page").status,
      "active",
    );

    // No mmr-web tools registered at all (extension disabled).
    const none = registry.resolve(
      ["web_search", "read_web_page"],
      ["read", "bash", "edit", "write"],
    );
    assert.deepEqual([...none.deferredTools].sort(), ["read_web_page", "web_search"]);
    for (const decision of none.decisions) {
      assert.equal(decision.status, "deferred");
      assert.equal(decision.owner, "mmr-web");
    }
  });

  it("dedupes activeTools when the same canonical name is requested twice", async () => {
    const { createMmrToolRegistry } = await importSource("extensions/mmr-core/tool-registry.ts");
    const registry = createMmrToolRegistry();

    const resolved = registry.resolve(["edit", "edit"], ["edit"]);

    assert.deepEqual(resolved.activeTools, ["edit"]);
    assert.equal(resolved.decisions.length, 2);
    for (const decision of resolved.decisions) {
      assert.equal(decision.status, "active");
      assert.equal(decision.chosen, "edit");
    }
  });

  it("registerProvider lets later modules claim a tool as active, gated, or disabled", async () => {
    const { createMmrToolRegistry } = await importSource("extensions/mmr-core/tool-registry.ts");
    const registry = createMmrToolRegistry();

    registry.registerProvider({
      name: "mmr-subagents",
      resolve: (toolName) => {
        if (toolName === "oracle") return { kind: "active" };
        if (toolName === "Task") return { kind: "gated", gate: "mmr-subagents", reason: "feature gate disabled" };
        if (toolName === "finder") return { kind: "disabled", reason: "finder is administratively disabled" };
        return undefined;
      },
    });

    const resolved = registry.resolve(["oracle", "Task", "finder"], ["oracle"]);

    assert.deepEqual(resolved.activeTools, ["oracle"]);
    assert.deepEqual(resolved.gatedTools, ["Task"]);
    assert.deepEqual(resolved.disabledTools, ["finder"]);
    assert.deepEqual(resolved.deferredTools, []);

    const oracle = resolved.decisions.find((d) => d.requested === "oracle");
    assert.equal(oracle.status, "active");
    assert.equal(oracle.owner, "mmr-subagents");

    const task = resolved.decisions.find((d) => d.requested === "Task");
    assert.equal(task.status, "gated");
    assert.equal(task.owner, "mmr-subagents");
    assert.match(task.diagnostic, /gate/i);

    const finder = resolved.decisions.find((d) => d.requested === "finder");
    assert.equal(finder.status, "disabled");
    assert.equal(finder.owner, "mmr-subagents");
    assert.match(finder.diagnostic, /disabled/i);
  });

  it("latest-registered provider wins when two providers claim the same exact name", async () => {
    const { createMmrToolRegistry } = await importSource("extensions/mmr-core/tool-registry.ts");
    const registry = createMmrToolRegistry();

    registry.registerProvider({
      name: "older-provider",
      resolve: (toolName) => (toolName === "oracle" ? { kind: "gated", gate: "older", reason: "older says gated" } : undefined),
    });
    registry.registerProvider({
      name: "newer-provider",
      resolve: (toolName) => (toolName === "oracle" ? { kind: "active" } : undefined),
    });

    const resolved = registry.resolve(["oracle"], ["oracle"]);
    const decision = resolved.decisions[0];
    assert.equal(decision.status, "active");
    assert.equal(decision.owner, "newer-provider", "newer provider must win over the older one");
  });

  it("falls through to an older provider when the newer one returns undefined for an unowned name", async () => {
    const { createMmrToolRegistry } = await importSource("extensions/mmr-core/tool-registry.ts");
    const registry = createMmrToolRegistry();

    registry.registerProvider({
      name: "older-provider",
      resolve: (toolName) => (toolName === "oracle" ? { kind: "gated", gate: "older", reason: "older says gated" } : undefined),
    });
    registry.registerProvider({
      name: "newer-provider",
      // newer-provider only claims `finder`, not `oracle`; oracle must fall
      // through to older-provider's rule.
      resolve: (toolName) => (toolName === "finder" ? { kind: "active" } : undefined),
    });

    const resolved = registry.resolve(["oracle"], ["finder"]);
    const decision = resolved.decisions[0];
    assert.equal(decision.status, "gated");
    assert.equal(decision.owner, "older-provider");
  });

  it("keeps chart catalog-deferred when mmr-tasks is loaded but that tool has not shipped", async () => {
    const { createMmrToolRegistry } = await importSource("extensions/mmr-core/tool-registry.ts");
    const registry = createMmrToolRegistry();

    // Simulate the mmr-tasks provider: it only claims its shipped name
    // (task_list) and returns undefined for the rest (e.g. chart).
    registry.registerProvider({
      name: "mmr-tasks",
      resolve: (toolName) => (toolName === "task_list" ? { kind: "active" } : undefined),
    });

    const resolved = registry.resolve(["chart"], ["apply_patch", "task_list"]);
    for (const decision of resolved.decisions) {
      assert.equal(decision.status, "deferred", `${decision.requested} must stay catalog-deferred`);
      assert.equal(decision.owner, "mmr-tasks", `${decision.requested} catalog owner must remain mmr-tasks`);
    }
  });

  it("reports a missing decision when a provider claims active but Pi has not registered the tool", async () => {
    const { createMmrToolRegistry } = await importSource("extensions/mmr-core/tool-registry.ts");
    const registry = createMmrToolRegistry();

    registry.registerProvider({
      name: "mmr-web",
      resolve: (toolName) => (toolName === "web_search" ? { kind: "active" } : undefined),
    });

    const resolved = registry.resolve(["web_search"], ["read", "bash"]);
    assert.deepEqual(resolved.activeTools, []);
    assert.deepEqual(resolved.missingTools, ["web_search"]);
    const decision = resolved.decisions[0];
    assert.equal(decision.status, "missing");
    assert.equal(decision.owner, "mmr-web");
    assert.match(decision.diagnostic, /claimed by mmr-web/);
  });

  it("isToolAllowed returns true only for concrete tools listed in activeTools", async () => {
    const { createMmrToolRegistry } = await importSource("extensions/mmr-core/tool-registry.ts");
    const registry = createMmrToolRegistry();
    const resolved = registry.resolve(["read", "oracle"], ["read"]);

    assert.equal(registry.isToolAllowed("read", resolved), true);
    assert.equal(registry.isToolAllowed("oracle", resolved), false);
  });
});

describe("mmr-core tool registry - per-mode matrices", () => {
  it("resolves smart and large modes to read/bash/edit/write against Pi-native tools", async () => {
    const { resolveMmrTools } = await importSource("extensions/mmr-core/runtime.ts");
    const available = ["read", "bash", "edit", "write", "grep", "find", "ls"];

    for (const mode of ["smart", "large"]) {
      const resolved = resolveMmrTools(mode, available);
      assert.deepEqual(
        [...resolved.activeTools].sort(),
        ["bash", "edit", "read", "write"],
        `${mode}: per-mode active tools`,
      );
      // smart/large delegate search/list to model-backed tools, so direct grep/find/ls are not requested.
      assert.equal(resolved.activeTools.includes("grep"), false, `${mode}: grep is not requested in smart/large`);
      assert.equal(resolved.activeTools.includes("find"), false, `${mode}: find is not requested in smart/large`);
      assert.equal(resolved.activeTools.includes("ls"), false, `${mode}: ls is not requested in smart/large`);
      assert.equal(resolved.deferredTools.includes("oracle"), true, `${mode}: oracle is deferred`);
      assert.equal(resolved.deferredTools.includes("finder"), true, `${mode}: finder is deferred`);
      assert.equal(resolved.deferredTools.includes("web_search"), true, `${mode}: web_search is deferred`);
    }
  });

  it("resolves rush to keep direct grep/find alongside read/bash/edit/write", async () => {
    const { resolveMmrTools } = await importSource("extensions/mmr-core/runtime.ts");
    const available = ["read", "bash", "edit", "write", "grep", "find", "ls"];

    const resolved = resolveMmrTools("rush", available);
    assert.equal(resolved.activeTools.includes("grep"), true);
    assert.equal(resolved.activeTools.includes("find"), true);
    assert.equal(resolved.activeTools.includes("read"), true);
    assert.equal(resolved.activeTools.includes("bash"), true);
    assert.equal(resolved.activeTools.includes("edit"), true);
    assert.equal(resolved.activeTools.includes("write"), true);
    assert.equal(resolved.deferredTools.includes("Task"), true);
  });

  it("resolves deep using bash, apply_patch, edit, and write (each requested directly)", async () => {
    const { resolveMmrTools } = await importSource("extensions/mmr-core/runtime.ts");

    const withConcretePatch = resolveMmrTools("deep", ["read", "bash", "edit", "write", "grep", "find", "ls", "apply_patch"]);
    assert.deepEqual([...withConcretePatch.activeTools].sort(), ["apply_patch", "bash", "edit", "write"]);

    // Without apply_patch, deep still activates the directly requested edit/write/bash.
    const fallback = resolveMmrTools("deep", ["read", "bash", "edit", "write", "grep", "find", "ls"]);
    assert.equal(fallback.activeTools.includes("bash"), true);
    assert.equal(fallback.activeTools.includes("edit"), true);
    assert.equal(fallback.activeTools.includes("write"), true);
    assert.equal(fallback.deferredTools.includes("apply_patch"), true);
    // deep does not request read directly; reading is delegated.
    assert.equal(fallback.activeTools.includes("read"), false);
    assert.equal(fallback.deferredTools.includes("oracle"), true);
    assert.equal(fallback.deferredTools.includes("finder"), true);
    assert.equal(fallback.deferredTools.includes("chart"), true);
  });
});

describe("mmr-core tool registry - state and diagnostics surface", () => {
  it("propagates gatedTools and disabledTools onto MmrModeState and the persisted snapshot", async () => {
    const { createMmrModeState, toPersistedModeState } = await importSource("extensions/mmr-core/state.ts");
    const { getMmrMode } = await importSource("extensions/mmr-core/modes.ts");

    const state = createMmrModeState({
      mode: getMmrMode("smart"),
      source: "command",
      modelResolution: {
        targetModel: "claude-opus-4-8",
        requestedModels: ["claude-opus-4-8"],
        selectedProvider: "claude-subscription",
        selectedModel: "claude-opus-4-8",
        modelFound: true,
        modelApplied: true,
        fallbackApplied: false,
        candidates: [],
      },
      tools: {
        requestedTools: ["read", "Task", "finder"],
        activeTools: ["read"],
        missingTools: [],
        deferredTools: [],
        gatedTools: ["Task"],
        disabledTools: ["finder"],
        decisions: [
          { requested: "read", chosen: "read", chosenTools: ["read"], candidates: ["read"], status: "active", owner: "mmr-core", diagnostic: "read \u2192 read" },
          { requested: "Task", chosenTools: [], candidates: [], status: "gated", owner: "mmr-subagents", diagnostic: "Task: gated behind mmr-subagents (feature gate disabled)" },
          { requested: "finder", chosenTools: [], candidates: [], status: "disabled", owner: "mmr-subagents", diagnostic: "finder: disabled (administratively disabled)" },
        ],
      },
      appliedAt: "2026-05-08T00:00:00.000Z",
    });

    assert.deepEqual(state.gatedTools, ["Task"]);
    assert.deepEqual(state.disabledTools, ["finder"]);

    const persisted = toPersistedModeState(state);
    assert.deepEqual(persisted.gatedTools, ["Task"]);
    assert.deepEqual(persisted.disabledTools, ["finder"]);
  });

  it("/mmr-status surfaces gated/disabled sections and the per-decision diagnostic text", async () => {
    const { createMmrModeState } = await importSource("extensions/mmr-core/state.ts");
    const { getMmrMode } = await importSource("extensions/mmr-core/modes.ts");
    const { formatMmrStatus } = await importSource("extensions/mmr-core/status.ts");

    const state = createMmrModeState({
      mode: getMmrMode("smart"),
      source: "command",
      modelResolution: {
        targetModel: "claude-opus-4-8",
        requestedModels: ["claude-opus-4-8"],
        selectedProvider: "claude-subscription",
        selectedModel: "claude-opus-4-8",
        modelFound: true,
        modelApplied: true,
        fallbackApplied: false,
        candidates: [],
      },
      tools: {
        requestedTools: ["read", "Task", "finder"],
        activeTools: ["read"],
        missingTools: [],
        deferredTools: [],
        gatedTools: ["Task"],
        disabledTools: ["finder"],
        decisions: [
          { requested: "read", chosen: "read", chosenTools: ["read"], candidates: ["read"], status: "active", owner: "mmr-core", diagnostic: "read \u2192 read" },
          { requested: "Task", chosenTools: [], candidates: [], status: "gated", owner: "mmr-subagents", diagnostic: "Task: gated behind mmr-subagents (feature gate disabled)" },
          { requested: "finder", chosenTools: [], candidates: [], status: "disabled", owner: "mmr-subagents", diagnostic: "finder: disabled (administratively disabled)" },
        ],
      },
      appliedAt: "2026-05-08T00:00:00.000Z",
    });

    const output = formatMmrStatus(state);

    assert.match(output, /Gated tools: Task/);
    assert.match(output, /Disabled tools: finder/);
    assert.match(output, /Task: gated behind mmr-subagents \(feature gate disabled\)/);
    assert.match(output, /finder: disabled \(administratively disabled\)/);
  });
});

describe("mmr-core tool registry - root API", () => {
  it("exports registerMmrToolProvider from the package root and the core extension", async () => {
    const root = await importSource("index.ts");
    assert.equal(typeof root.registerMmrToolProvider, "function");

    const runtime = await importSource("extensions/mmr-core/runtime.ts");
    assert.equal(typeof runtime.registerMmrToolProvider, "function");
  });

  it("does not export the removed registerMmrToolAlias helper", async () => {
    const root = await importSource("index.ts");
    assert.equal(root.registerMmrToolAlias, undefined);

    const runtime = await importSource("extensions/mmr-core/runtime.ts");
    assert.equal(runtime.registerMmrToolAlias, undefined);
  });

  it("createMmrCoreRuntime exposes registerToolProvider that overrides defaults for that runtime instance", async () => {
    const { createMmrCoreRuntime } = await importSource("extensions/mmr-core/runtime.ts");
    const runtime = createMmrCoreRuntime();

    runtime.registerToolProvider({
      name: "mmr-subagents-test",
      resolve: (toolName) => (toolName === "oracle" ? { kind: "active" } : undefined),
    });

    const resolved = runtime.resolveMmrTools("smart", ["read", "bash", "edit", "write", "oracle"]);
    assert.equal(resolved.activeTools.includes("oracle"), true);
    const oracleDecision = resolved.decisions.find((d) => d.requested === "oracle");
    assert.equal(oracleDecision.status, "active");
    assert.equal(oracleDecision.owner, "mmr-subagents-test");
  });
});
