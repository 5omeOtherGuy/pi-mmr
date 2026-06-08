import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

describe("mmr-core settings", () => {
  it("loads global and project MMR settings with project overrides", async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), "pi-mmr-settings-"));
    try {
      const home = path.join(tempRoot, "home");
      const project = path.join(tempRoot, "project");
      mkdirSync(path.join(home, ".pi/agent"), { recursive: true });
      mkdirSync(path.join(project, ".pi"), { recursive: true });

      writeFileSync(
        path.join(home, ".pi/agent/settings.json"),
        JSON.stringify({
          mmr: {
            core: {
              defaultMode: "rush",
              modelPreferences: { deep: ["gpt-5.5", "claude-opus-4-8"] },
            },
          },
        }),
      );
      writeFileSync(
        path.join(project, ".pi/settings.json"),
        JSON.stringify({
          mmrCore: {
            defaultMode: "deep",
            modelPreferences: { deep: ["openai-codex/gpt-5.5", { model: "claude-opus-4-8", thinkingLevel: "xhigh" }] },
          },
        }),
      );

      const { loadMmrCoreSettings } = await importSource("extensions/mmr-core/settings.ts");
      const loaded = loadMmrCoreSettings(project, home);

      assert.equal(loaded.settings.defaultMode, "deep");
      assert.equal(loaded.settings.toolAliases, undefined);
      assert.deepEqual(loaded.settings.modelPreferences, {
        deep: [
          { model: "gpt-5.5", providers: ["openai-codex"] },
          { model: "claude-opus-4-8", thinkingLevel: "xhigh" },
        ],
      });
      assert.equal(loaded.filesRead.length, 2);
      assert.deepEqual(loaded.warnings, []);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("warns and skips a malformed settings JSON file while loading the sibling file", async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), "pi-mmr-settings-"));
    try {
      const home = path.join(tempRoot, "home");
      const project = path.join(tempRoot, "project");
      mkdirSync(path.join(home, ".pi/agent"), { recursive: true });
      mkdirSync(path.join(project, ".pi"), { recursive: true });

      writeFileSync(
        path.join(home, ".pi/agent/settings.json"),
        JSON.stringify({ mmrCore: { defaultMode: "deep" } }),
      );
      writeFileSync(path.join(project, ".pi/settings.json"), "{ this is not valid json");

      const { loadMmrCoreSettings } = await importSource("extensions/mmr-core/settings.ts");
      const loaded = loadMmrCoreSettings(project, home);

      assert.equal(loaded.settings.defaultMode, "deep");
      assert.deepEqual(loaded.filesRead, [path.join(home, ".pi/agent/settings.json")]);
      assert.equal(loaded.warnings.length, 1);
      assert.match(loaded.warnings[0], /Could not read MMR settings from .*\/project\/\.pi\/settings\.json/);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("warns when mmrCore is not an object and continues with valid sibling settings", async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), "pi-mmr-settings-"));
    try {
      const home = path.join(tempRoot, "home");
      const project = path.join(tempRoot, "project");
      mkdirSync(path.join(home, ".pi/agent"), { recursive: true });
      mkdirSync(path.join(project, ".pi"), { recursive: true });

      writeFileSync(
        path.join(home, ".pi/agent/settings.json"),
        JSON.stringify({ mmrCore: { defaultMode: "deep" } }),
      );
      writeFileSync(
        path.join(project, ".pi/settings.json"),
        JSON.stringify({ mmrCore: ["oops"] }),
      );

      const { loadMmrCoreSettings } = await importSource("extensions/mmr-core/settings.ts");
      const loaded = loadMmrCoreSettings(project, home);

      assert.equal(loaded.settings.defaultMode, "deep");
      assert.equal(loaded.filesRead.length, 2);
      assert.ok(
        loaded.warnings.some((w) => /mmrCore/.test(w) && /\/project\/\.pi\/settings\.json/.test(w)),
        `expected an mmrCore-shape warning, got ${JSON.stringify(loaded.warnings)}`,
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("emits a deprecation warning when toolAliases appears in a settings file and ignores it", async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), "pi-mmr-settings-"));
    try {
      const home = path.join(tempRoot, "home");
      const project = path.join(tempRoot, "project");
      mkdirSync(path.join(home, ".pi/agent"), { recursive: true });
      mkdirSync(path.join(project, ".pi"), { recursive: true });

      writeFileSync(
        path.join(home, ".pi/agent/settings.json"),
        JSON.stringify({ mmrCore: { defaultMode: "deep" } }),
      );
      writeFileSync(
        path.join(project, ".pi/settings.json"),
        JSON.stringify({ mmrCore: { toolAliases: { oracle: ["mmr-oracle"] } } }),
      );

      const { loadMmrCoreSettings } = await importSource("extensions/mmr-core/settings.ts");
      const loaded = loadMmrCoreSettings(project, home);

      assert.equal(loaded.settings.defaultMode, "deep");
      assert.equal(loaded.settings.toolAliases, undefined);
      assert.ok(
        loaded.warnings.some((w) => /toolAliases/.test(w) && /removed/.test(w) && /\/project\/\.pi\/settings\.json/.test(w)),
        `expected a toolAliases deprecation warning, got ${JSON.stringify(loaded.warnings)}`,
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("warns when modelPreferences is the wrong shape and ignores it", async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), "pi-mmr-settings-"));
    try {
      const home = path.join(tempRoot, "home");
      const project = path.join(tempRoot, "project");
      mkdirSync(path.join(home, ".pi/agent"), { recursive: true });
      mkdirSync(path.join(project, ".pi"), { recursive: true });

      writeFileSync(
        path.join(home, ".pi/agent/settings.json"),
        JSON.stringify({ mmrCore: { defaultMode: "deep" } }),
      );
      writeFileSync(
        path.join(project, ".pi/settings.json"),
        JSON.stringify({ mmrCore: { modelPreferences: ["gpt-5.5"] } }),
      );

      const { loadMmrCoreSettings } = await importSource("extensions/mmr-core/settings.ts");
      const loaded = loadMmrCoreSettings(project, home);

      assert.equal(loaded.settings.defaultMode, "deep");
      assert.equal(loaded.settings.modelPreferences, undefined);
      assert.ok(
        loaded.warnings.some((w) => /modelPreferences/.test(w) && /\/project\/\.pi\/settings\.json/.test(w)),
        `expected a modelPreferences-shape warning, got ${JSON.stringify(loaded.warnings)}`,
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("mmr-core settings - read path hardening", () => {
  it("refuses to follow a symlinked settings file on load and keeps the sibling file", async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), "pi-mmr-settings-symlink-"));
    try {
      const home = path.join(tempRoot, "home");
      const project = path.join(tempRoot, "project");
      mkdirSync(path.join(home, ".pi/agent"), { recursive: true });
      mkdirSync(path.join(project, ".pi"), { recursive: true });

      writeFileSync(
        path.join(home, ".pi/agent/settings.json"),
        JSON.stringify({ mmrCore: { defaultMode: "rush" } }),
      );
      const outside = path.join(tempRoot, "outside.json");
      writeFileSync(outside, JSON.stringify({ mmrCore: { defaultMode: "deep" } }));
      const projectSettings = path.join(project, ".pi/settings.json");
      symlinkSync(outside, projectSettings);

      const { loadMmrCoreSettings } = await importSource("extensions/mmr-core/settings.ts");
      const loaded = loadMmrCoreSettings(project, home);

      // Symlinked file is refused on read: its defaultMode is not applied.
      assert.equal(loaded.settings.defaultMode, "rush");
      assert.deepEqual(loaded.filesRead, [path.join(home, ".pi/agent/settings.json")]);
      assert.equal(loaded.warnings.length, 1);
      assert.match(loaded.warnings[0], /Could not read MMR settings from .*\/project\/\.pi\/settings\.json/);
      assert.match(loaded.warnings[0], /symbolic link/);

      // The symlink target is never modified by a read.
      assert.deepEqual(JSON.parse(readFileSync(outside, "utf8")), { mmrCore: { defaultMode: "deep" } });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("locks filesRead semantics for missing, empty, and valid files", async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), "pi-mmr-settings-matrix-"));
    try {
      const home = path.join(tempRoot, "home");
      const project = path.join(tempRoot, "project");
      mkdirSync(path.join(home, ".pi/agent"), { recursive: true });
      mkdirSync(path.join(project, ".pi"), { recursive: true });

      // Missing home file (directory exists, file does not); empty project file.
      writeFileSync(path.join(project, ".pi/settings.json"), "{}");

      const { loadMmrCoreSettings } = await importSource("extensions/mmr-core/settings.ts");
      const missingHome = loadMmrCoreSettings(project, home);

      // Missing file is not counted as read; present-but-empty file is.
      assert.deepEqual(missingHome.filesRead, [path.join(project, ".pi/settings.json")]);
      assert.deepEqual(missingHome.warnings, []);
      assert.deepEqual(missingHome.settings, {});

      // Add a valid home file: both files now read.
      writeFileSync(
        path.join(home, ".pi/agent/settings.json"),
        JSON.stringify({ mmrCore: { defaultMode: "deep" } }),
      );
      const both = loadMmrCoreSettings(project, home);
      assert.deepEqual(both.filesRead, [
        path.join(home, ".pi/agent/settings.json"),
        path.join(project, ".pi/settings.json"),
      ]);
      assert.equal(both.settings.defaultMode, "deep");
      assert.deepEqual(both.warnings, []);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("mmr-core settings - lockedModeExtraTools", () => {
  it("parses all + per-mode buckets and merges global/project additively", async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), "pi-mmr-extra-settings-"));
    try {
      const home = path.join(tempRoot, "home");
      const project = path.join(tempRoot, "project");
      mkdirSync(path.join(home, ".pi/agent"), { recursive: true });
      mkdirSync(path.join(project, ".pi"), { recursive: true });

      writeFileSync(
        path.join(home, ".pi/agent/settings.json"),
        JSON.stringify({ mmr: { core: { lockedModeExtraTools: { all: ["g1"], deep: ["d1"] } } } }),
      );
      writeFileSync(
        path.join(project, ".pi/settings.json"),
        JSON.stringify({ mmrCore: { lockedModeExtraTools: { all: ["g2", "g1"], smart: ["s1"] } } }),
      );

      const { loadMmrCoreSettings } = await importSource("extensions/mmr-core/settings.ts");
      const loaded = loadMmrCoreSettings(project, home);

      assert.deepEqual(loaded.settings.lockedModeExtraTools, {
        all: ["g1", "g2"],
        deep: ["d1"],
        smart: ["s1"],
      });
      assert.deepEqual(loaded.warnings, []);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("ignores the free key and unknown keys with warnings, and trims/dedupes names", async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), "pi-mmr-extra-settings-"));
    try {
      const home = path.join(tempRoot, "home");
      const project = path.join(tempRoot, "project");
      mkdirSync(path.join(home, ".pi/agent"), { recursive: true });
      mkdirSync(path.join(project, ".pi"), { recursive: true });

      writeFileSync(
        path.join(home, ".pi/agent/settings.json"),
        JSON.stringify({ mmrCore: { defaultMode: "smart" } }),
      );
      writeFileSync(
        path.join(project, ".pi/settings.json"),
        JSON.stringify({
          mmrCore: {
            lockedModeExtraTools: {
              free: ["nope"],
              bogus: ["nope"],
              rush: ["  a  ", "a", "b"],
            },
          },
        }),
      );

      const { loadMmrCoreSettings } = await importSource("extensions/mmr-core/settings.ts");
      const loaded = loadMmrCoreSettings(project, home);

      assert.deepEqual(loaded.settings.lockedModeExtraTools, { rush: ["a", "b"] });
      assert.ok(
        loaded.warnings.some((w) => w.includes("lockedModeExtraTools.free") && w.includes("not configurable")),
        `expected a free-key warning, got ${JSON.stringify(loaded.warnings)}`,
      );
      assert.ok(
        loaded.warnings.some((w) => w.includes("lockedModeExtraTools.bogus")),
        `expected a bogus-key warning, got ${JSON.stringify(loaded.warnings)}`,
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("warns and skips when lockedModeExtraTools is not an object", async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), "pi-mmr-extra-settings-"));
    try {
      const home = path.join(tempRoot, "home");
      const project = path.join(tempRoot, "project");
      mkdirSync(path.join(home, ".pi/agent"), { recursive: true });
      mkdirSync(path.join(project, ".pi"), { recursive: true });

      writeFileSync(
        path.join(home, ".pi/agent/settings.json"),
        JSON.stringify({ mmrCore: { defaultMode: "smart" } }),
      );
      writeFileSync(
        path.join(project, ".pi/settings.json"),
        JSON.stringify({ mmrCore: { lockedModeExtraTools: ["read"] } }),
      );

      const { loadMmrCoreSettings } = await importSource("extensions/mmr-core/settings.ts");
      const loaded = loadMmrCoreSettings(project, home);

      assert.equal(loaded.settings.lockedModeExtraTools, undefined);
      assert.ok(
        loaded.warnings.some((w) => w.includes("lockedModeExtraTools")),
        `expected a shape warning, got ${JSON.stringify(loaded.warnings)}`,
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
