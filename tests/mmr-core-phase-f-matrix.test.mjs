// Phase F: combined mode/tool-set matrix snapshots and structural invariants.
//
// Builds the assembled system prompt plus the renderer-flattened effective
// surface for every (mode × tool-set) combination, pins each combination as
// a snapshot, and asserts the cross-cutting invariants the plan calls for:
// expected block order, byte-identical Pi-authored blocks, mode-posture
// isolation, active-manifest invariants, planned-tool absence across the
// flattened surface, and free-mode passthrough.

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  BASELINE_TOOL_SETS,
  buildBasePromptForActiveManifest,
  buildBaselineManifest,
} from "./helpers/manifest-fixtures.mjs";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const promptFixtureDir = path.join(import.meta.dirname, "fixtures/mmr-core-prompts");
const effectiveSurfaceFixtureDir = path.join(
  import.meta.dirname,
  "fixtures/mmr-effective-surface",
);
const BASE_PROMPT = readFileSync(path.join(promptFixtureDir, "base.md"), "utf8");

const UPDATE_FIXTURES = process.env.PI_MMR_UPDATE_FIXTURES === "1";

// smart-family variants render the smart system prompt verbatim apart from the
// <mmr_mode name="..."> tag. They are excluded from the matrix snapshots and
// the per-(mode × tool-set) invariant loops so that release-time renames touch
// fewer fixtures, but they stay in the structural marker checks
// (MATRIX_MARKER_MODES) so that the per-mode tag isolation invariant still
// covers them.
const MATRIX_MODES = ["smart", "rush", "large", "deep"];
const MATRIX_MARKER_MODES = ["smart", "smartGPT", "smartSonnet", "smartFable", "rush", "test", "large", "deep"];

// Distinguishing per-mode markers. The smart family (smart, smartGPT,
// smartSonnet, smartFable, large) shares one prompt body, so each member is
// identified by its <mmr_mode name="..."> tag. Rush and Deep have distinctive
// posture-body sentences.
const MODE_MARKERS = {
  smart: '<mmr_mode name="smart">',
  smartGPT: '<mmr_mode name="smartGPT">',
  smartSonnet: '<mmr_mode name="smartSonnet">',
  smartFable: '<mmr_mode name="smartFable">',
  rush: "You run with no extended reasoning",
  test: '<mmr_mode name="test">',
  large: '<mmr_mode name="large">',
  deep: "Deep mode is for difficult reasoning,",
};

// Markers that must NOT appear in a mode's rendered prompt (other modes'
// distinctive markers). The smart family shares its prompt body, so its
// members exclude each other's mode tags rather than body text.
const MODE_FOREIGN_MARKERS = {
  smart: ['<mmr_mode name="smartGPT">', '<mmr_mode name="smartSonnet">', '<mmr_mode name="smartFable">', '<mmr_mode name="test">', '<mmr_mode name="large">', "You run with no extended reasoning", "Deep mode is for difficult reasoning,"],
  smartGPT: ['<mmr_mode name="smart">', '<mmr_mode name="smartSonnet">', '<mmr_mode name="smartFable">', '<mmr_mode name="test">', '<mmr_mode name="large">', "You run with no extended reasoning", "Deep mode is for difficult reasoning,"],
  smartSonnet: ['<mmr_mode name="smart">', '<mmr_mode name="smartGPT">', '<mmr_mode name="smartFable">', '<mmr_mode name="test">', '<mmr_mode name="large">', "You run with no extended reasoning", "Deep mode is for difficult reasoning,"],
  smartFable: ['<mmr_mode name="smart">', '<mmr_mode name="smartGPT">', '<mmr_mode name="smartSonnet">', '<mmr_mode name="test">', '<mmr_mode name="large">', "You run with no extended reasoning", "Deep mode is for difficult reasoning,"],
  rush: ['<mmr_mode name="smart">', '<mmr_mode name="smartGPT">', '<mmr_mode name="smartSonnet">', '<mmr_mode name="smartFable">', '<mmr_mode name="test">', '<mmr_mode name="large">', "Deep mode is for difficult reasoning,"],
  test: ['<mmr_mode name="smart">', '<mmr_mode name="smartGPT">', '<mmr_mode name="smartSonnet">', '<mmr_mode name="smartFable">', '<mmr_mode name="rush">', '<mmr_mode name="large">', "Deep mode is for difficult reasoning,"],
  large: ['<mmr_mode name="smart">', '<mmr_mode name="smartGPT">', '<mmr_mode name="smartSonnet">', '<mmr_mode name="smartFable">', '<mmr_mode name="test">', "You run with no extended reasoning", "Deep mode is for difficult reasoning,"],
  deep: ['<mmr_mode name="smart">', '<mmr_mode name="smartGPT">', '<mmr_mode name="smartSonnet">', '<mmr_mode name="smartFable">', '<mmr_mode name="test">', '<mmr_mode name="large">', "You run with no extended reasoning"],
};

// Expected coarse block order. Matches the existing Phase B baseline.
const EXPECTED_NON_LARGE_BLOCK_ORDER = [
  '<mmr_mode name="',
  "## Autonomy and persistence",
  "## Executing actions with care",
  "## Working with the user",
  "## Response style",
  "## Tool use",
  "Available tools:",
  "Guidelines:",
  "## Built-in tool guidance",
  "Pi documentation (",
  "## Tool execution policy",
  "# Project Context",
  "Current date:",
  "Current working directory:",
];


const EXPECTED_TOOLS_BY_SET = {
  "core-only": [],
  "core+patch+tasks": ["apply_patch", "task_list"],
  "core+web": ["web_search", "read_web_page"],
  "core+patch+tasks+web": ["apply_patch", "task_list", "web_search", "read_web_page"],
};

const EXPECTED_OWNERS = {
  apply_patch: "mmr-patch",
  task_list: "mmr-tasks",
  web_search: "mmr-web",
  read_web_page: "mmr-web",
};

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

function assertFixtureMatches(filename, actual) {
  const fixturePath = path.join(effectiveSurfaceFixtureDir, filename);
  if (UPDATE_FIXTURES || !existsSync(fixturePath)) {
    writeFileSync(fixturePath, actual);
    if (!UPDATE_FIXTURES) {
      console.log(`[phase-f] wrote new fixture ${fixturePath}`);
    }
    return;
  }
  const expected = readFileSync(fixturePath, "utf8");
  assert.equal(actual, expected, `fixture ${filename} drift; rerun with PI_MMR_UPDATE_FIXTURES=1 to refresh`);
}

describe("Phase F: combined mode/tool-set matrix snapshots", () => {
  for (const mode of MATRIX_MODES) {
    for (const toolSet of BASELINE_TOOL_SETS) {
      it(`renders the ${mode}-mode effective surface for ${toolSet}`, async () => {
        const { assembleActiveSurface } = await importSource("extensions/mmr-core/prompt-assembly.ts");
        const { renderMmrPromptDebugFixture } = await importSource("extensions/mmr-core/prompt-debug-renderer.ts");
        const activeToolManifest = await buildBaselineManifest(toolSet);
        const baseSystemPrompt = buildBasePromptForActiveManifest(BASE_PROMPT, activeToolManifest);
        const result = assembleActiveSurface({
          state: createState(mode),
          baseSystemPrompt,
          activeToolManifest,
          provider: "claude-subscription",
          model: "claude-opus-4-8",
        });
        const rendered = renderMmrPromptDebugFixture(result);
        assertFixtureMatches(`${mode}.${toolSet}.md`, rendered);
      });
    }
  }
});

describe("Phase F: per-mode structural invariants across the matrix", () => {
  for (const mode of MATRIX_MARKER_MODES) {
    it(`${mode}: assembled prompt follows the expected coarse block order`, async () => {
      const { assembleActiveSurface } = await importSource("extensions/mmr-core/prompt-assembly.ts");
      const result = assembleActiveSurface({
        state: createState(mode),
        baseSystemPrompt: BASE_PROMPT,
        activeToolManifest: [],
      });
      const expectedBlockOrder = EXPECTED_NON_LARGE_BLOCK_ORDER;
      let cursor = 0;
      for (const marker of expectedBlockOrder) {
        const idx = result.systemPrompt.indexOf(marker, cursor);
        assert.notEqual(idx, -1, `${mode}: missing block marker "${marker}" at/after offset ${cursor}`);
        cursor = idx + marker.length;
      }
    });

    it(`${mode}: Available tools, Guidelines, and Pi docs blocks are byte-identical to base.md`, async () => {
      const { assembleActiveSurface } = await importSource("extensions/mmr-core/prompt-assembly.ts");
      const result = assembleActiveSurface({
        state: createState(mode),
        baseSystemPrompt: BASE_PROMPT,
        activeToolManifest: [],
      });
      for (const header of ["Available tools:", "Guidelines:", "Pi documentation ("]) {
        const baseStart = BASE_PROMPT.indexOf(`\n\n${header}`);
        assert.notEqual(baseStart, -1, `base.md missing ${header}`);
        const headerStart = baseStart + 2;
        const headerEnd = BASE_PROMPT.indexOf("\n\n", headerStart);
        const body = BASE_PROMPT.slice(headerStart, headerEnd === -1 ? undefined : headerEnd);
        assert.ok(
          result.systemPrompt.includes(body),
          `${mode}: rendered systemPrompt missing verbatim ${header} block`,
        );
      }
    });

    it(`${mode}: includes its own mode marker and excludes other modes' distinctive markers`, async () => {
      const { assembleActiveSurface } = await importSource("extensions/mmr-core/prompt-assembly.ts");
      const result = assembleActiveSurface({
        state: createState(mode),
        baseSystemPrompt: BASE_PROMPT,
        activeToolManifest: [],
      });
      assert.ok(
        result.systemPrompt.includes(MODE_MARKERS[mode]),
        `${mode}: missing own marker ${MODE_MARKERS[mode]}`,
      );
      for (const foreign of MODE_FOREIGN_MARKERS[mode]) {
        assert.equal(
          result.systemPrompt.includes(foreign),
          false,
          `${mode}: must not include foreign mode marker "${foreign}"`,
        );
      }
    });

    it(`${mode}: posture precedes tools, shared tool policy follows Pi docs, and style precedes response`, async () => {
      const { assembleActiveSurface, MMR_TOOL_USE_HEADING, MMR_TOOL_USE_POSTURE_LINE } = await importSource(
        "extensions/mmr-core/prompt-assembly.ts",
      );
      const result = assembleActiveSurface({
        state: createState(mode),
        baseSystemPrompt: BASE_PROMPT,
        activeToolManifest: [],
      });
      const sp = result.systemPrompt;
      const autonomyIdx = sp.indexOf("## Autonomy and persistence");
      const carefulActionsIdx = sp.indexOf("## Executing actions with care");
      // Only rush and deep render a mode posture; the smart family carries its
      // framing in the intro and body fragments.
      const postureMarker = mode === "rush" || mode === "test" ? "## Rush mode" : mode === "deep" ? "## Deep mode" : undefined; // smartSonnet falls through to undefined (smart-family, no posture)
      const collaborationIdx = sp.indexOf("## Working with the user");
      const responseStyleIdx = sp.indexOf("## Response style");
      const toolHeadingIdx = sp.indexOf(MMR_TOOL_USE_HEADING);
      const leadInIdx = sp.indexOf(MMR_TOOL_USE_POSTURE_LINE);
      const availIdx = sp.indexOf("Available tools:");
      const guidelinesIdx = sp.indexOf("Guidelines:");
      const docsIdx = sp.indexOf("Pi documentation (");
      const sharedToolIdx = sp.indexOf("## Tool execution policy");
      const styleIdx = mode === "rush" || mode === "test" ? sp.indexOf("## File links") : sp.indexOf("## Diagrams");
      assert.ok(toolHeadingIdx !== -1 && leadInIdx !== -1, `${mode}: missing tool-use heading or lead-in`);
      assert.ok(autonomyIdx < carefulActionsIdx, `${mode}: task/risk posture must stay in order`);
      if (postureMarker !== undefined) {
        const postureIdx = sp.indexOf(postureMarker);
        assert.ok(carefulActionsIdx < postureIdx, `${mode}: shared posture must precede mode posture`);
        assert.ok(postureIdx < collaborationIdx, `${mode}: mode posture must precede collaboration`);
      } else {
        assert.ok(carefulActionsIdx < collaborationIdx, `${mode}: shared posture must precede collaboration`);
      }
      assert.ok(collaborationIdx < responseStyleIdx, `${mode}: collaboration must precede response style`);
      assert.ok(responseStyleIdx < toolHeadingIdx, `${mode}: response style must precede tool guidance`);
      assert.ok(sharedToolIdx < styleIdx, `${mode}: shared tool policy must precede remaining style guidance`);
      assert.ok(toolHeadingIdx < availIdx, `${mode}: ## Tool use must precede Available tools:`);
      assert.ok(leadInIdx < availIdx, `${mode}: tool-use lead-in must precede Available tools:`);
      assert.ok(availIdx < guidelinesIdx, `${mode}: Available tools must precede Guidelines`);
      assert.ok(guidelinesIdx < docsIdx, `${mode}: Guidelines must precede Pi documentation`);
      assert.ok(docsIdx < sharedToolIdx, `${mode}: Pi documentation must precede shared tool guidance`);
    });
  }
});

describe("Phase F: active-manifest invariants across the matrix", () => {
  for (const mode of MATRIX_MODES) {
    for (const toolSet of BASELINE_TOOL_SETS) {
      it(`${mode} / ${toolSet}: active manifest matches the expected tool set, each tool appears exactly once, owners are stable`, async () => {
        const { assembleActiveSurface } = await importSource("extensions/mmr-core/prompt-assembly.ts");
        const { renderMmrPromptDebugFixture } = await importSource("extensions/mmr-core/prompt-debug-renderer.ts");
        const activeToolManifest = await buildBaselineManifest(toolSet);
        const baseSystemPrompt = buildBasePromptForActiveManifest(BASE_PROMPT, activeToolManifest);
        const result = assembleActiveSurface({
          state: createState(mode),
          baseSystemPrompt,
          activeToolManifest,
        });
        const expectedTools = EXPECTED_TOOLS_BY_SET[toolSet];
        const actualNames = result.activeToolManifest.map((e) => e.name);
        assert.deepEqual(
          actualNames,
          expectedTools,
          `${mode} / ${toolSet}: active manifest tool names must equal ${JSON.stringify(expectedTools)}`,
        );
        // No duplicates.
        assert.equal(new Set(actualNames).size, actualNames.length, `${mode} / ${toolSet}: manifest must not contain duplicates`);
        // Owner is stable per tool.
        for (const entry of result.activeToolManifest) {
          assert.equal(
            entry.owner,
            EXPECTED_OWNERS[entry.name],
            `${mode} / ${toolSet}: ${entry.name} owner must be ${EXPECTED_OWNERS[entry.name]}`,
          );
        }
        // Tool name appears in the renderer-flattened surface.
        const rendered = renderMmrPromptDebugFixture(result);
        for (const name of expectedTools) {
          const pattern = new RegExp(`^# ${name}\\b`, "m");
          assert.ok(
            pattern.test(rendered),
            `${mode} / ${toolSet}: renderer-flattened surface must contain tool section header "# ${name}"`,
          );
        }
        for (const entry of result.activeToolManifest) {
          if (entry.promptSnippet) {
            assert.ok(
              result.systemPrompt.includes(`- ${entry.name}: ${entry.promptSnippet}`),
              `${mode} / ${toolSet}: Available tools must include ${entry.name}'s promptSnippet`,
            );
          }
          for (const guideline of entry.promptGuidelines) {
            assert.ok(
              result.systemPrompt.includes(`- ${guideline}`),
              `${mode} / ${toolSet}: Guidelines must include ${entry.name}'s promptGuidelines`,
            );
          }
        }
      });
    }
  }
});

describe("Phase F: planned-tool negative-injection across the renderer-flattened surface", () => {
  for (const mode of MATRIX_MODES) {
    for (const toolSet of BASELINE_TOOL_SETS) {
      it(`${mode} / ${toolSet}: no planned-tool name leaks into the renderer-flattened effective surface`, async () => {
        const { assembleActiveSurface } = await importSource("extensions/mmr-core/prompt-assembly.ts");
        const { renderMmrPromptDebugFixture } = await importSource("extensions/mmr-core/prompt-debug-renderer.ts");
        const planned = await importSource("extensions/mmr-core/planned-catalog.ts");
        const activeToolManifest = await buildBaselineManifest(toolSet);
        const baseSystemPrompt = buildBasePromptForActiveManifest(BASE_PROMPT, activeToolManifest);
        const result = assembleActiveSurface({
          state: createState(mode),
          baseSystemPrompt,
          activeToolManifest,
        });
        const rendered = renderMmrPromptDebugFixture(result);
        for (const entry of planned.MMR_PLANNED_TOOL_CATALOG) {
          const pattern = new RegExp(`\\b${entry.name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`);
          assert.equal(
            pattern.test(rendered),
            false,
            `${mode} / ${toolSet}: planned tool ${entry.name} must not appear in renderer-flattened surface`,
          );
          assert.equal(
            rendered.includes(entry.summary),
            false,
            `${mode} / ${toolSet}: planned summary for ${entry.name} must not appear in renderer-flattened surface`,
          );
        }
      });
    }
  }
});

describe("Phase F: native-control passthrough invariant", () => {
  for (const mode of ["open", "free"]) {
  for (const toolSet of BASELINE_TOOL_SETS) {
    it(`${mode} / ${toolSet}: assembled systemPrompt equals base; manifest forwarded unchanged; no MMR-authored text injected`, async () => {
      const {
        assembleActiveSurface,
        MMR_TOOL_USE_POSTURE_LINE,
        MMR_RESPONSE_STYLE_HEADING,
      } = await importSource("extensions/mmr-core/prompt-assembly.ts");
      const activeToolManifest = await buildBaselineManifest(toolSet);
      const result = assembleActiveSurface({
        state: createState(mode),
        baseSystemPrompt: BASE_PROMPT,
        activeToolManifest,
      });
      assert.equal(result.systemPrompt, BASE_PROMPT, `${mode} / ${toolSet}: systemPrompt must equal base`);
      assert.deepEqual(result.activeToolManifest, activeToolManifest, `${mode} / ${toolSet}: manifest must be forwarded unchanged`);
      // No MMR-authored block markers must appear because BASE_PROMPT itself
      // contains none. If any of these strings appear, mode-specific text
      // leaked into a passthrough surface.
      const mmrOnlyTokens = [
        MMR_TOOL_USE_POSTURE_LINE,
        MMR_RESPONSE_STYLE_HEADING,
        '<mmr_mode name="smart">',
        '<mmr_mode name="smartGPT">',
        '<mmr_mode name="smartSonnet">',
        '<mmr_mode name="rush">',
        '<mmr_mode name="test">',
        '<mmr_mode name="large">',
        '<mmr_mode name="deep">',
        "You run with no extended reasoning",
        "Large mode is for broad-context work:",
        "Deep mode is for difficult reasoning,",
      ];
      for (const tok of mmrOnlyTokens) {
        assert.equal(
          result.systemPrompt.includes(tok),
          false,
          `${mode} / ${toolSet}: MMR-authored token "${tok}" must not appear in passthrough surface`,
        );
      }
      // Result.blocks must be the single preserved-tail passthrough.
      assert.equal(result.blocks.length, 1, `${mode} / ${toolSet}: blocks must be a single preserved-tail`);
      assert.equal(result.blocks[0].kind, "preserved-tail", `${mode} / ${toolSet}: only block must be preserved-tail`);
    });
  }
  }
});
