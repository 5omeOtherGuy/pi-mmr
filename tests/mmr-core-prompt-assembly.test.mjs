// Phase D: assembleActiveSurface() contract.
//
// Drives the refactor that splits the splice into an ordered-block surface
// while preserving Pi auto-head fallback and free-mode passthrough. Pins:
//   - public API exposes assembleActiveSurface()
//   - the result is an MmrPromptAssemblyResult-shaped object (mode,
//     blocks[], systemPrompt, activeToolManifest)
//   - blocks[] has known kinds in known order for prompted modes
//   - flattened blocks[] reproduce the systemPrompt byte-for-byte
//   - systemPrompt matches the legacy buildMmrPromptLayer output
//     (consistency: same splice, different surface)
//   - the Pi Guidelines block is passed through byte-identically (Phase D
//     policy: never edit Pi-authored blocks)
//   - free mode is passthrough: blocks is a single preserved-tail block
//     and systemPrompt === base
//   - unrecognized base (no identity line) is passthrough

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const promptFixtureDir = path.join(import.meta.dirname, "fixtures/mmr-core-prompts");
const BASE_PROMPT = readFileSync(path.join(promptFixtureDir, "base.md"), "utf8");

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

describe("Phase D: assembleActiveSurface() public API", () => {
  let assembleActiveSurface;
  let buildMmrPromptLayer;

  beforeEach(async () => {
    const assembly = await importSource("extensions/mmr-core/prompt-assembly.ts");
    const prompt = await importSource("extensions/mmr-core/prompt.ts");
    assembleActiveSurface = assembly.assembleActiveSurface;
    buildMmrPromptLayer = prompt.buildMmrPromptLayer;
  });

  it("exports assembleActiveSurface as a function", () => {
    assert.equal(typeof assembleActiveSurface, "function");
  });

  for (const mode of PROMPTED_MODES) {
    it(`returns an MmrPromptAssemblyResult-shaped object for ${mode}`, () => {
      const result = assembleActiveSurface({
        state: createState(mode),
        baseSystemPrompt: BASE_PROMPT,
        activeToolManifest: [],
      });
      assert.equal(result.mode, mode);
      assert.ok(Array.isArray(result.blocks), "blocks must be an array");
      assert.ok(result.blocks.length > 0, "blocks must be non-empty for prompted modes");
      assert.equal(typeof result.systemPrompt, "string");
      assert.ok(Array.isArray(result.activeToolManifest));
    });

    it(`flattens blocks[] back to systemPrompt for ${mode}`, () => {
      const result = assembleActiveSurface({
        state: createState(mode),
        baseSystemPrompt: BASE_PROMPT,
        activeToolManifest: [],
      });
      const flattened = result.blocks.map((b) => b.text).join("");
      assert.equal(
        flattened,
        result.systemPrompt,
        `mode ${mode}: concatenated blocks must reproduce systemPrompt`,
      );
    });

    it(`assembleActiveSurface and buildMmrPromptLayer agree on systemPrompt for ${mode}`, () => {
      const state = createState(mode);
      const fromAssembly = assembleActiveSurface({
        state,
        baseSystemPrompt: BASE_PROMPT,
        activeToolManifest: [],
      }).systemPrompt;
      const fromLegacy = buildMmrPromptLayer({
        state,
        baseSystemPrompt: BASE_PROMPT,
      });
      assert.equal(
        fromAssembly,
        fromLegacy,
        `mode ${mode}: assembleActiveSurface().systemPrompt must equal buildMmrPromptLayer() output`,
      );
    });

    it(`emits rendered block kinds equal to the active recipe fragment list for ${mode}`, async () => {
      const { MMR_MODE_PROMPT_RECIPES } = await importSource("extensions/mmr-core/prompt-registry.ts");
      const result = assembleActiveSurface({
        state: createState(mode),
        baseSystemPrompt: BASE_PROMPT,
        activeToolManifest: [],
      });
      const kinds = result.blocks.map((b) => b.kind);
      assert.equal(kinds[0], "identity", `mode ${mode}: first block must be identity`);
      assert.equal(
        kinds[kinds.length - 1],
        "preserved-tail",
        `mode ${mode}: last block must be preserved-tail`,
      );
      // BASE_PROMPT carries Pi built-ins, so the optional builtin-tool-guidance
      // fragment is rendered. The rendered block kinds must therefore equal the
      // active recipe's fragment list exactly — this is what makes per-mode
      // fragment selection (e.g. rush dropping diagrams) observable. Smart-family
      // recipes declare mode-posture but render no block for their empty posture.
      const recipe = MMR_MODE_PROMPT_RECIPES[mode];
      const expectedKinds = recipe.fragments.filter(
        (fragmentId) => fragmentId !== "mode-posture" || recipe.postureSections !== "",
      );
      assert.deepEqual(
        kinds,
        expectedKinds,
        `mode ${mode}: rendered block kinds must equal the recipe fragment list`,
      );
    });

    it(`emits posture before tools and style before response for ${mode}`, () => {
      const result = assembleActiveSurface({
        state: createState(mode),
        baseSystemPrompt: BASE_PROMPT,
        activeToolManifest: [],
      });
      const kinds = result.blocks.map((b) => b.kind);
      // The shared coding guidance is split into named fragments. Every mode
      // keeps these always-present coding fragments; rush is the only mode that
      // drops `diagrams`, so it is asserted separately, not here.
      const alwaysPresentCodingKinds = [
        "autonomy",
        "discovery-discipline",
        "pragmatism",
        "verification",
        "careful-actions",
        "file-links",
        "collaboration",
      ];
      assert.equal(kinds.filter((k) => k === "shared-tool-guidance").length, 1);
      for (const codingKind of alwaysPresentCodingKinds) {
        assert.equal(
          kinds.filter((k) => k === codingKind).length,
          1,
          `mode ${mode}: coding fragment ${codingKind} must appear exactly once`,
        );
      }
      // Diagrams is the one mode-gated coding fragment: present once everywhere
      // except rush, which drops it.
      assert.equal(
        kinds.filter((k) => k === "diagrams").length,
        mode === "rush" ? 0 : 1,
        `mode ${mode}: diagrams fragment count`,
      );
      const autonomyIdx = kinds.indexOf("autonomy");
      const carefulActionsIdx = kinds.indexOf("careful-actions");
      const modePostureIdx = kinds.indexOf("mode-posture");
      const toolLeadInIdx = kinds.indexOf("tool-lead-in");
      const piDocsIdx = kinds.indexOf("pi-docs");
      const sharedToolIdx = kinds.indexOf("shared-tool-guidance");
      const fileLinksIdx = kinds.indexOf("file-links");
      const collaborationIdx = kinds.indexOf("collaboration");
      const responseStyleIdx = kinds.indexOf("response-style");
      assert.ok(autonomyIdx < carefulActionsIdx, `mode ${mode}: task/risk posture must stay in order`);
      // Only rush and deep render a mode posture; the smart family's empty
      // posture is skipped by the renderer.
      if (mode === "rush" || mode === "deep") {
        assert.ok(carefulActionsIdx < modePostureIdx, `mode ${mode}: shared posture must precede mode posture`);
        assert.ok(modePostureIdx < collaborationIdx, `mode ${mode}: mode posture must precede collaboration style`);
      } else {
        assert.equal(modePostureIdx, -1, `mode ${mode}: smart-family modes render no mode-posture block`);
        assert.ok(carefulActionsIdx < collaborationIdx, `mode ${mode}: shared posture must precede collaboration style`);
      }
      assert.ok(collaborationIdx < responseStyleIdx, `mode ${mode}: collaboration style must precede response style`);
      assert.ok(responseStyleIdx < toolLeadInIdx, `mode ${mode}: response style must precede tool guidance`);
      assert.ok(toolLeadInIdx < piDocsIdx, `mode ${mode}: Pi tool/docs blocks must stay in order`);
      assert.ok(piDocsIdx < sharedToolIdx, `mode ${mode}: Pi docs must precede shared tool execution policy`);
      assert.ok(sharedToolIdx < fileLinksIdx, `mode ${mode}: tool execution policy must precede remaining style guidance`);
      assert.match(result.blocks[sharedToolIdx].text, /## Tool execution policy/);
      assert.match(result.blocks[autonomyIdx].text, /## Autonomy and persistence/);
      assert.match(result.blocks[collaborationIdx].text, /## Working with the user/);
      assert.match(result.blocks[responseStyleIdx].text, /## Response style/);
    });

    it(`active-guidelines block is byte-identical to the Pi-authored Guidelines block for ${mode}`, () => {
      const result = assembleActiveSurface({
        state: createState(mode),
        baseSystemPrompt: BASE_PROMPT,
        activeToolManifest: [],
      });
      const guidelinesBlock = result.blocks.find((b) => b.kind === "active-guidelines");
      assert.ok(guidelinesBlock, `mode ${mode}: must have an active-guidelines block`);
      // Extract Pi's Guidelines section from the base prompt.
      const start = BASE_PROMPT.indexOf("\n\nGuidelines:\n");
      assert.notEqual(start, -1, "base.md must contain a Guidelines block");
      const headerStart = start + 2;
      const headerEnd = BASE_PROMPT.indexOf("\n\n", headerStart);
      const piGuidelines = BASE_PROMPT.slice(headerStart, headerEnd);
      assert.ok(
        guidelinesBlock.text.includes(piGuidelines),
        `mode ${mode}: active-guidelines block must include the full Pi Guidelines block verbatim`,
      );
      // Phase D drops the filter: previously-stripped bullets must now appear.
      assert.ok(
        guidelinesBlock.text.includes("- Be concise in your responses"),
        `mode ${mode}: Phase D must stop stripping the "Be concise" bullet`,
      );
      assert.ok(
        guidelinesBlock.text.includes("- Show file paths clearly when working with files"),
        `mode ${mode}: Phase D must stop stripping the "Show file paths" bullet`,
      );
    });
  }

  it("keeps planned-tool names and summaries out of shared guidance blocks", async () => {
    const { MMR_PLANNED_TOOL_CATALOG } = await importSource("extensions/mmr-core/planned-catalog.ts");
    for (const mode of PROMPTED_MODES) {
      const result = assembleActiveSurface({
        state: createState(mode),
        baseSystemPrompt: BASE_PROMPT,
        activeToolManifest: [],
      });
      const sharedGuidanceKinds = new Set([
        "shared-tool-guidance",
        "autonomy",
        "discovery-discipline",
        "pragmatism",
        "verification",
        "careful-actions",
        "diagrams",
        "file-links",
        "collaboration",
      ]);
      const sharedBlocks = result.blocks.filter((b) => sharedGuidanceKinds.has(b.kind));
      // 1 tool-guidance block + 8 coding fragments, minus diagrams for rush.
      assert.equal(sharedBlocks.length, mode === "rush" ? 8 : 9, `${mode}: must emit all shared guidance blocks`);
      const sharedText = sharedBlocks.map((b) => b.text).join("\n");
      for (const entry of MMR_PLANNED_TOOL_CATALOG) {
        const namePattern = new RegExp(`\\b${entry.name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`);
        assert.equal(
          namePattern.test(sharedText),
          false,
          `${mode}: planned tool ${entry.name} must not appear in shared guidance`,
        );
        assert.equal(
          sharedText.includes(entry.summary),
          false,
          `${mode}: planned summary for ${entry.name} must not appear in shared guidance`,
        );
      }
    }
  });

  it("free mode is a passthrough: blocks is a single preserved-tail and systemPrompt === base", () => {
    const result = assembleActiveSurface({
      state: createState("free"),
      baseSystemPrompt: BASE_PROMPT,
      activeToolManifest: [],
    });
    assert.equal(result.mode, "free");
    assert.equal(result.systemPrompt, BASE_PROMPT);
    assert.equal(result.blocks.length, 1, "free mode must emit a single passthrough block");
    assert.equal(result.blocks[0].kind, "preserved-tail");
    assert.equal(result.blocks[0].text, BASE_PROMPT);
  });

  it("unrecognized base (no identity line) falls back to passthrough", () => {
    const weirdBase = "Custom system prompt with no identity line.\n";
    const result = assembleActiveSurface({
      state: createState("smart"),
      baseSystemPrompt: weirdBase,
      activeToolManifest: [],
    });
    assert.equal(result.systemPrompt, weirdBase);
    assert.equal(result.blocks.length, 1);
    assert.equal(result.blocks[0].kind, "preserved-tail");
  });

  it("forwards provider and model when caller supplies them", () => {
    const result = assembleActiveSurface({
      state: createState("smart"),
      baseSystemPrompt: BASE_PROMPT,
      activeToolManifest: [],
      provider: "claude-subscription",
      model: "claude-opus-4-8",
    });
    assert.equal(result.provider, "claude-subscription");
    assert.equal(result.model, "claude-opus-4-8");
  });

  it("forwards activeToolManifest through unchanged", () => {
    const manifest = [
      {
        name: "web_search",
        owner: "mmr-web",
        promptGuidelines: ["Use web_search..."],
        description: "Search the web...",
        schema: { type: "object" },
      },
    ];
    const result = assembleActiveSurface({
      state: createState("smart"),
      baseSystemPrompt: BASE_PROMPT,
      activeToolManifest: manifest,
    });
    assert.deepEqual(result.activeToolManifest, manifest);
  });
});

describe("assembleActiveSurface(): built-in guidance source (activeToolNames)", () => {
  let assembleActiveSurface;

  beforeEach(async () => {
    const assembly = await importSource("extensions/mmr-core/prompt-assembly.ts");
    assembleActiveSurface = assembly.assembleActiveSurface;
  });

  function guidanceTools(systemPrompt) {
    const start = systemPrompt.indexOf("## Built-in tool guidance");
    if (start === -1) return [];
    const end = systemPrompt.indexOf("\n## ", start + 1);
    const block = systemPrompt.slice(start, end === -1 ? undefined : end);
    return [...block.matchAll(/^([a-z]+):$/gm)].map((m) => m[1]);
  }

  it("follows activeToolNames instead of the rendered tools block when provided", () => {
    // BASE_PROMPT's Available tools block lists all six curated built-ins,
    // but the resolved active set here omits grep/find.
    const result = assembleActiveSurface({
      state: createState("smart"),
      baseSystemPrompt: BASE_PROMPT,
      activeToolManifest: [],
      activeToolNames: ["read", "bash", "edit", "write"],
    });
    assert.deepEqual(guidanceTools(result.systemPrompt), ["bash", "read", "edit", "write"]);
  });

  it("covers a callable built-in even when it is absent from the rendered tools block", () => {
    // Strip grep from the rendered Available tools block; selectedTools still
    // marks it callable, so guidance must still include it.
    const baseWithoutGrep = BASE_PROMPT.replace(
      "- grep: Search file contents for patterns (respects .gitignore)\n",
      "",
    );
    assert.ok(!baseWithoutGrep.includes("- grep:"));
    const result = assembleActiveSurface({
      state: createState("smart"),
      baseSystemPrompt: baseWithoutGrep,
      activeToolManifest: [],
      activeToolNames: ["read", "grep"],
    });
    assert.deepEqual(guidanceTools(result.systemPrompt), ["read", "grep"]);
  });

  it("ignores non-built-in names in activeToolNames", () => {
    const result = assembleActiveSurface({
      state: createState("smart"),
      baseSystemPrompt: BASE_PROMPT,
      activeToolManifest: [],
      activeToolNames: ["read", "finder", "task_list", "web_search"],
    });
    assert.deepEqual(guidanceTools(result.systemPrompt), ["read"]);
  });

  it("suppresses the guidance block for an empty activeToolNames set", () => {
    const result = assembleActiveSurface({
      state: createState("smart"),
      baseSystemPrompt: BASE_PROMPT,
      activeToolManifest: [],
      activeToolNames: [],
    });
    assert.equal(result.blocks.some((b) => b.kind === "builtin-tool-guidance"), false);
    assert.equal(result.systemPrompt.includes("## Built-in tool guidance"), false);
  });

  it("falls back to the rendered tools block when activeToolNames is omitted", () => {
    const result = assembleActiveSurface({
      state: createState("smart"),
      baseSystemPrompt: BASE_PROMPT,
      activeToolManifest: [],
    });
    assert.deepEqual(guidanceTools(result.systemPrompt), [
      "bash",
      "read",
      "edit",
      "write",
      "grep",
      "find",
    ]);
  });
});

describe("assembleActiveSurface(): preserves Pi's tools interstitial byte-for-byte", () => {
  let assembleActiveSurface;

  beforeEach(async () => {
    const assembly = await importSource("extensions/mmr-core/prompt-assembly.ts");
    assembleActiveSurface = assembly.assembleActiveSurface;
  });

  it("emits Pi's own 'In addition to the tools above' sentence, not a local constant", () => {
    // Pi could change the interstitial sentence; the splice must pass it
    // through verbatim rather than reconstruct it from MMR_ADDITIONAL_TOOLS_LINE.
    const sentinel = "In addition to the tools above, SENTINEL custom interstitial text.";
    const base = BASE_PROMPT.replace(
      "In addition to the tools above, you may have access to other custom tools depending on the project.",
      sentinel,
    );
    assert.ok(base.includes(sentinel));
    const result = assembleActiveSurface({
      state: createState("smart"),
      baseSystemPrompt: base,
      activeToolManifest: [],
    });
    assert.ok(
      result.systemPrompt.includes(sentinel),
      "the splice must preserve Pi's actual interstitial sentence",
    );
    assert.ok(
      !result.systemPrompt.includes("you may have access to other custom tools depending on the project."),
      "the splice must not re-emit the default MMR_ADDITIONAL_TOOLS_LINE when Pi's text differs",
    );
    // The active-tools block stays Pi-sourced and still ends with a blank line
    // before the Guidelines block.
    assert.match(result.systemPrompt, new RegExp(`${sentinel.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\n\\nGuidelines:\\n`));
  });
});
