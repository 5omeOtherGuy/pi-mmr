import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const PROMPTED_MODES = ["smart", "smartGPT", "rush", "large", "deep"];
const EXPECTED_SEQUENCE = [
  "identity",
  "tool-lead-in",
  "active-tools",
  "active-guidelines",
  "builtin-tool-guidance",
  "pi-docs",
  "shared-tool-guidance",
  "shared-coding-guidance",
  "mode-posture",
  "response-style",
  "sunken-rite",
  "preserved-tail",
];

describe("mmr-core prompt registry", () => {
  let registry;

  beforeEach(async () => {
    registry = await importSource("extensions/mmr-core/prompt-registry.ts");
  });

  it("maps the system prompt into a Pi-native base plus ordered fragments", () => {
    const { MMR_PROMPT_BASES, MMR_PROMPT_FRAGMENTS, MMR_DEFAULT_PROMPT_FRAGMENT_SEQUENCE } = registry;

    assert.ok(MMR_PROMPT_BASES["pi-native-default-v1"], "Pi-native base prompt must be registered");
    const piNativeBase = MMR_PROMPT_BASES["pi-native-default-v1"];
    assert.equal(
      piNativeBase.identityLine,
      "You are an expert coding assistant operating inside pi, a coding agent harness.",
    );
    assert.equal(piNativeBase.toolsSectionAnchor, "\n\nAvailable tools:\n");
    assert.equal(piNativeBase.guidelinesSectionAnchor, "\n\nGuidelines:\n");
    assert.equal(piNativeBase.piDocsSectionAnchor, "\n\nPi documentation (");
    assert.equal(piNativeBase.dateTailAnchor, "\nCurrent date:");

    assert.deepEqual(MMR_DEFAULT_PROMPT_FRAGMENT_SEQUENCE, EXPECTED_SEQUENCE);
    for (const fragmentId of EXPECTED_SEQUENCE) {
      assert.ok(MMR_PROMPT_FRAGMENTS[fragmentId], `${fragmentId}: fragment metadata must exist`);
    }
  });

  it("marks Pi-owned prompt sections as Pi-native fragments", () => {
    const { MMR_PROMPT_FRAGMENTS } = registry;
    for (const fragmentId of ["active-tools", "active-guidelines", "pi-docs", "preserved-tail"]) {
      assert.equal(MMR_PROMPT_FRAGMENTS[fragmentId].source, "pi", `${fragmentId}: source`);
      assert.equal(MMR_PROMPT_FRAGMENTS[fragmentId].piNative, true, `${fragmentId}: piNative`);
    }
  });

  it("registers one mode recipe per prompted locked mode", () => {
    const { MMR_DEFAULT_PROMPT_FRAGMENT_SEQUENCE, MMR_MODE_PROMPT_RECIPES } = registry;

    assert.deepEqual(Object.keys(MMR_MODE_PROMPT_RECIPES).sort(), [...PROMPTED_MODES].sort());
    assert.equal("free" in MMR_MODE_PROMPT_RECIPES, false, "free mode must not have a prompt recipe");

    for (const mode of PROMPTED_MODES) {
      const recipe = MMR_MODE_PROMPT_RECIPES[mode];
      assert.equal(recipe.mode, mode);
      assert.equal(recipe.basePromptId, "pi-native-default-v1");
      assert.deepEqual(recipe.fragments, MMR_DEFAULT_PROMPT_FRAGMENT_SEQUENCE, `${mode}: canonical fragment sequence`);
      assert.equal(recipe.tag, mode);
      assert.equal(typeof recipe.intro, "string");
      assert.ok(recipe.intro.length > 20, `${mode}: intro must be substantive`);
      assert.equal(typeof recipe.postureSections, "string");
      assert.ok(recipe.postureSections.length > 100, `${mode}: postureSections must be substantive`);
      assert.equal(typeof recipe.closingLine, "string");
      assert.ok(recipe.closingLine.length > 10, `${mode}: closingLine must be substantive`);
    }
  });

  it("keeps every mode recipe structurally valid for reassembly", () => {
    const { MMR_MODE_PROMPT_RECIPES, MMR_PROMPT_FRAGMENTS } = registry;
    for (const mode of PROMPTED_MODES) {
      const fragments = MMR_MODE_PROMPT_RECIPES[mode].fragments;
      assert.ok(fragments.length > 0, `${mode}: fragments must not be empty`);
      assert.equal(fragments[0], "identity", `${mode}: identity must be first`);
      assert.equal(fragments.at(-1), "preserved-tail", `${mode}: preserved-tail must be last`);
      assert.equal(new Set(fragments).size, fragments.length, `${mode}: fragments must not duplicate ids`);
      for (const fragmentId of fragments) {
        assert.ok(MMR_PROMPT_FRAGMENTS[fragmentId], `${mode}: unknown fragment ${fragmentId}`);
      }
      for (const required of ["active-tools", "active-guidelines", "pi-docs", "sunken-rite"]) {
        assert.ok(fragments.includes(required), `${mode}: must include required fragment ${required}`);
      }
    }
  });

  it("keeps the compatibility template export derived from recipes", () => {
    const { MMR_MODE_PROMPT_RECIPES, MMR_MODE_PROMPT_TEMPLATES } = registry;
    for (const mode of PROMPTED_MODES) {
      const { tag, intro, postureSections, closingLine } = MMR_MODE_PROMPT_RECIPES[mode];
      assert.deepEqual(MMR_MODE_PROMPT_TEMPLATES[mode], { tag, intro, postureSections, closingLine });
    }
  });
});
