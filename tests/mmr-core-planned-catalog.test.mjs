// Phase E: planned metadata catalog.
//
// Verifies that the planned-tool catalog is exposed via mmr-core's public
// surface, that every entry is well-formed and uniquely named, and that no
// planned entry ever leaks into the model-facing system prompt or the
// resolved active tool manifest under any (mode × tool-set) combination.
//
// The negative-injection invariant is the load-bearing guarantee: planned
// entries are inert by construction, so growing the catalog cannot
// regress what the model sees.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  BASELINE_TOOL_SETS,
  buildBaselineManifest,
} from "./helpers/manifest-fixtures.mjs";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const promptFixtureDir = path.join(import.meta.dirname, "fixtures/mmr-core-prompts");
const BASE_PROMPT = readFileSync(path.join(promptFixtureDir, "base.md"), "utf8");

const PROMPTED_MODES = ["smart", "smartGPT", "smartSonnet", "smartFable", "rush", "test", "large", "deep"];
const ALL_MODES = [...PROMPTED_MODES, "open", "free"];

function createState(mode) {
  return {
    mode,
    displayName: mode,
    source: "settings",
    targetModel: "claude-opus-4-8",
    requestedModels: ["claude-opus-4-8"],
    provider: "claude-subscription",
    model: "claude-opus-4-8",
    modelFound: true,
    modelApplied: true,
    modelFallbackApplied: false,
    modelFallbackReason: undefined,
    modelCandidates: [],
    thinkingLevel: mode === "deep" ? "xhigh" : "medium",
    promptRoute: mode === "deep" ? "deep" : "default",
    requestedTools: ["Read", "Bash"],
    activeTools: ["read", "bash"],
    missingTools: [],
    deferredTools: [],
    featureGates: [],
    availabilityNotes: [],
    appliedAt: "2026-05-08T00:00:00.000Z",
  };
}

describe("Phase E: planned metadata catalog", () => {
  it("exports MMR_PLANNED_TOOL_CATALOG as a non-empty readonly array of well-formed entries", async () => {
    const mod = await importSource("extensions/mmr-core/planned-catalog.ts");
    assert.ok(Array.isArray(mod.MMR_PLANNED_TOOL_CATALOG), "MMR_PLANNED_TOOL_CATALOG must be an array");
    assert.ok(mod.MMR_PLANNED_TOOL_CATALOG.length > 0, "MMR_PLANNED_TOOL_CATALOG must contain at least one planned entry");

    for (const entry of mod.MMR_PLANNED_TOOL_CATALOG) {
      assert.equal(typeof entry.name, "string", "planned entry name must be a string");
      assert.notEqual(entry.name.trim(), "", "planned entry name must be non-empty");
      assert.equal(typeof entry.owner, "string", `${entry.name}: owner must be a string`);
      assert.match(entry.owner, /^mmr-/, `${entry.name}: owner must be an mmr-* extension`);
      assert.equal(entry.status, "planned", `${entry.name}: status must be "planned"`);
      assert.equal(typeof entry.summary, "string", `${entry.name}: summary must be a string`);
      assert.notEqual(entry.summary.trim(), "", `${entry.name}: summary must be non-empty`);
    }
  });

  it("exports only the remaining planned tool slots", async () => {
    const mod = await importSource("extensions/mmr-core/planned-catalog.ts");
    assert.deepEqual(
      mod.MMR_PLANNED_TOOL_CATALOG.map((entry) => entry.name).sort(),
      ["load_skill", "read_mcp_resource", "subagents"],
    );
  });

  it("re-exports MMR_PLANNED_TOOL_CATALOG from the package root", async () => {
    const root = await importSource("index.ts");
    const catalog = await importSource("extensions/mmr-core/planned-catalog.ts");
    assert.equal("MMR_PLANNED_TOOL_CATALOG" in root, true, "MMR_PLANNED_TOOL_CATALOG must be re-exported from the package root");
    assert.deepEqual(root.MMR_PLANNED_TOOL_CATALOG, catalog.MMR_PLANNED_TOOL_CATALOG);
  });

  it("names every planned entry uniquely (no duplicates with each other or with currently-active tool names)", async () => {
    const mod = await importSource("extensions/mmr-core/planned-catalog.ts");
    const names = mod.MMR_PLANNED_TOOL_CATALOG.map((e) => e.name);
    const uniq = new Set(names);
    assert.equal(uniq.size, names.length, "planned entry names must be unique");

    const activeNames = new Set([
      "apply_patch",
      "task_list",
      "web_search",
      "read_web_page",
    ]);
    for (const name of names) {
      assert.equal(
        activeNames.has(name),
        false,
        `${name}: planned entry must not collide with a currently-active pi-mmr tool name`,
      );
    }
  });

  it("never leaks a planned-tool name into the active tool manifest across all (mode × tool-set) combinations", async () => {
    const { assembleActiveSurface } = await importSource("extensions/mmr-core/prompt-assembly.ts");
    const planned = await importSource("extensions/mmr-core/planned-catalog.ts");
    const plannedNames = planned.MMR_PLANNED_TOOL_CATALOG.map((e) => e.name);

    for (const mode of ALL_MODES) {
      const state = createState(mode);
      for (const toolSet of BASELINE_TOOL_SETS) {
        const activeToolManifest = await buildBaselineManifest(toolSet);
        const result = assembleActiveSurface({
          state,
          baseSystemPrompt: BASE_PROMPT,
          activeToolManifest,
        });
        const manifestNames = new Set(result.activeToolManifest.map((e) => e.name));
        for (const planned of plannedNames) {
          assert.equal(
            manifestNames.has(planned),
            false,
            `${mode} / ${toolSet}: planned tool ${planned} must not appear in activeToolManifest`,
          );
        }
      }
    }
  });

  it("never leaks a planned-tool name into the rendered system prompt across all (mode × tool-set) combinations", async () => {
    const { assembleActiveSurface } = await importSource("extensions/mmr-core/prompt-assembly.ts");
    const planned = await importSource("extensions/mmr-core/planned-catalog.ts");
    const plannedNames = planned.MMR_PLANNED_TOOL_CATALOG.map((e) => e.name);

    for (const mode of ALL_MODES) {
      const state = createState(mode);
      for (const toolSet of BASELINE_TOOL_SETS) {
        const activeToolManifest = await buildBaselineManifest(toolSet);
        const result = assembleActiveSurface({
          state,
          baseSystemPrompt: BASE_PROMPT,
          activeToolManifest,
        });
        for (const name of plannedNames) {
          const pattern = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`);
          assert.equal(
            pattern.test(result.systemPrompt),
            false,
            `${mode} / ${toolSet}: planned tool name ${name} must not appear in systemPrompt`,
          );
        }
      }
    }
  });

  it("never leaks a planned-tool summary verbatim into the rendered system prompt", async () => {
    // Defensive: even if a tool name happened to be a common English word, the
    // entry's pi-mmr-authored summary text is distinctive and must never
    // surface in the model-facing prompt.
    const { assembleActiveSurface } = await importSource("extensions/mmr-core/prompt-assembly.ts");
    const planned = await importSource("extensions/mmr-core/planned-catalog.ts");

    for (const mode of ALL_MODES) {
      const state = createState(mode);
      for (const toolSet of BASELINE_TOOL_SETS) {
        const activeToolManifest = await buildBaselineManifest(toolSet);
        const result = assembleActiveSurface({
          state,
          baseSystemPrompt: BASE_PROMPT,
          activeToolManifest,
        });
        for (const entry of planned.MMR_PLANNED_TOOL_CATALOG) {
          assert.equal(
            result.systemPrompt.includes(entry.summary),
            false,
            `${mode} / ${toolSet}: planned summary for ${entry.name} must not appear in systemPrompt`,
          );
        }
      }
    }
  });
});
