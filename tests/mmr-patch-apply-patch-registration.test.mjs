import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);


// Required cues for the model-visible `apply_patch` tool description. Each
// entry names the guidance the description must carry; the test
// iterates the table so adding/removing a cue is a one-line change instead of
// editing many ad-hoc assert.match calls. The label describes *why* the cue
// matters, so a regression failure is self-explanatory.
const APPLY_PATCH_DESCRIPTION_CUES = [
  { label: "identifies the Codex patch format", pattern: /Codex patch format/ },
  { label: "shows the *** Begin Patch sentinel", pattern: /\*\*\* Begin Patch/ },
  // Path-safety description must match the implemented behavior:
  // absolute paths inside the workspace are allowed.
  { label: "allows absolute paths inside the workspace", pattern: /absolute path[^\n]*inside[^\n]*workspace|relative[^\n]*absolute paths[^\n]*inside/i },
  { label: "teaches consecutive @@ scope narrowing", pattern: /consecutive `?@@`?|narrow/i },
  { label: "includes the formal grammar block", pattern: /Patch\s*:=\s*Begin\s*\{\s*FileOp\s*\}\s*End/ },
  { label: "teaches 5-10 lines of context for repetitive/large files", pattern: /5-10 lines/ },
  { label: "spells out multi-file capability", pattern: /Multiple files can be patched in a single call/ },
  { label: "warns against linter/formatter-only edits", pattern: /Don't use apply patch for edits that an available linter or formatter could do/ },
  { label: "warns against unanchored insert-only hunks", pattern: /avoid unanchored insert-only hunks/i },
  { label: "single-file preference cue", pattern: /Prefer apply_patch for single-file edits/i },
  // Worked examples must live in the description (embedded directly in the
  // tool schema, not just docs).
  { label: "example: simple update with context", pattern: /### Simple update with context/ },
  { label: "example: moving/renaming a file with changes", pattern: /### Moving\/renaming a file with changes/ },
  { label: "example: editing content within jj conflict markers", pattern: /### Editing content within jj conflict markers/ },
  { label: "example: delete a file", pattern: /### Delete a file/ },
  { label: "example: multiple @@ blocks", pattern: /### Use multiple @@ blocks/ },
  { label: "example: anchor a change at end of file", pattern: /### Anchor a change at end of file/ },
];

const APPLY_PATCH_DESCRIPTION_ANTI_CUES = [
  { label: "does NOT claim absolute paths are rejected", pattern: /absolute paths[^\n]*are rejected/i },
];

const APPLY_PATCH_PROMPT_GUIDELINE_CUES = [
  { label: "prefer apply_patch for single-file edits", pattern: /Prefer apply_patch for single-file edits/i },
  { label: "avoid Python/shell rewrites when apply_patch suffices", pattern: /Do not use Python or shell rewrites/i },
  { label: "read enough context, 5-10 lines for repetitive/large files", pattern: /5-10 lines/ },
  { label: "avoid unanchored insert-only hunks", pattern: /unanchored insert-only/i },
];

describe("mmr-patch apply_patch tool registration", () => {
  it("registers an apply_patch custom tool with the structured patchText schema", async () => {
    const toolbox = await importSource("extensions/mmr-patch/index.ts");
    const { pi } = createMockPi();
    toolbox.default(pi);

    const tool = pi.tools.get("apply_patch");
    assert.ok(tool, "apply_patch tool should be registered");
    assert.equal(tool.name, "apply_patch");
    assert.equal(typeof tool.execute, "function");
    assert.ok(tool.parameters, "apply_patch tool must declare a parameter schema");
    // TypeBox object schemas are also JSON Schemas.
    assert.equal(tool.parameters.type, "object");
    assert.deepEqual(Object.keys(tool.parameters.properties ?? {}), ["patchText"]);
    assert.deepEqual(tool.parameters.required, ["patchText"]);
    assert.equal(tool.parameters.additionalProperties, false);
  });

  it("embeds every required guidance cue in the model-visible description", async () => {
    const toolbox = await importSource("extensions/mmr-patch/index.ts");
    const { pi } = createMockPi();
    toolbox.default(pi);

    const tool = pi.tools.get("apply_patch");
    for (const cue of APPLY_PATCH_DESCRIPTION_CUES) {
      assert.match(tool.description, cue.pattern, `description missing cue: ${cue.label}`);
    }
    for (const cue of APPLY_PATCH_DESCRIPTION_ANTI_CUES) {
      assert.doesNotMatch(tool.description, cue.pattern, `description carries forbidden cue: ${cue.label}`);
    }
  });

  it("declares promptGuidelines that surface the high-signal cues", async () => {
    const toolbox = await importSource("extensions/mmr-patch/index.ts");
    const { pi } = createMockPi();
    toolbox.default(pi);

    const tool = pi.tools.get("apply_patch");
    assert.ok(Array.isArray(tool.promptGuidelines), "apply_patch must declare promptGuidelines for the system prompt");
    const guidelines = tool.promptGuidelines.join("\n");
    for (const cue of APPLY_PATCH_PROMPT_GUIDELINE_CUES) {
      assert.match(guidelines, cue.pattern, `guideline missing: ${cue.label}`);
    }
  });

  it("resolves logical tool names case-sensitively but tolerates surrounding whitespace symmetrically with registerAlias", async () => {
    // `registerAlias` trims the logical name on register; `resolve` must
    // do the same on lookup, otherwise a name like `"  apply_patch  "`
    // (e.g. surfaced from a config file or mode definition) registers
    // under one key and looks up under another, silently dropping the
    // capability.
    const { createMmrToolRegistry } = await importSource("extensions/mmr-core/tool-registry.ts");
    const registry = createMmrToolRegistry();
    const toolbox = await importSource("extensions/mmr-patch/index.ts");
    toolbox.registerMmrPatchProviders(registry);
    const padded = registry.resolve(["  apply_patch  "], ["apply_patch"]);
    assert.deepEqual(padded.activeTools, ["apply_patch"]);
    assert.equal(padded.decisions[0].status, "active");
  });

  it("only resolves logical names registered in the toolbox map (no prototype-chain leaks)", async () => {
    // The toolbox's logical->concrete table is consulted with arbitrary
    // strings coming from mode definitions. If it were a plain object,
    // logical names like 'constructor' or 'toString' would resolve to
    // inherited functions and the provider would falsely claim the
    // capability. Use Object.hasOwn / null-prototype lookups instead.
    const { createMmrToolRegistry } = await importSource("extensions/mmr-core/tool-registry.ts");
    const registry = createMmrToolRegistry();
    const toolbox = await importSource("extensions/mmr-patch/index.ts");
    toolbox.registerMmrPatchProviders(registry);
    // Real capability still resolves.
    const ok = registry.resolve(["apply_patch"], ["apply_patch"]);
    assert.deepEqual(ok.activeTools, ["apply_patch"]);
    // Inherited Object.prototype names must not resolve.
    for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      const decision = registry.resolve([name], [name]).decisions[0];
      assert.notEqual(
        decision.owner,
        "mmr-patch",
        `mmr-patch must not claim logical capability "${name}" via prototype chain`,
      );
    }
  });

  it("registers an MMR tool provider that resolves apply_patch to the toolbox tool", async () => {
    const { createMmrToolRegistry } = await importSource("extensions/mmr-core/tool-registry.ts");
    const registry = createMmrToolRegistry();

    const toolbox = await importSource("extensions/mmr-patch/index.ts");
    assert.equal(typeof toolbox.registerMmrPatchProviders, "function",
      "mmr-patch must expose registerMmrPatchProviders for explicit wiring");
    toolbox.registerMmrPatchProviders(registry);

    const resolved = registry.resolve(["apply_patch"], ["apply_patch"]);
    assert.deepEqual(resolved.activeTools, ["apply_patch"]);
    const decision = resolved.decisions[0];
    assert.equal(decision.status, "active");
    assert.deepEqual(decision.chosenTools, ["apply_patch"]);
    assert.equal(decision.owner, "mmr-patch");
  });

  it("deep mode resolves apply_patch to the concrete apply_patch tool, not edit + write", async () => {
    const { createMmrToolRegistry } = await importSource("extensions/mmr-core/tool-registry.ts");
    const { getMmrMode } = await importSource("extensions/mmr-core/modes.ts");
    const toolbox = await importSource("extensions/mmr-patch/index.ts");

    const registry = createMmrToolRegistry();
    toolbox.registerMmrPatchProviders(registry);

    const deepMode = getMmrMode("deep");
    const resolved = registry.resolve(deepMode.tools, ["bash", "edit", "write", "apply_patch"]);

    const applyPatchDecision = resolved.decisions.find((d) => d.requested === "apply_patch");
    assert.ok(applyPatchDecision, "apply_patch must be in deep mode tool decisions");
    assert.equal(applyPatchDecision.status, "active");
    assert.deepEqual(applyPatchDecision.chosenTools, ["apply_patch"]);
    assert.equal(applyPatchDecision.owner, "mmr-patch");
    assert.equal(resolved.activeTools.includes("apply_patch"), true);
  });
});
