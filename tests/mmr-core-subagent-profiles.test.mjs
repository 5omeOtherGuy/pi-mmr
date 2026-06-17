// Subagent profile contract.
//
// Pins the public-facing shape of `MmrSubagentProfile` so finder and any
// future subagent worker can resolve a single source of truth for
// model / thinking / tools / prompt-assembly policy.
//
// Phase 1 of the subagent-framework plan widens the profile from an
// execution-only record (`promptRoute: "subagent"`, `extensions: "native"`)
// into a full subagent-mode profile that carries display metadata, a
// prompt-assembly route (`standalone` vs `mode-derived`), an optional
// `baseMode` for mode-derived profiles, a `promptBuilder` identifier, and
// explicit `allowMcp` / `allowToolbox` policy.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const MODULE = "extensions/mmr-core/subagent-profiles.ts";

describe("mmr-core subagent profile registry", () => {
  it("exposes a 'finder' profile with the canonical execution policy", async () => {
    const mod = await importSource(MODULE);
    const profile = mod.getMmrSubagentProfile("finder");
    assert.ok(profile, "finder profile must be registered");
    assert.equal(profile.name, "finder");
    assert.equal(profile.displayName, "Finder", "profile must carry a human-facing display name");
    assert.equal(
      profile.promptRoute,
      "standalone",
      "finder uses standalone prompt assembly (not derived from a user-facing mode)",
    );
    assert.equal(
      profile.baseMode,
      undefined,
      "standalone profiles must not name a baseMode; baseMode is reserved for mode-derived profiles",
    );
    assert.equal(
      profile.promptBuilder,
      "finder",
      "finder profile resolves its prompt through the 'finder' builder in mmr-subagents",
    );
    assert.equal(profile.allowMcp, false, "finder must not allow MCP tool surfaces");
    assert.equal(profile.allowToolbox, false, "finder must not allow mmr-toolbox surfaces");
    assert.equal(profile.enforceLockedMode, false);
    assert.equal(profile.persistSubagentState, false);
    assert.deepEqual([...profile.tools], ["grep", "find", "read"]);
    assert.equal(
      profile.thinkingLevel,
      "low",
      "finder profile must pin worker thinking to LOW so providers with a low-effort lane use it",
    );
    assert.ok(Array.isArray(profile.modelPreferences));
    assert.ok(profile.modelPreferences.length >= 1, "finder must list at least one model preference");
    const ids = profile.modelPreferences.map((preference) => preference.model);
    assert.deepEqual(
      ids,
      ["gemini-3.5-flash", "gpt-5.4-mini", "claude-haiku-4-5"],
      "finder profile model preferences must match the canonical worker preference list",
    );
    assert.deepEqual(
      profile.modelPreferences[0].providers,
      ["antigravity"],
      "finder must route the provider-pinned Flash preference through antigravity",
    );
  });

  it("exposes a 'history-reader' profile with finder-equivalent extraction routing and no tools", async () => {
    const mod = await importSource(MODULE);
    const profile = mod.getMmrSubagentProfile("history-reader");
    assert.ok(profile, "history-reader profile must be registered");
    assert.equal(profile.name, "history-reader");
    assert.equal(profile.displayName, "History Reader");
    assert.equal(profile.promptRoute, "standalone");
    assert.equal(profile.baseMode, undefined);
    assert.equal(profile.promptBuilder, "history-reader");
    assert.equal(profile.allowMcp, false, "history-reader must not allow MCP tool surfaces");
    assert.equal(profile.allowToolbox, false, "history-reader must not allow mmr-toolbox surfaces");
    assert.equal(profile.enforceLockedMode, false);
    assert.equal(profile.persistSubagentState, false);
    assert.deepEqual([...profile.tools], [], "history-reader must remain a prompt-only worker");
    assert.equal(profile.maxTurns, 1, "history-reader must remain a single-turn extraction worker");
    assert.equal(
      profile.thinkingLevel,
      "minimal",
      "history-reader should match finder as a low-effort extraction worker",
    );
    const ids = profile.modelPreferences.map((preference) => preference.model);
    assert.deepEqual(
      ids,
      ["gemini-3.5-flash-extra-low", "gpt-5.4-mini", "claude-haiku-4-5"],
      "history-reader profile model preferences must match finder's extraction route",
    );
    assert.deepEqual(
      profile.modelPreferences[0].providers,
      ["antigravity"],
      "history-reader must route the provider-pinned Flash preference through antigravity",
    );
  });

  it("exposes an 'oracle' profile with the canonical execution policy", async () => {
    const mod = await importSource(MODULE);
    const profile = mod.getMmrSubagentProfile("oracle");
    assert.ok(profile, "oracle profile must be registered");
    assert.equal(profile.name, "oracle");
    assert.equal(profile.displayName, "Oracle");
    assert.equal(
      profile.promptRoute,
      "standalone",
      "oracle uses standalone prompt assembly (not derived from a user-facing mode)",
    );
    assert.equal(profile.baseMode, undefined);
    assert.equal(
      profile.promptBuilder,
      "oracle",
      "oracle profile resolves its prompt through the 'oracle' builder in mmr-subagents",
    );
    assert.equal(profile.allowMcp, false, "oracle must not allow MCP tool surfaces");
    assert.equal(profile.allowToolbox, false, "oracle must not allow mmr-toolbox surfaces");
    assert.equal(profile.enforceLockedMode, false);
    assert.equal(profile.persistSubagentState, false);
    assert.deepEqual(
      [...profile.tools],
      ["read", "grep", "find", "web_search", "read_web_page", "read_session", "find_session"],
      "oracle profile tool allowlist must match the documented capability set, using Pi-native concrete tool names",
    );
    assert.equal(
      profile.thinkingLevel,
      "xhigh",
      "oracle profile must use xhigh reasoning by default",
    );
    assert.ok(Array.isArray(profile.modelPreferences));
    assert.ok(profile.modelPreferences.length >= 2, "oracle must list a primary and at least one fallback");
    const prefIds = profile.modelPreferences.map((preference) => preference.model);
    assert.deepEqual(
      prefIds,
      ["gpt-5.5", "claude-opus-4-6"],
      "oracle profile model preferences must be GPT-5.5 then Claude Opus 4.6",
    );
    const opus = profile.modelPreferences.find((p) => p.model === "claude-opus-4-6");
    assert.equal(
      opus.thinkingLevel,
      "high",
      "the Claude Opus 4.6 fallback must run at high reasoning",
    );
  });

  it("exposes a 'librarian' profile with the canonical execution policy", async () => {
    const mod = await importSource(MODULE);
    const profile = mod.getMmrSubagentProfile("librarian");
    assert.ok(profile, "librarian profile must be registered");
    assert.equal(profile.name, "librarian");
    assert.equal(profile.displayName, "Librarian");
    assert.equal(profile.promptRoute, "standalone");
    assert.equal(profile.baseMode, undefined);
    assert.equal(profile.promptBuilder, "librarian");
    assert.equal(profile.allowMcp, false, "librarian must not allow MCP tool surfaces");
    assert.equal(profile.allowToolbox, false, "librarian must not allow mmr-toolbox surfaces");
    assert.equal(profile.enforceLockedMode, false);
    assert.equal(profile.persistSubagentState, false);
    assert.deepEqual([...profile.tools], [
      "read_github",
      "list_directory_github",
      "glob_github",
      "search_github",
      "commit_search",
      "diff_github",
      "list_repositories",
    ]);
    assert.equal(profile.thinkingLevel, "medium");
    const prefIds = profile.modelPreferences.map((preference) => preference.model);
    assert.deepEqual(prefIds, ["claude-opus-4-6", "gpt-5.4"]);
  });

  it("does not add a bare fallback when expanding explicit provider preferences", async () => {
    const { expandMmrModelPreferencesToStrings } = await importSource(MODULE);
    const expanded = expandMmrModelPreferencesToStrings([
      { model: "gemini-3.5-flash", providers: ["antigravity"] },
      { model: "gpt-5.4-mini" },
    ]);
    assert.deepEqual(
      [...expanded],
      ["antigravity/gemini-3.5-flash", "openai-codex/gpt-5.4-mini", "gpt-5.4-mini"],
    );
  });

  it("returns undefined for an unknown profile name", async () => {
    const { getMmrSubagentProfile } = await importSource(MODULE);
    assert.equal(getMmrSubagentProfile("does-not-exist"), undefined);
    assert.equal(getMmrSubagentProfile(""), undefined);
  });

  it("listMmrSubagentProfiles returns names deterministically", async () => {
    const { listMmrSubagentProfiles } = await importSource(MODULE);
    const a = listMmrSubagentProfiles();
    const b = listMmrSubagentProfiles();
    assert.deepEqual(a, b, "list ordering must be deterministic");
    assert.ok(a.includes("finder"), "finder must appear in the list");
    assert.ok(a.includes("librarian"), "librarian must appear in the list");
  });

  it("profiles are deep-frozen; mutation throws in strict mode", async () => {
    const { getMmrSubagentProfile } = await importSource(MODULE);
    const profile = getMmrSubagentProfile("finder");
    assert.throws(() => {
      profile.name = "mutated";
    }, /read.only|Cannot assign|Cannot add property/);
    assert.throws(() => {
      profile.allowMcp = true;
    }, /read.only|Cannot assign|Cannot add property/);
    assert.throws(() => {
      profile.tools.push("bash");
    }, /not extensible|read.only|object is not extensible|Cannot add property/);
    assert.throws(() => {
      profile.modelPreferences.push({ model: "evil" });
    }, /not extensible|read.only|object is not extensible|Cannot add property/);
  });

  it("every registered profile has a complete framework shape", async () => {
    const { getMmrSubagentProfile, listMmrSubagentProfiles } = await importSource(MODULE);
    const names = listMmrSubagentProfiles();
    assert.ok(names.length > 0, "must register at least one profile");
    for (const name of names) {
      const profile = getMmrSubagentProfile(name);
      assert.ok(profile, `profile "${name}" must resolve from the registry`);
      assert.equal(profile.name, name, `profile.name must match registry key for "${name}"`);
      assert.equal(typeof profile.displayName, "string");
      assert.ok(profile.displayName.length > 0, `profile "${name}" must have a non-empty displayName`);
      assert.ok(
        profile.promptRoute === "standalone" || profile.promptRoute === "mode-derived",
        `profile "${name}" promptRoute must be standalone or mode-derived; got ${profile.promptRoute}`,
      );
      if (profile.promptRoute === "mode-derived") {
        assert.equal(
          typeof profile.baseMode,
          "string",
          `mode-derived profile "${name}" must declare baseMode`,
        );
      } else {
        assert.equal(
          profile.baseMode,
          undefined,
          `standalone profile "${name}" must not declare baseMode`,
        );
      }
      assert.equal(typeof profile.promptBuilder, "string");
      assert.ok(profile.promptBuilder.length > 0, `profile "${name}" must declare a promptBuilder`);
      assert.equal(typeof profile.allowMcp, "boolean", `profile "${name}" must declare allowMcp`);
      assert.equal(typeof profile.allowToolbox, "boolean", `profile "${name}" must declare allowToolbox`);
      assert.equal(profile.enforceLockedMode, false);
      assert.equal(profile.persistSubagentState, false);
      assert.ok(Array.isArray(profile.tools));
      assert.ok(Array.isArray(profile.modelPreferences));
    }
  });
});
