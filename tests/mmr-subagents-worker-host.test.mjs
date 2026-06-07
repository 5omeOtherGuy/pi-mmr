// Regression proof for the PR 2 helper deduplication
// (src/extensions/mmr-subagents/worker-host.ts).
//
// `resolveWorkerCwd` and `buildWorkerToolManifest` were previously duplicated
// verbatim across the subagent tool modules. `buildWorkerToolManifest`
// controls the worker prompt tool manifest, so the plan gates its extraction
// on a focused regression test proving the produced manifest is BYTE-IDENTICAL
// before/after for representative Task and librarian inputs.
//
// This test embeds the pre-extraction implementation verbatim as a reference
// and asserts the extracted shared function returns output that is both
// deep-equal AND serialized-byte-equal (JSON.stringify, which also catches
// property insertion-order drift that deep equality cannot) to the reference
// across a matrix of inputs: the Task read-write set, the finder read-only
// set, the librarian GitHub read-only set, and edge cases (no host, empty
// tools, non-record entries, missing description, promptSnippet fallback,
// non-string guideline filtering, getAllTools throwing/non-array).
//
// These are pure, deterministic checks — no live provider/runner calls.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

const WORKER_HOST_MODULE = "extensions/mmr-subagents/worker-host.ts";
const JSON_MODULE = "extensions/mmr-core/internal/json.ts";

after(cleanupLoadedSource);

// Verbatim copy of the pre-extraction `buildWorkerToolManifest` body. If the
// shared implementation ever diverges from this reference, the matrix below
// fails — that is the byte-identical-output guarantee the plan requires.
function makeReference(isRecord) {
  return function buildWorkerToolManifest(pi, workerTools) {
    if (!pi || workerTools.length === 0) return [];
    const wanted = new Set(workerTools);
    let allTools = [];
    try {
      const tools = pi.getAllTools?.();
      if (Array.isArray(tools)) allTools = tools;
    } catch {
      allTools = [];
    }
    return allTools.flatMap((tool) => {
      if (!isRecord(tool) || typeof tool.name !== "string" || !wanted.has(tool.name)) return [];
      const promptGuidelines = Array.isArray(tool.promptGuidelines)
        ? tool.promptGuidelines.filter((entry) => typeof entry === "string")
        : [];
      const description = typeof tool.description === "string"
        ? tool.description
        : typeof tool.promptSnippet === "string"
          ? tool.promptSnippet
          : "";
      const promptSnippet = typeof tool.promptSnippet === "string" ? tool.promptSnippet : undefined;
      return [{
        name: tool.name,
        owner: "runtime",
        ...(promptSnippet !== undefined ? { promptSnippet } : {}),
        promptGuidelines,
        description,
        schema: tool.parameters ?? {},
      }];
    });
  };
}

// Representative `pi.getAllTools()` inventory covering every branch:
// full metadata, missing description (snippet fallback), missing both
// (empty description), non-record entry, nameless entry, and a tool not in
// any worker set.
function buildInventory() {
  return [
    {
      name: "read",
      description: "Read the contents of a file.",
      promptSnippet: "read snippet",
      promptGuidelines: ["Use read to inspect files.", 42, "Avoid tiny slices."],
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
    {
      name: "grep",
      promptSnippet: "grep snippet only",
      promptGuidelines: ["Use grep for exact matches."],
      parameters: { type: "object" },
    },
    { name: "find", promptGuidelines: "not-an-array", parameters: { type: "object" } },
    { name: "edit", description: "Edit a file.", parameters: { type: "object" } },
    { name: "write", description: "Write a file." },
    "this-entry-is-not-a-record",
    { description: "nameless tool is dropped" },
    { name: "bash", description: "Run a shell command." },
    { name: "unused", description: "Not requested by any worker set." },
    // Librarian worker tools are the read-only GitHub provider tools from the
    // `librarian` subagent profile, not generic code-search tools. Include
    // them with varied metadata so the librarian path exercises the same
    // branches: full desc+params, promptSnippet fallback, guideline filtering,
    // and a tool with no parameters (schema -> {}).
    {
      name: "read_github",
      description: "Read a file from a remote repository.",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
    {
      name: "list_directory_github",
      promptSnippet: "List a remote repository directory.",
      parameters: { type: "object" },
    },
    {
      name: "glob_github",
      description: "Glob remote repository paths.",
      promptGuidelines: ["Use glob_github for path patterns.", 7],
      parameters: { type: "object" },
    },
    { name: "search_github", description: "Search remote repository code.", parameters: { type: "object" } },
    { name: "commit_search", description: "Search commit history.", parameters: { type: "object" } },
    { name: "diff_github", description: "Diff two refs.", parameters: { type: "object" } },
    { name: "list_repositories", description: "List accessible repositories." },
  ];
}

// Worker tool sets mirroring the real read-only (finder/librarian-style) and
// read-write (Task-style) allowlists, plus ordering and unregistered-name
// cases. `buildWorkerToolManifest` preserves inventory order, not request
// order, so the reference and shared impl must agree regardless.
const WORKER_TOOL_SETS = [
  ["grep", "find", "read"], // finder-style read-only
  // Librarian GitHub read-only set (mirrors the `librarian` profile tools).
  [
    "read_github",
    "list_directory_github",
    "glob_github",
    "search_github",
    "commit_search",
    "diff_github",
    "list_repositories",
  ],
  ["read", "grep", "find", "bash", "edit", "write"], // Task read-write-style
  ["read", "missing-tool", "bash"], // includes an unregistered name (dropped)
  ["write"], // single tool, description-only (no snippet)
  ["find"], // promptGuidelines is a non-array -> []
  [], // empty worker set -> []
];

describe("worker-host buildWorkerToolManifest — byte-identical regression", () => {
  it("matches the pre-extraction reference across the input matrix", async () => {
    const { buildWorkerToolManifest } = await importSource(WORKER_HOST_MODULE);
    const { isRecord } = await importSource(JSON_MODULE);
    const reference = makeReference(isRecord);

    const hosts = [
      { label: "full inventory", pi: { getAllTools: () => buildInventory() } },
      { label: "no host", pi: undefined },
      { label: "host without getAllTools", pi: {} },
      { label: "getAllTools returns non-array", pi: { getAllTools: () => null } },
      {
        label: "getAllTools throws",
        pi: {
          getAllTools: () => {
            throw new Error("boom");
          },
        },
      },
    ];

    for (const { label, pi } of hosts) {
      for (const workerTools of WORKER_TOOL_SETS) {
        const actual = buildWorkerToolManifest(pi, workerTools);
        const expected = reference(pi, workerTools);
        const where = `host=${label} workerTools=${JSON.stringify(workerTools)}`;
        // Structural equality (strict via node:assert/strict).
        assert.deepStrictEqual(actual, expected, `manifest drift for ${where}`);
        // Serialized-byte equality also catches property insertion-order
        // differences that deep equality cannot — this is what backs the
        // "byte-identical" claim.
        assert.equal(
          JSON.stringify(actual),
          JSON.stringify(expected),
          `manifest byte drift for ${where}`,
        );
      }
    }
  });

  it("produces the expected manifest for a finder-style read-only set", async () => {
    const { buildWorkerToolManifest } = await importSource(WORKER_HOST_MODULE);
    const pi = { getAllTools: () => buildInventory() };
    const manifest = buildWorkerToolManifest(pi, ["grep", "find", "read"]);
    // Inventory order is preserved; non-string guideline entries are dropped;
    // missing description falls back to promptSnippet then "".
    assert.deepStrictEqual(manifest, [
      {
        name: "read",
        owner: "runtime",
        promptSnippet: "read snippet",
        promptGuidelines: ["Use read to inspect files.", "Avoid tiny slices."],
        description: "Read the contents of a file.",
        schema: { type: "object", properties: { path: { type: "string" } } },
      },
      {
        name: "grep",
        owner: "runtime",
        promptSnippet: "grep snippet only",
        promptGuidelines: ["Use grep for exact matches."],
        description: "grep snippet only",
        schema: { type: "object" },
      },
      {
        name: "find",
        owner: "runtime",
        promptGuidelines: [],
        description: "",
        schema: { type: "object" },
      },
    ]);
  });

  it("produces the expected manifest for the librarian GitHub read-only set", async () => {
    const { buildWorkerToolManifest } = await importSource(WORKER_HOST_MODULE);
    const pi = { getAllTools: () => buildInventory() };
    const manifest = buildWorkerToolManifest(pi, [
      "read_github",
      "list_directory_github",
      "glob_github",
      "search_github",
      "commit_search",
      "diff_github",
      "list_repositories",
    ]);
    // Inventory order is preserved; list_directory_github has no description
    // so it falls back to its promptSnippet; glob_github drops the non-string
    // guideline entry; list_repositories has no parameters so schema -> {}.
    assert.deepStrictEqual(manifest, [
      {
        name: "read_github",
        owner: "runtime",
        promptGuidelines: [],
        description: "Read a file from a remote repository.",
        schema: { type: "object", properties: { path: { type: "string" } } },
      },
      {
        name: "list_directory_github",
        owner: "runtime",
        promptSnippet: "List a remote repository directory.",
        promptGuidelines: [],
        description: "List a remote repository directory.",
        schema: { type: "object" },
      },
      {
        name: "glob_github",
        owner: "runtime",
        promptGuidelines: ["Use glob_github for path patterns."],
        description: "Glob remote repository paths.",
        schema: { type: "object" },
      },
      {
        name: "search_github",
        owner: "runtime",
        promptGuidelines: [],
        description: "Search remote repository code.",
        schema: { type: "object" },
      },
      {
        name: "commit_search",
        owner: "runtime",
        promptGuidelines: [],
        description: "Search commit history.",
        schema: { type: "object" },
      },
      {
        name: "diff_github",
        owner: "runtime",
        promptGuidelines: [],
        description: "Diff two refs.",
        schema: { type: "object" },
      },
      {
        name: "list_repositories",
        owner: "runtime",
        promptGuidelines: [],
        description: "List accessible repositories.",
        schema: {},
      },
    ]);
  });

  it("returns [] for empty worker tools and absent host", async () => {
    const { buildWorkerToolManifest } = await importSource(WORKER_HOST_MODULE);
    assert.deepStrictEqual(buildWorkerToolManifest({ getAllTools: () => buildInventory() }, []), []);
    assert.deepStrictEqual(buildWorkerToolManifest(undefined, ["read"]), []);
  });
});

describe("worker-host resolveWorkerCwd", () => {
  it("prefers a non-empty ctx.cwd and falls back to process.cwd()", async () => {
    const { resolveWorkerCwd } = await importSource(WORKER_HOST_MODULE);
    assert.equal(resolveWorkerCwd({ cwd: "/work/dir" }), "/work/dir");
    assert.equal(resolveWorkerCwd({ cwd: "" }), process.cwd());
    assert.equal(resolveWorkerCwd({ cwd: 123 }), process.cwd());
    assert.equal(resolveWorkerCwd(undefined), process.cwd());
    assert.equal(resolveWorkerCwd({}), process.cwd());
  });
});
