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

const PROMPTED_MODES = ["smart", "smartGPT", "rush", "large", "deep"];

// Unique posture heading per mode. `smart` and `smartGPT` share the SMART
// posture, so its heading is not a unique discriminator between those two; the
// cross-mode test pairs deep -> smart, whose posture headings are distinct.
const SMART_POSTURE_HEADING = "## Smart mode";
const DEEP_POSTURE_HEADING = "## Deep mode";
const SMART_CLOSING_LINE =
  "Answer in fewer than 4 lines of prose unless asked for more detail, or unless a complete report needs more space.";

describe("assembleActiveSurface() prompt-tail drift hardening", () => {
  let assembleActiveSurface;

  beforeEach(async () => {
    const assembly = await importSource("extensions/mmr-core/prompt-assembly.ts");
    assembleActiveSurface = assembly.assembleActiveSurface;
  });

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
      sp.split(SMART_POSTURE_HEADING).length - 1,
      1,
      "smart posture heading must appear exactly once after cross-mode re-assembly",
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
