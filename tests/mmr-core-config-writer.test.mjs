import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

describe("mmr-core config-writer", () => {
  it("applies a per-mode model preference update and preserves unrelated settings", async () => {
    const { applyMmrConfigUpdate } = await importSource("extensions/mmr-core/config-writer.ts");

    const existing = {
      mmrWeb: { enabled: true },
      mmrCore: {
        defaultMode: "deep",
        toolAliases: { oracle: ["mmr-oracle"] },
        modelPreferences: {
          rush: [{ model: "claude-haiku-4-5" }],
        },
      },
    };

    const next = applyMmrConfigUpdate(existing, {
      modeModelPreferences: {
        mode: "deep",
        preferences: [
          { model: "gpt-5.5", providers: ["openai-codex"], thinkingLevel: "high" },
        ],
      },
    });

    assert.deepEqual(next.mmrWeb, { enabled: true });
    assert.equal(next.mmrCore.defaultMode, "deep");
    assert.deepEqual(next.mmrCore.toolAliases, { oracle: ["mmr-oracle"] });
    assert.deepEqual(next.mmrCore.modelPreferences, {
      rush: [{ model: "claude-haiku-4-5" }],
      deep: [{ model: "gpt-5.5", providers: ["openai-codex"], thinkingLevel: "high" }],
    });

    // Input is not mutated.
    assert.deepEqual(existing.mmrCore.modelPreferences, { rush: [{ model: "claude-haiku-4-5" }] });
  });

  it("writes a subagent override and serializes a bare-model preference as a string", async () => {
    const { applyMmrConfigUpdate } = await importSource("extensions/mmr-core/config-writer.ts");

    const next = applyMmrConfigUpdate({}, {
      subagentModelPreferences: {
        profile: "finder",
        preferences: [{ model: "gpt-5.4-mini" }],
      },
    });

    assert.deepEqual(next, {
      mmrCore: {
        subagentModelPreferences: { finder: ["gpt-5.4-mini"] },
      },
    });
  });

  it("clears an existing override when preferences is empty", async () => {
    const { applyMmrConfigUpdate } = await importSource("extensions/mmr-core/config-writer.ts");

    const existing = {
      mmrCore: {
        defaultMode: "smart",
        subagentModelPreferences: {
          finder: ["gpt-5.4-mini"],
          oracle: ["gpt-5.4"],
        },
      },
    };

    const next = applyMmrConfigUpdate(existing, {
      subagentModelPreferences: { profile: "oracle", preferences: [] },
    });

    assert.deepEqual(next.mmrCore.subagentModelPreferences, { finder: ["gpt-5.4-mini"] });
    assert.equal(next.mmrCore.defaultMode, "smart");
  });

  it("removes the mmrCore block entirely when the last entry is cleared", async () => {
    const { applyMmrConfigUpdate } = await importSource("extensions/mmr-core/config-writer.ts");

    const existing = {
      mmrCore: {
        modelPreferences: { rush: ["claude-haiku-4-5"] },
      },
      mmrWeb: { enabled: true },
    };

    const next = applyMmrConfigUpdate(existing, {
      modeModelPreferences: { mode: "rush", preferences: [] },
    });

    assert.equal("mmrCore" in next, false);
    assert.deepEqual(next.mmrWeb, { enabled: true });
  });

  it("preserves the nested mmr.core layout when no flat mmrCore exists", async () => {
    const { applyMmrConfigUpdate } = await importSource("extensions/mmr-core/config-writer.ts");

    const existing = {
      mmr: {
        core: { defaultMode: "smart" },
      },
    };

    const next = applyMmrConfigUpdate(existing, {
      subagentModelPreferences: { profile: "finder", preferences: [{ model: "gpt-5.4-mini" }] },
    });

    assert.equal("mmrCore" in next, false);
    assert.deepEqual(next.mmr.core, {
      defaultMode: "smart",
      subagentModelPreferences: { finder: ["gpt-5.4-mini"] },
    });
  });

  it("writeMmrCoreConfigFile writes valid JSON that the loader can read back", async () => {
    const { writeMmrCoreConfigFile, getProjectMmrSettingsPath } = await importSource(
      "extensions/mmr-core/config-writer.ts",
    );
    const { loadMmrCoreSettings } = await importSource("extensions/mmr-core/settings.ts");

    const tempRoot = mkdtempSync(path.join(tmpdir(), "pi-mmr-config-writer-"));
    try {
      const project = path.join(tempRoot, "project");
      const home = path.join(tempRoot, "home");
      mkdirSync(home, { recursive: true });

      const filePath = getProjectMmrSettingsPath(project);
      assert.equal(existsSync(filePath), false);

      writeMmrCoreConfigFile(filePath, {
        modeModelPreferences: {
          mode: "deep",
          preferences: [{ model: "gpt-5.5", providers: ["openai-codex"], thinkingLevel: "high" }],
        },
      });
      writeMmrCoreConfigFile(filePath, {
        subagentModelPreferences: {
          profile: "finder",
          preferences: [{ model: "gpt-5.4-mini" }],
        },
      });

      const loaded = loadMmrCoreSettings(project, home);

      assert.deepEqual(loaded.settings.modelPreferences, {
        deep: [{ model: "gpt-5.5", providers: ["openai-codex"], thinkingLevel: "high" }],
      });
      assert.deepEqual(loaded.settings.subagentModelPreferences, {
        finder: [{ model: "gpt-5.4-mini" }],
      });
      assert.deepEqual(loaded.warnings, []);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite a settings file with invalid JSON", async () => {
    const { writeMmrCoreConfigFile, getProjectMmrSettingsPath } = await importSource(
      "extensions/mmr-core/config-writer.ts",
    );

    const tempRoot = mkdtempSync(path.join(tmpdir(), "pi-mmr-config-writer-"));
    try {
      const project = path.join(tempRoot, "project");
      mkdirSync(path.join(project, ".pi"), { recursive: true });
      const filePath = getProjectMmrSettingsPath(project);
      writeFileSync(filePath, "{ not json");

      assert.throws(
        () => writeMmrCoreConfigFile(filePath, {
          modeModelPreferences: { mode: "smart", preferences: [{ model: "gpt-5.5" }] },
        }),
        /not valid JSON/,
      );

      // File contents are untouched on refusal.
      assert.equal(readFileSync(filePath, "utf8"), "{ not json");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("mmr-core settings: subagentModelPreferences", () => {
  it("parses subagentModelPreferences from the project settings file", async () => {
    const { loadMmrCoreSettings } = await importSource("extensions/mmr-core/settings.ts");

    const tempRoot = mkdtempSync(path.join(tmpdir(), "pi-mmr-config-settings-"));
    try {
      const home = path.join(tempRoot, "home");
      const project = path.join(tempRoot, "project");
      mkdirSync(path.join(home, ".pi/agent"), { recursive: true });
      mkdirSync(path.join(project, ".pi"), { recursive: true });

      writeFileSync(
        path.join(project, ".pi/settings.json"),
        JSON.stringify({
          mmrCore: {
            subagentModelPreferences: {
              finder: ["gpt-5.4-mini", { model: "claude-haiku-4-5", thinkingLevel: "minimal" }],
              oracle: ["openai-codex/gpt-5.4"],
            },
          },
        }),
      );

      const loaded = loadMmrCoreSettings(project, home);

      assert.deepEqual(loaded.settings.subagentModelPreferences, {
        finder: [
          { model: "gpt-5.4-mini" },
          { model: "claude-haiku-4-5", thinkingLevel: "minimal" },
        ],
        oracle: [{ model: "gpt-5.4", providers: ["openai-codex"] }],
      });
      assert.deepEqual(loaded.warnings, []);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("warns when subagentModelPreferences is the wrong shape and ignores it", async () => {
    const { loadMmrCoreSettings } = await importSource("extensions/mmr-core/settings.ts");

    const tempRoot = mkdtempSync(path.join(tmpdir(), "pi-mmr-config-settings-"));
    try {
      const home = path.join(tempRoot, "home");
      const project = path.join(tempRoot, "project");
      mkdirSync(path.join(home, ".pi/agent"), { recursive: true });
      mkdirSync(path.join(project, ".pi"), { recursive: true });

      writeFileSync(
        path.join(project, ".pi/settings.json"),
        JSON.stringify({ mmrCore: { subagentModelPreferences: ["finder"] } }),
      );

      const loaded = loadMmrCoreSettings(project, home);

      assert.equal(loaded.settings.subagentModelPreferences, undefined);
      assert.ok(
        loaded.warnings.some(
          (w) => /subagentModelPreferences/.test(w) && /\/project\/\.pi\/settings\.json/.test(w),
        ),
        `expected a subagentModelPreferences-shape warning, got ${JSON.stringify(loaded.warnings)}`,
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("mmr-core config-flow: renders current values from disk, not stale snapshots", () => {
  // Build a ctx that drives `runMmrConfigFlow` into a single branch, captures
  // the rendered choice labels, then cancels (returns undefined). The home dir
  // is redirected to an empty temp dir so `loadMmrCoreSettings(ctx.cwd)` only
  // sees the project file we write, keeping the test deterministic.
  function makeCtx(project, capturedChoices, branch) {
    return {
      cwd: project,
      hasUI: true,
      modelRegistry: { getAvailable: () => [] },
      ui: {
        select: async (title, options) => {
          if (/what do you want to set/.test(title)) return branch;
          capturedChoices.push(...options);
          return undefined; // cancel after capturing the rendered list
        },
        input: async () => undefined,
        confirm: async () => false,
        notify: () => {},
        setStatus: () => {},
        theme: { fg: (_color, value) => value },
      },
    };
  }

  // Bindings deliberately return an EMPTY (stale) snapshot, simulating a
  // session that started before the on-disk preference was written. Setters
  // are kept so the public bindings interface stays intact.
  function staleBindings() {
    return {
      getConfiguredModelPreferences: () => ({}),
      getConfiguredSubagentModelPreferences: () => ({}),
      setConfiguredModePreferences: () => {},
      setConfiguredSubagentPreferences: () => {},
    };
  }

  function withTempHome(home, run) {
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      return run();
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
    }
  }

  it("shows the on-disk mode preference instead of the binding's startup snapshot", async () => {
    const { runMmrConfigFlow } = await importSource("extensions/mmr-core/config-flow.ts");

    const tempRoot = mkdtempSync(path.join(tmpdir(), "pi-mmr-config-flow-"));
    try {
      const home = path.join(tempRoot, "home");
      const project = path.join(tempRoot, "project");
      mkdirSync(path.join(home, ".pi/agent"), { recursive: true });
      mkdirSync(path.join(project, ".pi"), { recursive: true });

      // Custom 'deep' preference that differs from both the mode default
      // (gpt-5.5 → claude-opus-4-8) and the stale binding (empty).
      writeFileSync(
        path.join(project, ".pi/settings.json"),
        JSON.stringify({ mmrCore: { modelPreferences: { deep: ["openai-codex/o5-preview"] } } }),
      );

      const captured = [];
      await withTempHome(home, () => runMmrConfigFlow(makeCtx(project, captured, "mode"), staleBindings()));

      const deepChoice = captured.find((choice) => choice.startsWith("deep \u2014"));
      assert.ok(deepChoice, `expected a 'deep' mode choice, got ${JSON.stringify(captured)}`);
      assert.match(deepChoice, /openai-codex\/o5-preview/, "deep current value should reflect the on-disk preference");
      assert.doesNotMatch(deepChoice, /gpt-5\.5/, "deep current value must not fall back to the stale binding's mode default");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("shows the on-disk subagent preference instead of the binding's startup snapshot", async () => {
    const { runMmrConfigFlow } = await importSource("extensions/mmr-core/config-flow.ts");

    const tempRoot = mkdtempSync(path.join(tmpdir(), "pi-mmr-config-flow-"));
    try {
      const home = path.join(tempRoot, "home");
      const project = path.join(tempRoot, "project");
      mkdirSync(path.join(home, ".pi/agent"), { recursive: true });
      mkdirSync(path.join(project, ".pi"), { recursive: true });

      // Custom 'finder' override that differs from the profile default and the
      // empty stale binding.
      writeFileSync(
        path.join(project, ".pi/settings.json"),
        JSON.stringify({ mmrCore: { subagentModelPreferences: { finder: ["openai-codex/o5-preview"] } } }),
      );

      const captured = [];
      await withTempHome(home, () => runMmrConfigFlow(makeCtx(project, captured, "subagent"), staleBindings()));

      const finderChoice = captured.find((choice) => choice.startsWith("finder \u2014"));
      assert.ok(finderChoice, `expected a 'finder' subagent choice, got ${JSON.stringify(captured)}`);
      assert.match(finderChoice, /openai-codex\/o5-preview/, "finder current value should reflect the on-disk override");
      assert.doesNotMatch(finderChoice, /gpt-5\.4-mini/, "finder current value must not fall back to the stale binding's profile default");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
