import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const PROMPTED_MODES = ["smart", "smartGPT", "rush", "large", "deep"];
const EXPECTED_SEQUENCE = [
  "identity",
  "autonomy",
  "discovery-discipline",
  "pragmatism",
  "verification",
  "careful-actions",
  "mode-posture",
  "collaboration",
  "response-style",
  "tool-lead-in",
  "active-tools",
  "active-guidelines",
  "builtin-tool-guidance",
  "using-workers",
  "pi-docs",
  "shared-tool-guidance",
  "diagrams",
  "file-links",
  "preserved-tail",
];

// Deep reorders the body to the authoritative deep-template sequence and is
// the only mode that renders the deep-only engineering-judgment fragment.
const EXPECTED_DEEP_SEQUENCE = [
  "identity",
  "autonomy",
  "pragmatism",
  "discovery-discipline",
  "engineering-judgment",
  "verification",
  "careful-actions",
  "mode-posture",
  "collaboration",
  "response-style",
  "tool-lead-in",
  "active-tools",
  "active-guidelines",
  "builtin-tool-guidance",
  "using-workers",
  "pi-docs",
  "shared-tool-guidance",
  "diagrams",
  "file-links",
  "preserved-tail",
];

// Shared coding guidance is split into named fragments so each mode recipe can
// include only the sections it needs. Rush drops the diagrams fragment.
const EXPECTED_RUSH_SEQUENCE = EXPECTED_SEQUENCE.filter((id) => id !== "diagrams");

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
      const expectedFragments = mode === "rush"
        ? EXPECTED_RUSH_SEQUENCE
        : mode === "deep"
          ? EXPECTED_DEEP_SEQUENCE
          : MMR_DEFAULT_PROMPT_FRAGMENT_SEQUENCE;
      assert.deepEqual(recipe.fragments, expectedFragments, `${mode}: expected fragment sequence`);
      assert.equal(recipe.tag, mode);
      assert.equal(typeof recipe.intro, "string");
      assert.ok(recipe.intro.length > 20, `${mode}: intro must be substantive`);
      assert.equal(typeof recipe.postureSections, "string");
      if (mode === "rush" || mode === "deep") {
        assert.ok(recipe.postureSections.length > 100, `${mode}: postureSections must be substantive`);
      } else {
        assert.equal(recipe.postureSections, "", `${mode}: smart-family modes render no posture section`);
      }
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
      for (const required of ["active-tools", "active-guidelines", "pi-docs", "response-style"]) {
        assert.ok(fragments.includes(required), `${mode}: must include required fragment ${required}`);
      }
    }
  });

  it("lets mode recipes specialize the shared fragment sequence", () => {
    const { MMR_MODE_PROMPT_RECIPES, MMR_RUSH_PROMPT_FRAGMENT_SEQUENCE, MMR_DEFAULT_PROMPT_FRAGMENT_SEQUENCE, MMR_DEEP_PROMPT_FRAGMENT_SEQUENCE } = registry;
    assert.equal(MMR_RUSH_PROMPT_FRAGMENT_SEQUENCE.includes("diagrams"), false, "rush sequence must omit diagrams");
    assert.deepEqual(
      MMR_RUSH_PROMPT_FRAGMENT_SEQUENCE,
      MMR_DEFAULT_PROMPT_FRAGMENT_SEQUENCE.filter((id) => id !== "diagrams"),
      "rush must keep every default fragment except diagrams",
    );
    assert.deepEqual(MMR_MODE_PROMPT_RECIPES.rush.fragments, MMR_RUSH_PROMPT_FRAGMENT_SEQUENCE);
    assert.deepEqual(MMR_DEEP_PROMPT_FRAGMENT_SEQUENCE, EXPECTED_DEEP_SEQUENCE);
    assert.deepEqual(MMR_MODE_PROMPT_RECIPES.deep.fragments, MMR_DEEP_PROMPT_FRAGMENT_SEQUENCE);
    assert.equal(
      MMR_DEFAULT_PROMPT_FRAGMENT_SEQUENCE.includes("engineering-judgment"),
      false,
      "engineering-judgment is deep-only",
    );
    for (const mode of ["smart", "smartGPT", "large", "deep"]) {
      assert.equal(
        MMR_MODE_PROMPT_RECIPES[mode].fragments.includes("diagrams"),
        true,
        `${mode}: non-rush modes keep the diagrams fragment`,
      );
    }
  });

  it("keeps shared coding fragment ids, text map, and registry metadata aligned", async () => {
    const modules = await importSource("extensions/mmr-core/prompt-modules.ts");
    const { MMR_PROMPT_FRAGMENTS, MMR_DEFAULT_PROMPT_FRAGMENT_SEQUENCE } = registry;
    const codingIds = [
      "autonomy",
      "discovery-discipline",
      "pragmatism",
      "verification",
      "careful-actions",
      "diagrams",
      "file-links",
      "collaboration",
    ];
    // The canonical id tuple and the text-map keys match the expected coding
    // ids, in order — this is the single source of truth shared with the registry.
    assert.deepEqual([...modules.SHARED_CODING_GUIDANCE_FRAGMENT_IDS], codingIds);
    assert.deepEqual(Object.keys(modules.SHARED_CODING_GUIDANCE_FRAGMENTS), codingIds);
    // The default sequence intentionally splits coding guidance: task/risk
    // posture and user-collaboration style sit before tool guidance, while
    // diagrams/file-link style remains after the tool policy.
    for (const id of codingIds) {
      assert.notEqual(MMR_DEFAULT_PROMPT_FRAGMENT_SEQUENCE.indexOf(id), -1, `${id}: coding fragment must be present`);
    }
    assert.ok(
      MMR_DEFAULT_PROMPT_FRAGMENT_SEQUENCE.indexOf("careful-actions") <
        MMR_DEFAULT_PROMPT_FRAGMENT_SEQUENCE.indexOf("collaboration"),
      "task/risk posture must precede collaboration style",
    );
    assert.ok(
      MMR_DEFAULT_PROMPT_FRAGMENT_SEQUENCE.indexOf("collaboration") <
        MMR_DEFAULT_PROMPT_FRAGMENT_SEQUENCE.indexOf("tool-lead-in"),
      "collaboration style must precede tool guidance",
    );
    assert.ok(
      MMR_DEFAULT_PROMPT_FRAGMENT_SEQUENCE.indexOf("response-style") <
        MMR_DEFAULT_PROMPT_FRAGMENT_SEQUENCE.indexOf("tool-lead-in"),
      "response style must precede tool guidance",
    );
    assert.ok(
      MMR_DEFAULT_PROMPT_FRAGMENT_SEQUENCE.indexOf("tool-lead-in") <
        MMR_DEFAULT_PROMPT_FRAGMENT_SEQUENCE.indexOf("diagrams"),
      "diagrams/file-link style must follow tool guidance",
    );
    // Every registry entry keeps key === id === blockKind.
    for (const [key, def] of Object.entries(MMR_PROMPT_FRAGMENTS)) {
      assert.equal(def.id, key, `${key}: fragment id must equal its key`);
      assert.equal(def.blockKind, key, `${key}: blockKind must equal its key`);
    }
    // Each coding fragment text starts with its own Markdown heading.
    for (const id of codingIds) {
      assert.equal(typeof modules.SHARED_CODING_GUIDANCE_FRAGMENTS[id], "string");
      assert.ok(
        modules.SHARED_CODING_GUIDANCE_FRAGMENTS[id].startsWith("## "),
        `${id}: fragment text must start with a Markdown heading`,
      );
    }
    // The derived byte-reference equals the in-order join of the fragment texts.
    assert.equal(
      modules.SHARED_CODING_GUIDANCE,
      codingIds.map((id) => modules.SHARED_CODING_GUIDANCE_FRAGMENTS[id]).join("\n\n"),
    );
  });

  it("keeps the compatibility template export derived from recipes", () => {
    const { MMR_MODE_PROMPT_RECIPES, MMR_MODE_PROMPT_TEMPLATES } = registry;
    for (const mode of PROMPTED_MODES) {
      const { tag, intro, postureSections, closingLine } = MMR_MODE_PROMPT_RECIPES[mode];
      assert.deepEqual(MMR_MODE_PROMPT_TEMPLATES[mode], { tag, intro, postureSections, closingLine });
    }
  });
});
