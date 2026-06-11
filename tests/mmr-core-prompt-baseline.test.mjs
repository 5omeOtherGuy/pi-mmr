// Phase B baseline tests. Captures the *current* block ordering of the
// MMR-rewritten system prompt and the *current* effective surface (system
// prompt + active tool manifest) for the four canonical tool-set
// combinations, before Phase D refactors prompt.ts into explicit ordered
// modules.
//
// The full per-mode prompt snapshots in tests/mmr-core-prompts/*.md pin the
// exact text. These coarse-grained assertions pin structural invariants
// that must survive Phase D's wording changes.

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
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
    thinkingLevel: "medium",
    promptRoute: "default",
    requestedTools: ["Read", "Bash"],
    activeTools: ["read", "bash"],
    missingTools: [],
    deferredTools: [],
    featureGates: [],
    availabilityNotes: [],
    appliedAt: "2026-05-08T00:00:00.000Z",
  };
}

const MODES = ["smart", "rush", "large", "deep"];

// Coarse-grained block order. Each entry is a substring that uniquely
// identifies the start of a block in the rendered prompt; the substrings
// must appear in this order. Phase D will rewrite block authoring but must
// preserve this ordering.
const EXPECTED_NON_LARGE_BLOCK_ORDER = [
  '<mmr_mode name="',
  "## Autonomy and persistence",
  "## Executing actions with care",
  "## Working with the user",
  "## Response style",
  "## Tool use",
  "Available tools:",
  "Guidelines:",
  "Pi documentation (",
  "## Tool execution policy",
  "# Project Context",
  "<available_skills>",
  "Current date:",
  "Current working directory:",
];


describe("Phase B baseline: buildMmrPromptLayer block ordering", () => {
  let buildMmrPromptLayer;

  beforeEach(async () => {
    const mod = await importSource("extensions/mmr-core/prompt.ts");
    buildMmrPromptLayer = mod.buildMmrPromptLayer;
  });

  for (const mode of MODES) {
    it(`renders ${mode} mode with the expected block order`, () => {
      const rendered = buildMmrPromptLayer({
        state: createState(mode),
        baseSystemPrompt: BASE_PROMPT,
      });

      const expectedBlockOrder = EXPECTED_NON_LARGE_BLOCK_ORDER;
      let cursor = 0;
      for (const marker of expectedBlockOrder) {
        const idx = rendered.indexOf(marker, cursor);
        assert.notEqual(
          idx,
          -1,
          `mode ${mode}: expected to find marker "${marker}" at or after offset ${cursor}`,
        );
        cursor = idx + marker.length;
      }
    });

    it(`renders ${mode} mode with Available tools, Guidelines, and Pi docs byte-identical to Pi-injected text`, () => {
      const rendered = buildMmrPromptLayer({
        state: createState(mode),
        baseSystemPrompt: BASE_PROMPT,
      });
      // Phase D policy: every Pi-authored auto-section is passed through
      // byte-for-byte. Each block in the base prompt is delimited by a
      // blank line; the rendered prompt must include every such delimited
      // block verbatim.
      const blocks = ["Available tools:", "Guidelines:", "Pi documentation ("];
      for (const blockHeader of blocks) {
        const baseStart = BASE_PROMPT.indexOf(`\n\n${blockHeader}`);
        assert.notEqual(baseStart, -1, `base.md is missing ${blockHeader}`);
        const headerStart = baseStart + 2;
        const headerEnd = BASE_PROMPT.indexOf("\n\n", headerStart);
        const body = BASE_PROMPT.slice(headerStart, headerEnd === -1 ? undefined : headerEnd);
        assert.ok(
          rendered.includes(body),
          `mode ${mode}: rendered prompt is missing the verbatim ${blockHeader} block`,
        );
      }
    });

    it(`renders ${mode} mode with the Pi Guidelines block passed through unfiltered`, () => {
      const rendered = buildMmrPromptLayer({
        state: createState(mode),
        baseSystemPrompt: BASE_PROMPT,
      });
      // Phase D drops the guideline-bullet filter; every Pi-authored
      // bullet, including the two that earlier mmr-core versions stripped,
      // must now appear verbatim in the rendered prompt.
      assert.ok(
        rendered.includes("- Be concise in your responses"),
        `mode ${mode}: Phase D must stop stripping the "Be concise" bullet`,
      );
      assert.ok(
        rendered.includes("- Show file paths clearly when working with files"),
        `mode ${mode}: Phase D must stop stripping the "Show file paths" bullet`,
      );
      assert.ok(
        rendered.includes("- Use read to examine files instead of cat or sed."),
        `mode ${mode}: other Pi-authored bullets must still appear`,
      );
    });
  }

  it("free mode passes the base prompt through unchanged", () => {
    const rendered = buildMmrPromptLayer({
      state: createState("free"),
      baseSystemPrompt: BASE_PROMPT,
    });
    assert.equal(rendered, BASE_PROMPT);
  });
});

describe("Phase B baseline: effective-surface snapshots (renderer + buildMmrPromptLayer)", () => {
  let buildMmrPromptLayer;
  let renderMmrPromptDebugFixture;

  beforeEach(async () => {
    const prompt = await importSource("extensions/mmr-core/prompt.ts");
    const renderer = await importSource("extensions/mmr-core/prompt-debug-renderer.ts");
    buildMmrPromptLayer = prompt.buildMmrPromptLayer;
    renderMmrPromptDebugFixture = renderer.renderMmrPromptDebugFixture;
  });

  for (const toolSet of BASELINE_TOOL_SETS) {
    it(`renders the smart-mode effective surface for ${toolSet}`, async () => {
      const activeToolManifest = await buildBaselineManifest(toolSet);
      const baseSystemPrompt = buildBasePromptForActiveManifest(BASE_PROMPT, activeToolManifest);
      const systemPrompt = buildMmrPromptLayer({
        state: createState("smart"),
        baseSystemPrompt,
      });
      const result = {
        mode: "smart",
        provider: "claude-subscription",
        model: "claude-opus-4-8",
        blocks: [],
        systemPrompt,
        activeToolManifest,
      };
      const rendered = renderMmrPromptDebugFixture(result);
      assertFixtureMatches(`smart.${toolSet}.md`, rendered);
    });
  }
});

function assertFixtureMatches(filename, actual) {
  const fixturePath = path.join(effectiveSurfaceFixtureDir, filename);
  if (UPDATE_FIXTURES || !existsSync(fixturePath)) {
    writeFileSync(fixturePath, actual);
    if (!UPDATE_FIXTURES) {
      // First-run write: warn loudly but don't fail. Subsequent runs pin.
      console.log(`[baseline] wrote new fixture ${fixturePath}`);
    }
    return;
  }
  const expected = readFileSync(fixturePath, "utf8");
  assert.equal(actual, expected, `fixture ${filename} drift; rerun with PI_MMR_UPDATE_FIXTURES=1 to refresh`);
}
