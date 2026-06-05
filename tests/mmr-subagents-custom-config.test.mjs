import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const MODULE = "extensions/mmr-subagents/custom-config.ts";

function makeProject() {
  const home = mkdtempSync(path.join(os.tmpdir(), "pi-mmr-cfg-home-"));
  const cwd = mkdtempSync(path.join(os.tmpdir(), "pi-mmr-cfg-cwd-"));
  return { home, cwd, cleanup: () => { rmSync(home, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); } };
}

function writeSettings(filePath, obj) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(obj));
}

describe("mmr-subagents custom config", () => {
  it("loads and merges global + project records, project layer overriding by id", async () => {
    const { loadMmrSubagentsConfig } = await importSource(MODULE);
    const { home, cwd, cleanup } = makeProject();
    try {
      writeSettings(path.join(home, ".pi", "agent", "settings.json"), {
        mmrSubagents: { custom: { agents: {
          shared: { enabled: true, source: { root: "global", file: "shared.md" }, modes: "allLocked" },
          globalOnly: { enabled: true, source: { root: "global", file: "g.md" }, modes: ["deep"] },
        } } },
      });
      writeSettings(path.join(cwd, ".pi", "settings.json"), {
        mmrSubagents: { custom: { agents: {
          shared: { enabled: false, source: { root: "project", file: "shared.md" }, modes: ["smart"] },
        } } },
      });
      const { records } = loadMmrSubagentsConfig({ cwd, homeDir: home });
      assert.equal(records.get("shared").enabled, false, "project record overrides global");
      assert.equal(records.get("shared").layer, "project");
      assert.equal(records.get("globalOnly").layer, "global");
      assert.deepEqual(records.get("globalOnly").modes, ["deep"]);
    } finally {
      cleanup();
    }
  });

  it("resolves only enabled, in-scope records with absolute source paths", async () => {
    const { resolveEnabledMmrCustomSubagents } = await importSource(MODULE);
    const { home, cwd, cleanup } = makeProject();
    try {
      writeSettings(path.join(home, ".pi", "agent", "settings.json"), {
        mmrSubagents: { custom: { agents: {
          here: { enabled: true, source: { root: "global", file: "here.md" }, toolName: "sa__here", modes: ["deep"], projects: [cwd] },
          elsewhere: { enabled: true, source: { root: "global", file: "x.md" }, toolName: "sa__x", modes: ["deep"], projects: ["/some/other/project"] },
          disabled: { enabled: false, source: { root: "global", file: "d.md" }, toolName: "sa__d", modes: "allLocked" },
        } } },
      });
      const { resolved } = resolveEnabledMmrCustomSubagents({ cwd, homeDir: home });
      const names = resolved.map((entry) => entry.record.toolName).sort();
      assert.deepEqual(names, ["sa__here"], "only the enabled, in-scope global record resolves");
      assert.equal(resolved[0].filePath, path.join(home, ".pi", "agent", "subagents", "here.md"));
    } finally {
      cleanup();
    }
  });

  it("drops invalid modes and records that expose no valid modes", async () => {
    const { resolveEnabledMmrCustomSubagents } = await importSource(MODULE);
    const { home, cwd, cleanup } = makeProject();
    try {
      writeSettings(path.join(cwd, ".pi", "settings.json"), {
        mmrSubagents: { custom: { agents: {
          bad: { enabled: true, source: { root: "project", file: "b.md" }, modes: ["free", "nope"] },
          good: { enabled: true, source: { root: "project", file: "g.md" }, modes: ["deep", "free"] },
        } } },
      });
      const { resolved, warnings } = resolveEnabledMmrCustomSubagents({ cwd, homeDir: home });
      const ids = resolved.map((entry) => entry.record.id);
      assert.deepEqual(ids, ["good"], "the record with no valid modes is dropped");
      assert.deepEqual(resolved[0].record.modes, ["deep"], "free is not a valid locked mode");
      assert.ok(warnings.some((w) => w.includes("no valid modes")));
    } finally {
      cleanup();
    }
  });

  it("writes a record preserving unrelated keys and round-trips", async () => {
    const { writeMmrSubagentsConfigRecord, loadMmrSubagentsConfig } = await importSource(MODULE);
    const { home, cwd, cleanup } = makeProject();
    try {
      const filePath = path.join(cwd, ".pi", "settings.json");
      writeSettings(filePath, { mmrCore: { defaultMode: "deep" }, mmrSubagents: { custom: { agents: {
        keep: { enabled: true, source: { root: "project", file: "keep.md" }, modes: "allLocked" },
      } } } });
      writeMmrSubagentsConfigRecord(filePath, "added", {
        enabled: true,
        source: { root: "project", file: "added.md" },
        toolName: "sa__added",
        modes: ["deep"],
        model: "openai-codex/gpt-5.5",
        tools: ["read", "find", "grep"],
      });
      const parsed = JSON.parse(readFileSync(filePath, "utf8"));
      assert.equal(parsed.mmrCore.defaultMode, "deep", "unrelated keys preserved");
      assert.ok(parsed.mmrSubagents.custom.agents.keep, "existing record preserved");
      const { records } = loadMmrSubagentsConfig({ cwd, homeDir: home });
      assert.equal(records.get("added").model, "openai-codex/gpt-5.5");
      assert.deepEqual(records.get("added").tools, ["read", "find", "grep"]);
    } finally {
      cleanup();
    }
  });

  it("rejects unsafe source paths, non-conforming toolNames, and reserved ids", async () => {
    const { loadMmrSubagentsConfig } = await importSource(MODULE);
    const { home, cwd, cleanup } = makeProject();
    try {
      writeSettings(path.join(cwd, ".pi", "settings.json"), {
        mmrSubagents: { custom: { agents: {
          escape: { enabled: true, source: { root: "project", file: "../escape.md" }, modes: ["deep"] },
          badName: { enabled: true, source: { root: "project", file: "x.md" }, toolName: "evil", modes: ["deep"] },
          badShape: { enabled: true, source: { root: "project", file: "x.md" }, toolName: "sa__Bad-Name", modes: ["deep"] },
          okDots: { enabled: true, source: { root: "project", file: "foo..bar.md" }, toolName: "sa__ok", modes: ["deep"] },
          __proto__: { enabled: true, source: { root: "project", file: "p.md" }, modes: ["deep"] },
        } } },
      });
      const { records, warnings } = loadMmrSubagentsConfig({ cwd, homeDir: home });
      assert.ok(!records.has("escape"), "path traversal rejected");
      assert.ok(!records.has("badName"), "non-sa__ toolName rejected");
      assert.ok(!records.has("badShape"), "sa__ with illegal slug chars rejected");
      assert.ok(records.has("okDots"), "a filename containing '..' inside a segment is allowed");
      assert.ok(!records.has("__proto__"), "reserved id skipped");
      assert.ok(warnings.length >= 3);
    } finally {
      cleanup();
    }
  });

  it("drops relative global project-scope entries and keeps absolute ones", async () => {
    const { loadMmrSubagentsConfig, isMmrCustomSubagentInScope } = await importSource(MODULE);
    const { home, cwd, cleanup } = makeProject();
    try {
      writeSettings(path.join(home, ".pi", "agent", "settings.json"), {
        mmrSubagents: { custom: { agents: {
          scoped: { enabled: true, source: { root: "global", file: "s.md" }, toolName: "sa__scoped", modes: ["deep"], projects: [".", cwd] },
        } } },
      });
      const { records, warnings } = loadMmrSubagentsConfig({ cwd, homeDir: home });
      const record = records.get("scoped");
      assert.deepEqual(record.projects, [path.resolve(cwd)], "relative '.' dropped; absolute kept");
      assert.ok(warnings.some((w) => w.includes("must be absolute")));
      assert.equal(isMmrCustomSubagentInScope(record, cwd), true);
      assert.equal(isMmrCustomSubagentInScope(record, "/somewhere/else"), false);
    } finally {
      cleanup();
    }
  });

  it("writeMmrSubagentsConfigRecord refuses reserved ids", async () => {
    const { writeMmrSubagentsConfigRecord } = await importSource(MODULE);
    const { cwd, cleanup } = makeProject();
    try {
      assert.throws(
        () => writeMmrSubagentsConfigRecord(path.join(cwd, ".pi", "settings.json"), "__proto__", {
          enabled: true, source: { root: "project", file: "x.md" }, toolName: "sa__x", modes: ["deep"], model: "inherit", tools: [],
        }),
        /reserved agent id/,
      );
    } finally {
      cleanup();
    }
  });
});
