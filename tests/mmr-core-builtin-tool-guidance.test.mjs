// Built-in tool guidance: per-tool augmentation block inserted after Pi's
// auto-emitted Guidelines: block. The block is mmr-core-authored and active
// only for built-in tool names that actually appear in Pi's Available tools
// block — it never injects guidance for inactive or planned tools.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
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

describe("built-in tool guidance: module", () => {
  it("returns null when no covered built-in tool is active", async () => {
    const { buildBuiltinToolGuidance } = await importSource("extensions/mmr-core/builtin-tool-guidance.ts");
    assert.equal(buildBuiltinToolGuidance([]), null);
    assert.equal(buildBuiltinToolGuidance(["apply_patch", "task_list"]), null);
  });

  it("renders only the active built-in tools, in a stable order", async () => {
    const { buildBuiltinToolGuidance, MMR_BUILTIN_TOOL_GUIDANCE_HEADING } = await importSource(
      "extensions/mmr-core/builtin-tool-guidance.ts",
    );
    const block = buildBuiltinToolGuidance(["edit", "bash"]);
    assert.ok(block, "block must be rendered when bash and edit are active");
    assert.ok(block.startsWith(`${MMR_BUILTIN_TOOL_GUIDANCE_HEADING}\n\n`));
    // bash is declared before edit in the data; stable order means bash first.
    const bashIdx = block.indexOf("\nbash:\n");
    const editIdx = block.indexOf("\nedit:\n");
    assert.notEqual(bashIdx, -1);
    assert.notEqual(editIdx, -1);
    assert.ok(bashIdx < editIdx, "bash section must precede edit section");
    // No other tool sections leak in.
    assert.equal(block.includes("\nread:\n"), false);
    assert.equal(block.includes("\nwrite:\n"), false);
    assert.equal(block.includes("\ngrep:\n"), false);
    assert.equal(block.includes("\nfind:\n"), false);
  });

  it("uses Pi-native parameter names in edit/write guidance", async () => {
    const { buildBuiltinToolGuidance } = await importSource("extensions/mmr-core/builtin-tool-guidance.ts");
    const block = buildBuiltinToolGuidance(["edit", "write"]);
    assert.ok(block);
    // Pi edit uses edits[].oldText / edits[].newText, not old_str/new_str.
    assert.match(block, /edits\[\]\.oldText/);
    assert.match(block, /edits\[\]\.newText/);
    assert.equal(block.includes("old_str"), false, "non-Pi-native parameter old_str must not appear");
    assert.equal(block.includes("new_str"), false, "non-Pi-native parameter new_str must not appear");
    assert.equal(block.includes("replace_all"), false, "Pi edit has no replace_all parameter");
    // The cross-reference must be `edit`/`write`.
    assert.equal(block.includes("create_file"), false, "non-Pi-native tool name create_file must not appear");
    assert.equal(block.includes("edit_file"), false, "non-Pi-native tool name edit_file must not appear");
  });

  it("steers edit recovery away from identical retries", async () => {
    const { buildBuiltinToolGuidance } = await importSource("extensions/mmr-core/builtin-tool-guidance.ts");
    const block = buildBuiltinToolGuidance(["bash", "edit", "write"]);
    assert.ok(block);
    assert.match(block, /empty arguments or missing required fields/);
    assert.match(block, /do not retry the identical call/);
    assert.match(block, /Prefer write or bash heredoc for large, whole-file, or escape-dense replacements/);
  });

  it("warns that each edit item carries exactly oldText and newText with no extra keys", async () => {
    const { buildBuiltinToolGuidance } = await importSource("extensions/mmr-core/builtin-tool-guidance.ts");
    const block = buildBuiltinToolGuidance(["edit"]);
    assert.ok(block);
    // Positive shape: exactly two keys per item.
    assert.match(block, /exactly two keys/);
    // Negative examples for the annotation/suffix keys the model has emitted.
    assert.match(block, /newText_comment/);
    assert.match(block, /oldText2/);
    // The consequence must be stated so the model self-corrects instead of repeating.
    assert.match(block, /rejects unknown keys/);
    // Stay Pi-native: the canonical key names must still be the only real parameters named.
    assert.equal(block.includes("old_str"), false);
    assert.equal(block.includes("new_str"), false);
  });

  it("does not require absolute paths (Pi allows relative paths)", async () => {
    const { buildBuiltinToolGuidance } = await importSource("extensions/mmr-core/builtin-tool-guidance.ts");
    const block = buildBuiltinToolGuidance(["read", "write", "edit"]);
    assert.ok(block);
    assert.equal(block.includes("MUST be absolute"), false, "Pi tools allow relative paths");
    assert.equal(block.includes("must be absolute"), false, "Pi tools allow relative paths");
  });

  it("does not reference Pi-absent parameters (no cwd / read_range)", async () => {
    const { buildBuiltinToolGuidance } = await importSource("extensions/mmr-core/builtin-tool-guidance.ts");
    const block = buildBuiltinToolGuidance(["bash", "read"]);
    assert.ok(block);
    assert.equal(/`cwd`/.test(block), false, "Pi bash has no cwd parameter");
    assert.equal(block.includes("read_range"), false, "Pi read uses offset/limit, not read_range");
  });

  it("does not mention unrelated product names in rendered guidance", async () => {
    const { buildBuiltinToolGuidance } = await importSource("extensions/mmr-core/builtin-tool-guidance.ts");
    const block = buildBuiltinToolGuidance(["edit", "write", "read", "bash", "grep", "find"]);
    assert.ok(block);
    for (const term of [["A", "mp"].join(""), ["Source", "graph"].join("")]) {
      assert.equal(block.includes(term), false, `${term} must not appear`);
    }
  });

  it("does not leak planned-tool names into the rendered guidance", async () => {
    const { buildBuiltinToolGuidance } = await importSource("extensions/mmr-core/builtin-tool-guidance.ts");
    const { MMR_PLANNED_TOOL_CATALOG } = await importSource("extensions/mmr-core/planned-catalog.ts");
    const block = buildBuiltinToolGuidance(["read", "bash", "write", "edit", "grep", "find"]);
    assert.ok(block);
    for (const entry of MMR_PLANNED_TOOL_CATALOG) {
      const pattern = new RegExp(`\\b${entry.name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`);
      assert.equal(pattern.test(block), false, `planned tool ${entry.name} must not appear in built-in guidance`);
      assert.equal(block.includes(entry.summary), false, `planned summary for ${entry.name} must not appear`);
    }
  });

  it("extractActiveBuiltinToolNames picks built-in tool names from Pi's Available tools block", async () => {
    const { extractActiveBuiltinToolNames } = await importSource("extensions/mmr-core/builtin-tool-guidance.ts");
    const block = [
      "Available tools:",
      "- read: Read file contents",
      "- bash: Execute bash commands",
      "- edit: Make precise file edits",
      "- write: Create or overwrite files",
      "- grep: Search file contents",
      "- find: Find files",
      "- ls: List directory contents",
      "- apply_patch: Apply a Codex-format patch",
      "- task_list: Plan and track work",
    ].join("\n");
    assert.deepEqual(
      extractActiveBuiltinToolNames(block),
      ["read", "bash", "edit", "write", "grep", "find"],
    );
  });
});

describe("built-in tool guidance: prompt assembly integration", () => {
  it("inserts a builtin-tool-guidance block between active-guidelines and pi-docs when built-ins are active", async () => {
    const { assembleActiveSurface } = await importSource("extensions/mmr-core/prompt-assembly.ts");
    const result = assembleActiveSurface({
      state: createState("smart"),
      baseSystemPrompt: BASE_PROMPT,
      activeToolManifest: [],
    });
    const kinds = result.blocks.map((b) => b.kind);
    const guidelinesIdx = kinds.indexOf("active-guidelines");
    const builtinIdx = kinds.indexOf("builtin-tool-guidance");
    const piDocsIdx = kinds.indexOf("pi-docs");
    assert.notEqual(builtinIdx, -1, "builtin-tool-guidance block must be present");
    assert.equal(builtinIdx, guidelinesIdx + 1, "builtin-tool-guidance must immediately follow active-guidelines");
    assert.equal(piDocsIdx, builtinIdx + 1, "pi-docs must immediately follow builtin-tool-guidance");
  });

  it("flattened blocks still reproduce systemPrompt byte-for-byte", async () => {
    const { assembleActiveSurface } = await importSource("extensions/mmr-core/prompt-assembly.ts");
    const result = assembleActiveSurface({
      state: createState("smart"),
      baseSystemPrompt: BASE_PROMPT,
      activeToolManifest: [],
    });
    const flattened = result.blocks.map((b) => b.text).join("");
    assert.equal(flattened, result.systemPrompt);
  });

  it("renders the heading and per-tool sections for every active built-in", async () => {
    const { assembleActiveSurface } = await importSource("extensions/mmr-core/prompt-assembly.ts");
    const result = assembleActiveSurface({
      state: createState("smart"),
      baseSystemPrompt: BASE_PROMPT,
      activeToolManifest: [],
    });
    assert.match(result.systemPrompt, /## Built-in tool guidance/);
    for (const name of ["bash", "read", "edit", "write", "grep", "find"]) {
      const pattern = new RegExp(`^${name}:$`, "m");
      assert.match(result.systemPrompt, pattern);
    }
  });

  it("omits guidance for tools that are not listed in Pi's Available tools block", async () => {
    const { assembleActiveSurface } = await importSource("extensions/mmr-core/prompt-assembly.ts");
    const baseWithoutEdit = BASE_PROMPT.replace(
      "- edit: Make precise file edits with exact text replacement, including multiple disjoint edits in one call\n",
      "",
    );
    const result = assembleActiveSurface({
      state: createState("smart"),
      baseSystemPrompt: baseWithoutEdit,
      activeToolManifest: [],
    });
    const builtinBlock = result.blocks.find((b) => b.kind === "builtin-tool-guidance");
    assert.ok(builtinBlock, "block must still render for the remaining built-ins");
    assert.equal(/^edit:$/m.test(builtinBlock.text), false, "edit section must not appear when edit is not active");
    assert.match(builtinBlock.text, /^bash:$/m, "bash section must still appear");
  });

  it("emits no builtin-tool-guidance block when no covered built-in is active", async () => {
    const { assembleActiveSurface } = await importSource("extensions/mmr-core/prompt-assembly.ts");
    // Strip every covered built-in from the Available tools listing.
    let custom = BASE_PROMPT;
    for (const name of ["read", "bash", "edit", "write", "grep", "find"]) {
      const re = new RegExp(`- ${name}: [^\\n]*\\n`);
      custom = custom.replace(re, "");
    }
    const result = assembleActiveSurface({
      state: createState("smart"),
      baseSystemPrompt: custom,
      activeToolManifest: [],
    });
    const kinds = result.blocks.map((b) => b.kind);
    assert.equal(
      kinds.includes("builtin-tool-guidance"),
      false,
      "no block when no covered built-in tool is active",
    );
    assert.equal(/## Built-in tool guidance/.test(result.systemPrompt), false);
  });

  it("Pi-authored Available tools and Guidelines blocks remain byte-identical", async () => {
    const { assembleActiveSurface } = await importSource("extensions/mmr-core/prompt-assembly.ts");
    const result = assembleActiveSurface({
      state: createState("smart"),
      baseSystemPrompt: BASE_PROMPT,
      activeToolManifest: [],
    });
    for (const header of ["Available tools:", "Guidelines:"]) {
      const baseStart = BASE_PROMPT.indexOf(`\n\n${header}`) + 2;
      const baseEnd = BASE_PROMPT.indexOf("\n\n", baseStart);
      const piBody = BASE_PROMPT.slice(baseStart, baseEnd);
      assert.ok(
        result.systemPrompt.includes(piBody),
        `${header} block must remain byte-identical in the assembled prompt`,
      );
    }
  });
});
