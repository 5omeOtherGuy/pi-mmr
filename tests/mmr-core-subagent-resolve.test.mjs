// Step 2: subagent route resolution.
//
// Pins `resolveMmrSubagentRoute` so subagent activation has a single
// pure path that:
//  - picks the first registered+authenticated provider/model route from
//    the profile preferences (reuses model-resolver primitives);
//  - returns the profile's concrete tool allowlist verbatim;
//  - always reports the `subagent` prompt route;
//  - returns fail-closed diagnostics when no model route matches;
//  - returns fail-closed diagnostics when explicit `--model` / `--tools`
//    disagree with the profile route.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const RESOLVER = "extensions/mmr-core/subagent-resolver.ts";
const PROFILES = "extensions/mmr-core/subagent-profiles.ts";

function makeRegistry(models) {
  return {
    getAll: () => models,
    find: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
    hasConfiguredAuth: () => true,
    isUsingOAuth: (model) => model.provider.endsWith("subscription") || model.provider.endsWith("codex"),
  };
}

describe("resolveMmrSubagentRoute", () => {
  it("selects the finder provider-pinned Flash route through antigravity when both Gemini providers are registered", async () => {
    const { resolveMmrSubagentRoute } = await importSource(RESOLVER);
    const { getMmrSubagentProfile } = await importSource(PROFILES);
    const profile = getMmrSubagentProfile("finder");
    const registry = makeRegistry([
      { provider: "google", id: "gemini-3.5-flash" },
      { provider: "antigravity", id: "gemini-3.5-flash-extra-low" },
      { provider: "openai-codex", id: "gpt-5.4-mini" },
      { provider: "claude-subscription", id: "claude-haiku-4-5" },
    ]);

    const result = resolveMmrSubagentRoute({ profile, registry });
    assert.equal(result.ok, true);
    assert.equal(result.selected.provider, "antigravity");
    assert.equal(result.selected.model, "gemini-3.5-flash-extra-low");
    assert.deepEqual([...result.tools], ["grep", "find", "read"]);
    assert.equal(result.promptRoute, "standalone");
    assert.equal(result.profile.name, "finder");
    assert.deepEqual(result.diagnostics, []);
  });

  it("falls back to the next preference when the first is not registered", async () => {
    const { resolveMmrSubagentRoute } = await importSource(RESOLVER);
    const { getMmrSubagentProfile } = await importSource(PROFILES);
    const profile = getMmrSubagentProfile("finder");
    const registry = makeRegistry([
      { provider: "claude-subscription", id: "claude-haiku-4-5" },
    ]);

    const result = resolveMmrSubagentRoute({ profile, registry });
    assert.equal(result.ok, true);
    assert.equal(result.selected.provider, "claude-subscription");
    assert.equal(result.selected.model, "claude-haiku-4-5");
  });

  it("returns fail-closed diagnostics when no preference resolves", async () => {
    const { resolveMmrSubagentRoute } = await importSource(RESOLVER);
    const { getMmrSubagentProfile } = await importSource(PROFILES);
    const profile = getMmrSubagentProfile("finder");
    const registry = makeRegistry([
      { provider: "openai", id: "gpt-5" },
    ]);

    const result = resolveMmrSubagentRoute({ profile, registry });
    assert.equal(result.ok, false);
    assert.equal(result.code, "model.no-route");
    assert.ok(result.message.length > 0);
    assert.equal(result.selected, undefined);
    assert.ok(result.diagnostics.length > 0);
    assert.ok(result.diagnostics.some((d) => /gpt-5\.4-mini|claude-haiku-4-5/.test(d.message)));
  });

  it("returns tool list verbatim from the profile (no MMR-owned tool injection)", async () => {
    const { resolveMmrSubagentRoute } = await importSource(RESOLVER);
    const { getMmrSubagentProfile } = await importSource(PROFILES);
    const profile = getMmrSubagentProfile("finder");
    const registry = makeRegistry([{ provider: "openai-codex", id: "gpt-5.4-mini" }]);
    const result = resolveMmrSubagentRoute({ profile, registry });
    assert.equal(result.ok, true);
    // No locked-mode tools (apply_patch, web_search, finder, task_list, etc.) leak in.
    assert.equal(result.tools.includes("apply_patch"), false);
    assert.equal(result.tools.includes("web_search"), false);
    assert.equal(result.tools.includes("finder"), false);
    assert.equal(result.tools.includes("task_list"), false);
    assert.deepEqual([...result.tools], [...profile.tools]);
  });

  it("fails closed when explicit model conflicts with the resolved route", async () => {
    const { resolveMmrSubagentRoute } = await importSource(RESOLVER);
    const { getMmrSubagentProfile } = await importSource(PROFILES);
    const profile = getMmrSubagentProfile("finder");
    const registry = makeRegistry([{ provider: "openai-codex", id: "gpt-5.4-mini" }]);

    const result = resolveMmrSubagentRoute({
      profile,
      registry,
      explicitModel: "claude-subscription/claude-opus-4-8",
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "model.mismatch");
    assert.match(result.message, /claude-opus-4-8/);
    assert.match(result.message, /gpt-5\.4-mini/);
  });

  it("accepts an explicit model that matches the resolved route", async () => {
    const { resolveMmrSubagentRoute } = await importSource(RESOLVER);
    const { getMmrSubagentProfile } = await importSource(PROFILES);
    const profile = getMmrSubagentProfile("finder");
    const registry = makeRegistry([{ provider: "openai-codex", id: "gpt-5.4-mini" }]);

    const ok1 = resolveMmrSubagentRoute({
      profile,
      registry,
      explicitModel: "openai-codex/gpt-5.4-mini",
    });
    assert.equal(ok1.ok, true);
    // Bare-id form also acceptable for compatibility.
    const ok2 = resolveMmrSubagentRoute({
      profile,
      registry,
      explicitModel: "gpt-5.4-mini",
    });
    assert.equal(ok2.ok, true);
  });

  it("fails closed when explicit tools differ from the profile tool allowlist", async () => {
    const { resolveMmrSubagentRoute } = await importSource(RESOLVER);
    const { getMmrSubagentProfile } = await importSource(PROFILES);
    const profile = getMmrSubagentProfile("finder");
    const registry = makeRegistry([{ provider: "openai-codex", id: "gpt-5.4-mini" }]);

    const result = resolveMmrSubagentRoute({
      profile,
      registry,
      explicitTools: ["grep", "find", "read", "bash"],
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "tools.mismatch");
    assert.match(result.message, /bash/);
  });

  it("accepts explicit tools that exactly match (order-independent) the profile tools", async () => {
    const { resolveMmrSubagentRoute } = await importSource(RESOLVER);
    const { getMmrSubagentProfile } = await importSource(PROFILES);
    const profile = getMmrSubagentProfile("finder");
    const registry = makeRegistry([{ provider: "openai-codex", id: "gpt-5.4-mini" }]);

    const result = resolveMmrSubagentRoute({
      profile,
      registry,
      explicitTools: ["read", "grep", "find"],
    });
    assert.equal(result.ok, true);
  });
  it("selects the librarian primary route, fallback route, and exact GitHub tool allowlist", async () => {
    const { resolveMmrSubagentRoute } = await importSource(RESOLVER);
    const { getMmrSubagentProfile } = await importSource(PROFILES);
    const profile = getMmrSubagentProfile("librarian");
    assert.ok(profile, "librarian profile must be registered");

    const primary = resolveMmrSubagentRoute({
      profile,
      registry: makeRegistry([
        { provider: "claude-subscription", id: "claude-opus-4-6" },
        { provider: "openai-codex", id: "gpt-5.4" },
      ]),
    });
    assert.equal(primary.ok, true);
    assert.equal(primary.selected.provider, "claude-subscription");
    assert.equal(primary.selected.model, "claude-opus-4-6");
    assert.equal(primary.selected.thinkingLevel, "medium");
    assert.deepEqual([...primary.tools], [
      "read_github",
      "list_directory_github",
      "glob_github",
      "search_github",
      "commit_search",
      "diff_github",
      "list_repositories",
    ]);
    assert.equal(primary.promptRoute, "standalone");

    const fallback = resolveMmrSubagentRoute({
      profile,
      registry: makeRegistry([{ provider: "openai-codex", id: "gpt-5.4" }]),
    });
    assert.equal(fallback.ok, true);
    assert.equal(fallback.selected.provider, "openai-codex");
    assert.equal(fallback.selected.model, "gpt-5.4");
  });

  it("fails closed for librarian model and explicit-tool mismatches", async () => {
    const { resolveMmrSubagentRoute } = await importSource(RESOLVER);
    const { getMmrSubagentProfile } = await importSource(PROFILES);
    const profile = getMmrSubagentProfile("librarian");
    assert.ok(profile, "librarian profile must be registered");

    const noRoute = resolveMmrSubagentRoute({
      profile,
      registry: makeRegistry([{ provider: "openai", id: "gpt-5.1" }]),
    });
    assert.equal(noRoute.ok, false);
    assert.equal(noRoute.code, "model.no-route");
    assert.match(noRoute.message, /librarian/);

    const badTools = resolveMmrSubagentRoute({
      profile,
      registry: makeRegistry([{ provider: "claude-subscription", id: "claude-opus-4-6" }]),
      explicitTools: ["read_github", "read"],
    });
    assert.equal(badTools.ok, false);
    assert.equal(badTools.code, "tools.mismatch");
    assert.match(badTools.message, /read_github,list_directory_github,glob_github,search_github,commit_search,diff_github,list_repositories/);

    const okTools = resolveMmrSubagentRoute({
      profile,
      registry: makeRegistry([{ provider: "claude-subscription", id: "claude-opus-4-6" }]),
      explicitTools: [
        "list_repositories",
        "diff_github",
        "commit_search",
        "search_github",
        "glob_github",
        "list_directory_github",
        "read_github",
      ],
    });
    assert.equal(okTools.ok, true);
  });
});

describe("resolveMmrSubagentInvocation", () => {
  // Registry with every model the task-subagent profile may select. The
  // first registered preference wins, so test cases swap providers via
  // `modelPreferencesOverride` or by trimming the registry.
  function makeTaskRegistry() {
    return makeRegistry([
      { provider: "claude-subscription", id: "claude-opus-4-8" },
      { provider: "openai-codex", id: "gpt-5.5" },
      { provider: "claude-subscription", id: "claude-opus-4-6" },
      { provider: "claude-subscription", id: "claude-haiku-4-5-20251001" },
      { provider: "claude-subscription", id: "claude-haiku-4-5" },
    ]);
  }
  const TASK_REGISTERED_TOOLS = [
    "read", "bash", "edit", "write",
    "read_web_page", "web_search",
    "finder", "skill", "task_list",
  ];

  it("resolves Task prompt base, route, thinking, and worker tools for each Task-enabled mode", async () => {
    const { resolveMmrSubagentInvocation } = await importSource(RESOLVER);
    const { getMmrSubagentProfile } = await importSource(PROFILES);
    const profile = getMmrSubagentProfile("task-subagent");
    const registry = makeTaskRegistry();

    const cases = [
      { parentMode: "smart",    expectedBase: "smart",    provider: "claude-subscription", model: "claude-opus-4-8", thinkingLevel: "high" },
      { parentMode: "smartGPT", expectedBase: "smartGPT", provider: "claude-subscription", model: "claude-opus-4-8", thinkingLevel: "high" },
      { parentMode: "rush",     expectedBase: "rush",     provider: "openai-codex",       model: "gpt-5.5",              thinkingLevel: "off"  },
      { parentMode: "large",    expectedBase: "large",    provider: "claude-subscription", model: "claude-opus-4-8", thinkingLevel: "high" },
      // Spec §6.1: deep aliases to smart for prompt base, route list,
      // selected route, and thinking level.
      { parentMode: "deep",     expectedBase: "smart",    provider: "claude-subscription", model: "claude-opus-4-8", thinkingLevel: "high" },
    ];
    for (const c of cases) {
      const result = resolveMmrSubagentInvocation({
        profile,
        registry,
        parentMode: c.parentMode,
        registeredTools: TASK_REGISTERED_TOOLS,
      });
      assert.equal(result.ok, true, `mode "${c.parentMode}" must resolve to ok`);
      assert.equal(result.parentMode, c.parentMode);
      assert.equal(result.promptBaseMode, c.expectedBase);
      assert.equal(result.selected.provider, c.provider);
      assert.equal(result.selected.model, c.model);
      assert.equal(result.selected.thinkingLevel, c.thinkingLevel);
      assert.equal(result.modelArg, `${c.provider}/${c.model}`);
      assert.deepEqual([...result.workerTools], TASK_REGISTERED_TOOLS);
      assert.deepEqual(
        [...result.toolResolution.deniedTools].sort(),
        ["Task", "handoff", "librarian", "oracle", "start_task", "task_cancel", "task_poll", "task_wait"],
      );
      assert.deepEqual([...result.toolResolution.omittedTools], []);
    }
  });

  it("uses the prompt-base alias when looking up mode-specific Task worker routes", async () => {
    const { resolveMmrSubagentInvocation } = await importSource(RESOLVER);
    const { getMmrSubagentProfile } = await importSource(PROFILES);
    const baseProfile = getMmrSubagentProfile("task-subagent");
    const profile = {
      ...baseProfile,
      modeModelPreferences: {
        smart: [{ model: "claude-haiku-4-5", thinkingLevel: "minimal" }],
      },
    };
    const registry = makeRegistry([
      { provider: "claude-subscription", id: "claude-opus-4-8" },
      { provider: "claude-subscription", id: "claude-haiku-4-5" },
    ]);

    const deep = resolveMmrSubagentInvocation({
      profile,
      registry,
      parentMode: "deep",
      registeredTools: TASK_REGISTERED_TOOLS,
    });
    assert.equal(deep.ok, true);
    assert.equal(deep.promptBaseMode, "smart");
    assert.equal(deep.selected.model, "claude-haiku-4-5");
    assert.equal(deep.selected.thinkingLevel, "minimal");

    const large = resolveMmrSubagentInvocation({
      profile,
      registry,
      parentMode: "large",
      registeredTools: TASK_REGISTERED_TOOLS,
    });
    assert.equal(large.ok, true);
    assert.equal(large.promptBaseMode, "large");
    assert.equal(large.selected.model, "claude-opus-4-8");
    assert.equal(large.selected.thinkingLevel, "high");
  });

  it("falls rush Task workers back to Haiku 4.5 with thinking off when GPT routes are unavailable", async () => {
    const { resolveMmrSubagentInvocation } = await importSource(RESOLVER);
    const { getMmrSubagentProfile } = await importSource(PROFILES);
    const profile = getMmrSubagentProfile("task-subagent");
    const registry = makeRegistry([
      { provider: "claude-subscription", id: "claude-haiku-4-5" },
    ]);

    const result = resolveMmrSubagentInvocation({
      profile,
      registry,
      parentMode: "rush",
      registeredTools: TASK_REGISTERED_TOOLS,
    });

    assert.equal(result.ok, true);
    assert.equal(result.selected.provider, "claude-subscription");
    assert.equal(result.selected.model, "claude-haiku-4-5");
    assert.equal(result.selected.thinkingLevel, "off");
    assert.match(result.diagnostics.map((d) => d.message).join("\n"), /gpt-5\.5/);
  });

  it("fails closed when parent mode is missing or free for from-parent profiles", async () => {
    const { resolveMmrSubagentInvocation } = await importSource(RESOLVER);
    const { getMmrSubagentProfile } = await importSource(PROFILES);
    const profile = getMmrSubagentProfile("task-subagent");
    const registry = makeTaskRegistry();

    const noMode = resolveMmrSubagentInvocation({
      profile,
      registry,
      registeredTools: TASK_REGISTERED_TOOLS,
    });
    assert.equal(noMode.ok, false);
    assert.equal(noMode.code, "prompt-base.unresolved");

    const freeMode = resolveMmrSubagentInvocation({
      profile,
      registry,
      parentMode: "free",
      registeredTools: TASK_REGISTERED_TOOLS,
    });
    assert.equal(freeMode.ok, false);
    assert.equal(freeMode.code, "prompt-base.unresolved");
  });

  it("with invocationContext=child-activation lets from-parent profiles resolve model and tools without a parentMode", async () => {
    // The child Pi process activates the named subagent profile via
    // --mmr-subagent; the parent owns prompt assembly and the child
    // path does not need to compute promptBaseMode. The invocation
    // resolver's invocationContext="child-activation" marker lets the
    // child validate model/tools without rejecting from-parent profiles
    // that have no parentMode signal available in the child process.
    const { resolveMmrSubagentInvocation } = await importSource(RESOLVER);
    const { getMmrSubagentProfile } = await importSource(PROFILES);
    const profile = getMmrSubagentProfile("task-subagent");
    const registry = makeTaskRegistry();

    const result = resolveMmrSubagentInvocation({
      profile,
      registry,
      // parentMode intentionally omitted; invocationContext="child-activation".
      registeredTools: TASK_REGISTERED_TOOLS,
      invocationContext: "child-activation",
    });
    assert.equal(result.ok, true, "from-parent + missing parentMode + child-activation context must not fail closed");
    assert.equal(result.promptBaseMode, undefined, "prompt-base must be undefined under child-activation context");
    assert.deepEqual([...result.workerTools], TASK_REGISTERED_TOOLS);
  });

  it("with invocationContext=child-activation uses parentMode, not model id, for Rush-specific Task thinking", async () => {
    const { resolveMmrSubagentInvocation } = await importSource(RESOLVER);
    const { getMmrSubagentProfile } = await importSource(PROFILES);
    const profile = getMmrSubagentProfile("task-subagent");
    const cases = [
      { label: "smart GPT fallback", parentMode: "smart", provider: "openai-codex", model: "gpt-5.5", thinkingLevel: "medium" },
      { label: "rush GPT primary", parentMode: "rush", provider: "openai-codex", model: "gpt-5.5", thinkingLevel: "off" },
      { label: "smart Haiku fallback", parentMode: "smart", provider: "claude-subscription", model: "claude-haiku-4-5", thinkingLevel: "low" },
      { label: "rush Haiku fallback", parentMode: "rush", provider: "claude-subscription", model: "claude-haiku-4-5", thinkingLevel: "off" },
      { label: "no parent mode defaults, does not infer Rush", provider: "openai-codex", model: "gpt-5.5", thinkingLevel: "medium" },
    ];

    for (const c of cases) {
      const registry = makeRegistry([{ provider: c.provider, id: c.model }]);
      const result = resolveMmrSubagentInvocation({
        profile,
        registry,
        registeredTools: TASK_REGISTERED_TOOLS,
        invocationContext: "child-activation",
        ...(c.parentMode !== undefined ? { parentMode: c.parentMode } : {}),
        explicitModel: `${c.provider}/${c.model}`,
        explicitTools: TASK_REGISTERED_TOOLS,
      });

      assert.equal(result.ok, true, c.label);
      assert.equal(result.selected.provider, c.provider, c.label);
      assert.equal(result.selected.model, c.model, c.label);
      assert.equal(result.selected.thinkingLevel, c.thinkingLevel, c.label);
    }
  });

  it("fails closed before model resolution when the worker tool set is empty", async () => {
    const { resolveMmrSubagentInvocation } = await importSource(RESOLVER);
    const { getMmrSubagentProfile } = await importSource(PROFILES);
    const profile = getMmrSubagentProfile("task-subagent");
    const registry = makeTaskRegistry();

    const result = resolveMmrSubagentInvocation({
      profile,
      registry,
      parentMode: "smart",
      // Host registers nothing the profile wants.
      registeredTools: ["unrelated_tool"],
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "tools.empty");
    assert.equal(result.workerTools.length, 0);
    assert.deepEqual(
      [...result.toolResolution.omittedTools].sort(),
      [
        "bash", "edit", "finder", "read", "read_web_page",
        "skill", "task_list", "web_search", "write",
      ],
    );
  });

  it("allows profiles that intentionally declare tools: [] (history-reader runs analysis without local tool calls)", async () => {
    // Spec: subagents whose worker prompt requires no tool execution
    // (e.g. `history-reader` reads a sanitized session packet and emits
    // a JSON analysis) declare `tools: []` in their profile. The resolver
    // must distinguish this intentional empty set from a profile that
    // intended at least one tool but had it removed by deny/registered
    // intersection — the latter still fails closed with `tools.empty`,
    // the former resolves cleanly with workerTools=[].
    const { resolveMmrSubagentInvocation } = await importSource(RESOLVER);
    const { getMmrSubagentProfile } = await importSource(PROFILES);
    const profile = getMmrSubagentProfile("history-reader");
    assert.equal(profile.tools.length, 0, "history-reader profile must remain tools: [] for this test to be meaningful");
    const registry = {
      getAll: () => [{ provider: "openai-codex", id: "gpt-5.4-mini" }],
      find: (provider, id) => provider === "openai-codex" && id === "gpt-5.4-mini"
        ? { provider, id }
        : undefined,
    };

    const result = resolveMmrSubagentInvocation({
      profile,
      registry,
      // History-reader is standalone, so invocationContext/parentMode are
      // irrelevant; resolver should still succeed.
      registeredTools: ["read", "grep", "find"],
    });
    assert.equal(result.ok, true, `expected ok=true but got code=${result.code} message=${result.message}`);
    assert.equal(result.workerTools.length, 0);
    assert.deepEqual([...result.toolResolution.intendedTools], []);
    assert.deepEqual([...result.toolResolution.omittedTools], []);
  });

  it("validates explicit --tools against the resolved worker tool set", async () => {
    const { resolveMmrSubagentInvocation } = await importSource(RESOLVER);
    const { getMmrSubagentProfile } = await importSource(PROFILES);
    const profile = getMmrSubagentProfile("task-subagent");
    const registry = makeTaskRegistry();

    // Explicit tools include a denied/recursive entry — must fail closed.
    const denied = resolveMmrSubagentInvocation({
      profile,
      registry,
      parentMode: "smart",
      registeredTools: TASK_REGISTERED_TOOLS,
      explicitTools: [...TASK_REGISTERED_TOOLS, "Task"],
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, "tools.mismatch");

    // Explicit tools exactly match the resolved worker set (order-independent).
    const ok = resolveMmrSubagentInvocation({
      profile,
      registry,
      parentMode: "smart",
      registeredTools: TASK_REGISTERED_TOOLS,
      explicitTools: [...TASK_REGISTERED_TOOLS].sort(),
    });
    assert.equal(ok.ok, true);
  });

  it("fails closed when librarian child activation sees only a partial GitHub-tool set", async () => {
    const { resolveMmrSubagentInvocation } = await importSource(RESOLVER);
    const { getMmrSubagentProfile } = await importSource(PROFILES);
    const profile = getMmrSubagentProfile("librarian");
    const registry = makeRegistry([{ provider: "claude-subscription", id: "claude-opus-4-6" }]);

    const result = resolveMmrSubagentInvocation({
      profile,
      registry,
      registeredTools: ["read_github"],
      explicitTools: ["read_github", "search_github"],
      invocationContext: "child-activation",
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "tools.mismatch");
    assert.deepEqual([...result.workerTools], ["read_github"]);
    assert.deepEqual([...result.toolResolution.omittedTools], [
      "list_directory_github",
      "glob_github",
      "search_github",
      "commit_search",
      "diff_github",
      "list_repositories",
    ]);
  });

  it("honors modelPreferencesOverride without disturbing prompt base or deny set", async () => {
    const { resolveMmrSubagentInvocation } = await importSource(RESOLVER);
    const { getMmrSubagentProfile } = await importSource(PROFILES);
    const profile = getMmrSubagentProfile("task-subagent");
    const registry = makeTaskRegistry();

    const result = resolveMmrSubagentInvocation({
      profile,
      registry,
      parentMode: "deep",
      registeredTools: TASK_REGISTERED_TOOLS,
      // Settings-driven override: prefer gpt-5.5 at medium.
      modelPreferencesOverride: [{ model: "gpt-5.5", thinkingLevel: "medium" }],
    });
    assert.equal(result.ok, true);
    assert.equal(result.selected.provider, "openai-codex");
    assert.equal(result.selected.model, "gpt-5.5");
    assert.equal(result.selected.thinkingLevel, "medium");
    // Deep → smart aliasing for prompt base is preserved regardless of
    // model preference override.
    assert.equal(result.promptBaseMode, "smart");
  });
});
