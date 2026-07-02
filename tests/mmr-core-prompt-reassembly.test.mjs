// Prompt-tail drift hardening: stricter coverage of the byte-exact invariant
// that lets `assembleActiveSurface` STRIP a previously-injected MMR tail on
// re-assembly instead of DUPLICATING it.
//
// The forward render (`renderFragment`) and the backward strip table
// (`PREVIOUS_MMR_TAILS` / `findPreviousMmrTailEnd`) must agree byte-for-byte on
// the MMR-owned post-pi-docs tail. If they drift, re-assembling an already
// MMR-rewritten prompt either duplicates the tail (forward emits text the
// backward table cannot match) or falls back to passthrough (backward matches
// but forward changed). Both failures are observable here:
//   (a) byte-stable idempotence per mode (re-assembly is a no-op and still a
//       real rewrite, not a passthrough), and
//   (b) cross-mode strip (a `deep` parent re-assembled as a `smart` Task base
//       carries the smart tail exactly once and no deep posture).
//
// This complements the existing `mmr-core-prompt.test.mjs` duplication guard
// (repeated long lines) with byte-stability and cross-mode coverage.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const fixtureDir = path.join(import.meta.dirname, "fixtures/mmr-core-prompts");
const BASE_PROMPT = readFileSync(path.join(fixtureDir, "base.md"), "utf8");

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

const PROMPTED_MODES = ["smart", "smartGPT", "smartSonnet", "smartFable", "rush", "test", "large", "deep"];

// Distinctive per-mode body markers. The smart family renders no posture
// section, so smart is identified by its family-only "Investigate before
// acting" heading; the cross-mode test pairs deep -> smart, whose body
// sections are distinct.
const SMART_INVESTIGATE_HEADING = "## Investigate before acting";
const DEEP_POSTURE_HEADING = "## Deep mode";
const SMART_CLOSING_LINE =
  "You MUST answer concisely with fewer than 4 lines of text (not including tool use or code generation), unless the user asks for more detail.";
const AUTONOMY_HEADING = "## Autonomy and persistence";
const CAREFUL_ACTIONS_HEADING = "## Executing actions with care";
const TOOL_USE_HEADING = "## Tool use";
const DIAGRAMS_HEADING = "## Diagrams";
const COLLABORATION_HEADING = "## Working with the user";
const RESPONSE_STYLE_HEADING = "## Response style";

function assertBefore(prompt, before, after, message) {
  const beforeIndex = prompt.indexOf(before);
  const afterIndex = prompt.indexOf(after);
  assert.notEqual(beforeIndex, -1, `${message}: missing ${before}`);
  assert.notEqual(afterIndex, -1, `${message}: missing ${after}`);
  assert.ok(beforeIndex < afterIndex, `${message}: expected ${before} before ${after}`);
}

describe("assembleActiveSurface() prompt-tail drift hardening", () => {
  let assembleActiveSurface;

  beforeEach(async () => {
    const assembly = await importSource("extensions/mmr-core/prompt-assembly.ts");
    assembleActiveSurface = assembly.assembleActiveSurface;
  });

  it("places task/risk posture before tool guidance and preserves that order across re-assembly", () => {
    const first = assembleActiveSurface({
      state: createState("smart"),
      baseSystemPrompt: BASE_PROMPT,
      activeToolManifest: [],
    });
    assert.equal(first.passthroughReason, undefined, "first assembly must rewrite Pi's prompt");

    assertBefore(first.systemPrompt, AUTONOMY_HEADING, TOOL_USE_HEADING, "fresh smart prompt");
    assertBefore(first.systemPrompt, CAREFUL_ACTIONS_HEADING, TOOL_USE_HEADING, "fresh smart prompt");
    assertBefore(first.systemPrompt, RESPONSE_STYLE_HEADING, TOOL_USE_HEADING, "fresh smart prompt");
    assertBefore(first.systemPrompt, TOOL_USE_HEADING, DIAGRAMS_HEADING, "fresh smart prompt");

    const second = assembleActiveSurface({
      state: createState("smart"),
      baseSystemPrompt: first.systemPrompt,
      activeToolManifest: [],
    });
    assert.equal(second.systemPrompt, first.systemPrompt, "posture-first prompt must re-assemble byte-stably");
    assert.equal(second.passthroughReason, undefined, "re-assembly must remain a real rewrite");
    assert.equal(second.systemPrompt.split(AUTONOMY_HEADING).length - 1, 1, "autonomy heading must not duplicate");
    assert.equal(second.systemPrompt.split(TOOL_USE_HEADING).length - 1, 1, "tool-use heading must not duplicate");
  });

  for (const mode of PROMPTED_MODES.filter((mode) => mode !== "large")) {
    it(`places user-collaboration and response style before tool guidance for ${mode}`, () => {
      const first = assembleActiveSurface({
        state: createState(mode),
        baseSystemPrompt: BASE_PROMPT,
        activeToolManifest: [],
      });
      assert.equal(first.passthroughReason, undefined, `${mode}: first assembly must rewrite Pi's prompt`);
      assertBefore(first.systemPrompt, COLLABORATION_HEADING, TOOL_USE_HEADING, `${mode} fresh prompt`);
      assertBefore(first.systemPrompt, RESPONSE_STYLE_HEADING, TOOL_USE_HEADING, `${mode} fresh prompt`);
      assertBefore(first.systemPrompt, "Current date:", "Current working directory:", `${mode} fresh prompt`);
      assertBefore(first.systemPrompt, TOOL_USE_HEADING, "Current date:", `${mode} fresh prompt`);

      const second = assembleActiveSurface({
        state: createState(mode),
        baseSystemPrompt: first.systemPrompt,
        activeToolManifest: [],
      });
      assert.equal(second.systemPrompt, first.systemPrompt, `${mode}: style-before-tools prompt must re-assemble byte-stably`);
      assert.equal(second.passthroughReason, undefined, `${mode}: re-assembly must remain a real rewrite`);
      assert.equal(second.systemPrompt.split(COLLABORATION_HEADING).length - 1, 1, `${mode}: collaboration heading must not duplicate`);
      assert.equal(second.systemPrompt.split(RESPONSE_STYLE_HEADING).length - 1, 1, `${mode}: response style heading must not duplicate`);
      assert.equal(second.systemPrompt.split(TOOL_USE_HEADING).length - 1, 1, `${mode}: tool-use heading must not duplicate`);
    });
  }

  for (const mode of PROMPTED_MODES) {
    it(`re-assembling a ${mode} prompt is byte-stable and still a real rewrite`, () => {
      const s1 = assembleActiveSurface({
        state: createState(mode),
        baseSystemPrompt: BASE_PROMPT,
        activeToolManifest: [],
      });
      // First assembly must itself be a rewrite, not a passthrough — otherwise
      // the idempotence assertion below is vacuous.
      assert.equal(
        s1.passthroughReason,
        undefined,
        `${mode}: first assembly must rewrite Pi's prompt, not pass through`,
      );

      const s2 = assembleActiveSurface({
        state: createState(mode),
        baseSystemPrompt: s1.systemPrompt,
        activeToolManifest: [],
      });
      assert.equal(
        s2.systemPrompt,
        s1.systemPrompt,
        `${mode}: re-assembly must strip the prior MMR tail and reproduce the same bytes`,
      );
      assert.equal(
        s2.passthroughReason,
        undefined,
        `${mode}: re-assembly must remain a real rewrite (forward/backward tail in sync)`,
      );
    });
  }

  it("re-assembling a deep prompt as a smart Task base carries the smart tail exactly once", () => {
    const deep = assembleActiveSurface({
      state: createState("deep"),
      baseSystemPrompt: BASE_PROMPT,
      activeToolManifest: [],
    });
    assert.equal(deep.passthroughReason, undefined, "deep assembly must rewrite Pi's prompt");
    assert.ok(
      deep.systemPrompt.includes(DEEP_POSTURE_HEADING),
      "deep assembly must contain the deep posture heading",
    );

    const smartFromDeep = assembleActiveSurface({
      state: createState("smart"),
      baseSystemPrompt: deep.systemPrompt,
      activeToolManifest: [],
    });
    assert.equal(
      smartFromDeep.passthroughReason,
      undefined,
      "re-assembling a deep parent as smart must be a real rewrite, not passthrough",
    );

    const sp = smartFromDeep.systemPrompt;
    assert.equal(
      sp.split(SMART_INVESTIGATE_HEADING).length - 1,
      1,
      "smart-family investigate heading must appear exactly once after cross-mode re-assembly",
    );
    assert.equal(
      sp.split(SMART_CLOSING_LINE).length - 1,
      1,
      "smart closing line must appear exactly once after cross-mode re-assembly",
    );
    assert.equal(
      sp.includes(DEEP_POSTURE_HEADING),
      false,
      "the deep posture heading must be stripped when re-assembling as smart",
    );
  });
});
