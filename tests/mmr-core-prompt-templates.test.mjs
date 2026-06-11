import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

// Direct tests for the per-mode prompt template data. The full prompt
// rendering pipeline is exercised against fixtures in mmr-core-prompt; here we
// pin the structural invariants of MMR_MODE_PROMPT_TEMPLATES so accidental
// deletion or key drift fails loudly without requiring a fixture refresh.

const PROMPTED_MODES = ["smart", "smartGPT", "rush", "large", "deep"];

describe("mmr-core prompt templates - structural invariants", () => {
  it("exports exactly one template per prompted (non-free) locked mode", async () => {
    const { MMR_MODE_PROMPT_TEMPLATES } = await importSource("extensions/mmr-core/prompt-templates.ts");
    assert.deepEqual(Object.keys(MMR_MODE_PROMPT_TEMPLATES).sort(), [...PROMPTED_MODES].sort());
    assert.equal("free" in MMR_MODE_PROMPT_TEMPLATES, false, "free mode must not have a prompt template");
  });

  it("every template has a non-empty tag, intro, and closingLine; only rush and deep carry a posture", async () => {
    const { MMR_MODE_PROMPT_TEMPLATES } = await importSource("extensions/mmr-core/prompt-templates.ts");
    for (const mode of PROMPTED_MODES) {
      const template = MMR_MODE_PROMPT_TEMPLATES[mode];
      assert.ok(template, `${mode}: template must exist`);
      assert.equal(typeof template.tag, "string", `${mode}: tag is a string`);
      assert.ok(template.tag.length > 0, `${mode}: tag is non-empty`);
      assert.equal(typeof template.intro, "string");
      assert.ok(template.intro.length > 20, `${mode}: intro is non-trivial`);
      assert.equal(typeof template.postureSections, "string");
      assert.equal(typeof template.closingLine, "string");
      assert.ok(template.closingLine.length > 10, `${mode}: closingLine is non-trivial`);
    }
    // The smart family mirrors the authoritative default template, whose
    // framing lives entirely in the intro and body fragments — no posture.
    for (const mode of ["smart", "smartGPT", "large"]) {
      assert.equal(MMR_MODE_PROMPT_TEMPLATES[mode].postureSections, "", `${mode}: smart-family modes render no posture section`);
    }
    for (const mode of ["rush", "deep"]) {
      assert.ok(MMR_MODE_PROMPT_TEMPLATES[mode].postureSections.length > 100, `${mode}: postureSections is non-trivial`);
    }
  });

  it("tag matches the mode key for every template", async () => {
    const { MMR_MODE_PROMPT_TEMPLATES } = await importSource("extensions/mmr-core/prompt-templates.ts");
    for (const mode of PROMPTED_MODES) {
      assert.equal(MMR_MODE_PROMPT_TEMPLATES[mode].tag, mode, `${mode}: tag must equal the mode key`);
    }
  });

  it("shared prompt modules carry common tool/coding guidance", async () => {
    const { SHARED_CODING_GUIDANCE, SHARED_TOOL_GUIDANCE } = await importSource("extensions/mmr-core/prompt-modules.ts");
    assert.match(SHARED_TOOL_GUIDANCE, /## Tool execution policy/);
    assert.doesNotMatch(SHARED_TOOL_GUIDANCE, /Run independent read-only calls in parallel/);
    assert.match(SHARED_TOOL_GUIDANCE, /purpose-built worker fits the job/);
    assert.match(SHARED_TOOL_GUIDANCE, /direct tools for exact file, path, or symbol lookups and single-step actions/);
    assert.match(SHARED_CODING_GUIDANCE, /## Executing actions with care/);
    assert.match(SHARED_CODING_GUIDANCE, /Destructive: deleting files or branches/);
    assert.match(SHARED_CODING_GUIDANCE, /## Diagrams/);
    assert.match(SHARED_CODING_GUIDANCE, /No Mermaid/);
    assert.match(SHARED_CODING_GUIDANCE, /## File links/);
  });

  it("mode templates do not duplicate shared module-only guidance sections", async () => {
    const { MMR_MODE_PROMPT_TEMPLATES } = await importSource("extensions/mmr-core/prompt-templates.ts");
    for (const mode of PROMPTED_MODES) {
      const posture = MMR_MODE_PROMPT_TEMPLATES[mode].postureSections;
      assert.doesNotMatch(posture, /## Executing actions with care/, `${mode}: shared guardrail must live in prompt modules`);
      assert.doesNotMatch(posture, /## Diagrams/, `${mode}: diagram guidance must live in prompt modules`);
      assert.doesNotMatch(posture, /## File links/, `${mode}: file-link guidance must live in prompt modules`);
    }
  });

  it("mode-specific posture headings are present (rush/deep)", async () => {
    const { MMR_MODE_PROMPT_TEMPLATES } = await importSource("extensions/mmr-core/prompt-templates.ts");
    assert.match(MMR_MODE_PROMPT_TEMPLATES.rush.postureSections, /## Rush mode/);
    assert.match(MMR_MODE_PROMPT_TEMPLATES.rush.postureSections, /Discovery: minimum evidence/);
    assert.match(MMR_MODE_PROMPT_TEMPLATES.rush.postureSections, /Communication: outcome first/);
    assert.match(MMR_MODE_PROMPT_TEMPLATES.rush.postureSections, /no extended reasoning/);

    assert.match(MMR_MODE_PROMPT_TEMPLATES.deep.postureSections, /## Deep mode/);
    assert.match(MMR_MODE_PROMPT_TEMPLATES.deep.postureSections, /## Diagnostic gate/);
  });

  it("introductions identify the mode by name or role to avoid silent mis-routing", async () => {
    const { MMR_MODE_PROMPT_TEMPLATES } = await importSource("extensions/mmr-core/prompt-templates.ts");
    // Each intro must mention its mode or a unique role marker so a copy-paste
    // bug between entries fails loudly.
    assert.match(MMR_MODE_PROMPT_TEMPLATES.rush.intro, /fewest useful tool loops/i);
    assert.match(MMR_MODE_PROMPT_TEMPLATES.deep.intro, /Deep mode/i);
    // The smart family intentionally does not name itself (default framing);
    // verify it carries the pair-programming framing it's known for.
    assert.match(MMR_MODE_PROMPT_TEMPLATES.smart.intro, /pair programming/i);
  });

  it("smartGPT and large render the smart system prompt verbatim apart from the mode tag", async () => {
    const { MMR_MODE_PROMPT_TEMPLATES } = await importSource("extensions/mmr-core/prompt-templates.ts");
    for (const mode of ["smartGPT", "large"]) {
      assert.equal(MMR_MODE_PROMPT_TEMPLATES[mode].intro, MMR_MODE_PROMPT_TEMPLATES.smart.intro, `${mode}: intro matches smart`);
      assert.equal(MMR_MODE_PROMPT_TEMPLATES[mode].postureSections, MMR_MODE_PROMPT_TEMPLATES.smart.postureSections, `${mode}: posture matches smart`);
      assert.equal(MMR_MODE_PROMPT_TEMPLATES[mode].closingLine, MMR_MODE_PROMPT_TEMPLATES.smart.closingLine, `${mode}: closing matches smart`);
    }
  });

  it("closingLine differs between distinct framings (smart family shares one)", async () => {
    const { MMR_MODE_PROMPT_TEMPLATES } = await importSource("extensions/mmr-core/prompt-templates.ts");
    const closings = ["smart", "rush", "deep"].map((mode) => MMR_MODE_PROMPT_TEMPLATES[mode].closingLine);
    assert.equal(new Set(closings).size, closings.length, "smart, rush, and deep must define distinct closing lines");
  });

  it("postureSections never re-introduces a leading or trailing blank line that the renderer would double", async () => {
    const { MMR_MODE_PROMPT_TEMPLATES } = await importSource("extensions/mmr-core/prompt-templates.ts");
    for (const mode of PROMPTED_MODES) {
      const sections = MMR_MODE_PROMPT_TEMPLATES[mode].postureSections;
      assert.equal(sections.startsWith("\n"), false, `${mode}: postureSections must not start with a newline`);
      assert.equal(sections.endsWith("\n"), false, `${mode}: postureSections must not end with a newline`);
    }
  });
});
