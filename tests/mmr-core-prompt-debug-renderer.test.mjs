import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const FIXTURE_SYSTEM_PROMPT = [
  "You are an expert coding assistant operating inside pi, a coding agent harness. <mmr_mode name=\"smart\">You are pair programming with the user.</mmr_mode>",
  "",
  "## Tool use",
  "",
  "Use context first; reach for a tool only when it would change your answer.",
  "",
  "Available tools:",
  "- apply_patch: Apply a Codex-format patch to workspace files",
  "- web_search: Search the public web through the configured backend",
  "",
  "Guidelines:",
  "- Prefer apply_patch over hand-editing files when applying multi-hunk diffs.",
  "",
  "Pi documentation (read only when the user asks about pi itself).",
].join("\n");

function applyPatchManifestEntry() {
  return {
    name: "apply_patch",
    owner: "mmr-patch",
    description: "Apply a patch to one or more files using the Codex patch format.",
    promptSnippet: "Apply a Codex-format patch to workspace files",
    promptGuidelines: [
      "Prefer apply_patch when changing multiple regions in one file.",
      "Read the surrounding context before authoring hunks.",
    ],
    schema: {
      type: "object",
      properties: {
        patch: { type: "string", description: "Codex-format patch text." },
      },
      required: ["patch"],
    },
  };
}

function webSearchManifestEntry() {
  return {
    name: "web_search",
    owner: "mmr-web",
    description:
      "Search the public web through Brave Search for information relevant to a research objective.",
    promptSnippet: "Search the public web through Brave Search for a research objective",
    promptGuidelines: [
      "Use web_search only for public, non-sensitive research; do not include secrets in web_search.objective.",
    ],
    schema: {
      type: "object",
      properties: {
        objective: { type: "string", description: "Plain-language research objective." },
        max_results: { type: "number", description: "Soft cap on returned results." },
      },
      required: ["objective"],
    },
  };
}

function buildAssemblyResult(overrides = {}) {
  return {
    mode: "smart",
    provider: "claude-subscription",
    model: "claude-opus-4-8",
    blocks: [],
    systemPrompt: FIXTURE_SYSTEM_PROMPT,
    activeToolManifest: [applyPatchManifestEntry(), webSearchManifestEntry()],
    ...overrides,
  };
}

describe("mmr-core prompt debug renderer", () => {
  let renderMmrPromptDebugFixture;
  let stringifyMmrToolSchema;

  beforeEach(async () => {
    const mod = await importSource("extensions/mmr-core/prompt-debug-renderer.ts");
    renderMmrPromptDebugFixture = mod.renderMmrPromptDebugFixture;
    stringifyMmrToolSchema = mod.stringifyMmrToolSchema;
  });

  it("exports both renderer and schema stringifier", () => {
    assert.equal(typeof renderMmrPromptDebugFixture, "function");
    assert.equal(typeof stringifyMmrToolSchema, "function");
  });

  it("renders the System Messages and Tools sections in order", () => {
    const out = renderMmrPromptDebugFixture(buildAssemblyResult());

    const sysIdx = out.indexOf("=== System Messages ===");
    const toolsIdx = out.indexOf("=== Tools ===");
    assert.notEqual(sysIdx, -1, "expected System Messages header");
    assert.notEqual(toolsIdx, -1, "expected Tools header");
    assert.ok(sysIdx < toolsIdx, "System Messages must appear before Tools");
  });

  it("embeds the full system prompt verbatim under System Messages", () => {
    const out = renderMmrPromptDebugFixture(buildAssemblyResult());
    assert.ok(out.includes(FIXTURE_SYSTEM_PROMPT), "system prompt must appear verbatim");
  });

  it("renders each active tool with name, owner, snippet, guidelines, description, and schema", () => {
    const out = renderMmrPromptDebugFixture(buildAssemblyResult());

    // Tool name appears as a heading.
    assert.ok(out.includes("# apply_patch"), "expected apply_patch heading");
    assert.ok(out.includes("# web_search"), "expected web_search heading");

    // Owner is labeled.
    assert.ok(/Owner:\s*mmr-patch/.test(out), "expected apply_patch owner line");
    assert.ok(/Owner:\s*mmr-web/.test(out), "expected web_search owner line");

    // Prompt snippet is labeled and present.
    assert.ok(out.includes("Apply a Codex-format patch to workspace files"));
    assert.ok(out.includes("Search the public web through Brave Search for a research objective"));

    // Guidelines are rendered as bullets.
    assert.ok(out.includes("- Prefer apply_patch when changing multiple regions in one file."));
    assert.ok(out.includes("- Read the surrounding context before authoring hunks."));
    assert.ok(out.includes("- Use web_search only for public, non-sensitive research"));

    // Description.
    assert.ok(out.includes("Apply a patch to one or more files using the Codex patch format."));

    // Schema appears as a JSON code fence.
    assert.ok(out.includes("```json"), "expected schema JSON fence");
    assert.ok(out.includes("\"required\": ["), "expected parameter schema fields");
  });

  it("renders active tools in caller-provided manifest order", () => {
    const swapped = buildAssemblyResult({
      activeToolManifest: [webSearchManifestEntry(), applyPatchManifestEntry()],
    });
    const out = renderMmrPromptDebugFixture(swapped);

    const webIdx = out.indexOf("# web_search");
    const patchIdx = out.indexOf("# apply_patch");
    assert.ok(webIdx !== -1 && patchIdx !== -1);
    assert.ok(webIdx < patchIdx, "manifest order must determine output order");
  });

  it("omits an empty Tools section but keeps the header when no active tools", () => {
    const empty = buildAssemblyResult({ activeToolManifest: [] });
    const out = renderMmrPromptDebugFixture(empty);
    assert.ok(out.includes("=== Tools ==="), "Tools header still present");
    assert.equal(out.includes("# apply_patch"), false);
    assert.equal(out.includes("# web_search"), false);
  });

  it("omits optional fields when not provided", () => {
    const minimal = buildAssemblyResult({
      activeToolManifest: [
        {
          name: "minimal_tool",
          owner: "mmr-core",
          description: "A tool with no snippet and no guidelines.",
          promptGuidelines: [],
          schema: { type: "object", properties: {} },
        },
      ],
    });
    const out = renderMmrPromptDebugFixture(minimal);
    assert.ok(out.includes("# minimal_tool"));
    // No "Prompt snippet:" line when promptSnippet is absent.
    assert.equal(/Prompt snippet:/.test(out), false);
    // No "Prompt guidelines:" header when the list is empty.
    assert.equal(/Prompt guidelines:/.test(out), false);
  });

  it("does not mutate the caller's assembly result or its nested arrays", () => {
    const result = buildAssemblyResult();
    const beforeSystem = result.systemPrompt;
    const beforeBlocks = result.blocks.slice();
    const beforeManifestNames = result.activeToolManifest.map((entry) => entry.name);
    const beforeFirstGuidelines = result.activeToolManifest[0].promptGuidelines.slice();

    renderMmrPromptDebugFixture(result);

    assert.equal(result.systemPrompt, beforeSystem);
    assert.deepEqual(result.blocks, beforeBlocks);
    assert.deepEqual(
      result.activeToolManifest.map((entry) => entry.name),
      beforeManifestNames,
    );
    assert.deepEqual(result.activeToolManifest[0].promptGuidelines, beforeFirstGuidelines);
  });

  it("produces deterministic output for the same input", () => {
    const a = renderMmrPromptDebugFixture(buildAssemblyResult());
    const b = renderMmrPromptDebugFixture(buildAssemblyResult());
    assert.equal(a, b);
  });

  it("matches a snapshot for a representative active manifest", () => {
    const out = renderMmrPromptDebugFixture(buildAssemblyResult());
    const expected = [
      "=== System Messages ===",
      "",
      FIXTURE_SYSTEM_PROMPT,
      "",
      "=== Tools ===",
      "",
      "# apply_patch",
      "",
      "Owner: mmr-patch",
      "",
      "Prompt snippet: Apply a Codex-format patch to workspace files",
      "",
      "Prompt guidelines:",
      "- Prefer apply_patch when changing multiple regions in one file.",
      "- Read the surrounding context before authoring hunks.",
      "",
      "Description:",
      "Apply a patch to one or more files using the Codex patch format.",
      "",
      "Parameters:",
      "```json",
      "{",
      "  \"properties\": {",
      "    \"patch\": {",
      "      \"description\": \"Codex-format patch text.\",",
      "      \"type\": \"string\"",
      "    }",
      "  },",
      "  \"required\": [",
      "    \"patch\"",
      "  ],",
      "  \"type\": \"object\"",
      "}",
      "```",
      "",
      "# web_search",
      "",
      "Owner: mmr-web",
      "",
      "Prompt snippet: Search the public web through Brave Search for a research objective",
      "",
      "Prompt guidelines:",
      "- Use web_search only for public, non-sensitive research; do not include secrets in web_search.objective.",
      "",
      "Description:",
      "Search the public web through Brave Search for information relevant to a research objective.",
      "",
      "Parameters:",
      "```json",
      "{",
      "  \"properties\": {",
      "    \"max_results\": {",
      "      \"description\": \"Soft cap on returned results.\",",
      "      \"type\": \"number\"",
      "    },",
      "    \"objective\": {",
      "      \"description\": \"Plain-language research objective.\",",
      "      \"type\": \"string\"",
      "    }",
      "  },",
      "  \"required\": [",
      "    \"objective\"",
      "  ],",
      "  \"type\": \"object\"",
      "}",
      "```",
      "",
    ].join("\n");
    assert.equal(out, expected);
  });
});

describe("mmr-core stringifyMmrToolSchema", () => {
  let stringifyMmrToolSchema;

  beforeEach(async () => {
    const mod = await importSource("extensions/mmr-core/prompt-debug-renderer.ts");
    stringifyMmrToolSchema = mod.stringifyMmrToolSchema;
  });

  it("sorts object keys at every depth", () => {
    const out = stringifyMmrToolSchema({
      z: 1,
      a: { d: 4, c: { y: 2, x: 1 } },
      m: [{ b: 2, a: 1 }],
    });
    assert.equal(
      out,
      [
        "{",
        "  \"a\": {",
        "    \"c\": {",
        "      \"x\": 1,",
        "      \"y\": 2",
        "    },",
        "    \"d\": 4",
        "  },",
        "  \"m\": [",
        "    {",
        "      \"a\": 1,",
        "      \"b\": 2",
        "    }",
        "  ],",
        "  \"z\": 1",
        "}",
      ].join("\n"),
    );
  });

  it("produces identical output regardless of input key order", () => {
    const a = stringifyMmrToolSchema({ a: 1, b: 2, c: { x: 1, y: 2 } });
    const b = stringifyMmrToolSchema({ c: { y: 2, x: 1 }, b: 2, a: 1 });
    assert.equal(a, b);
  });

  it("preserves array element order", () => {
    const out = stringifyMmrToolSchema({ items: ["b", "a", "c"] });
    assert.equal(
      out,
      [
        "{",
        "  \"items\": [",
        "    \"b\",",
        "    \"a\",",
        "    \"c\"",
        "  ]",
        "}",
      ].join("\n"),
    );
  });

  it("renders null, booleans, and numbers literally", () => {
    const out = stringifyMmrToolSchema({ a: null, b: true, c: false, d: 1.5 });
    assert.equal(
      out,
      [
        "{",
        "  \"a\": null,",
        "  \"b\": true,",
        "  \"c\": false,",
        "  \"d\": 1.5",
        "}",
      ].join("\n"),
    );
  });

  it("renders empty objects and arrays compactly", () => {
    assert.equal(stringifyMmrToolSchema({}), "{}");
    assert.equal(stringifyMmrToolSchema([]), "[]");
  });
});
