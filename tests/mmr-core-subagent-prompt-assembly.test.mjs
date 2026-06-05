// Phase 2: assembleMmrSubagentSurface() contract.
//
// Pins the public-facing prompt-assembly surface for subagent profiles
// in mmr-core. Two prompt routes must be supported:
//
// 1. `standalone` (finder, oracle, librarian) — the profile owns the
//    entire system prompt. mmr-core resolves the profile's named prompt
//    builder through a registered builder registry, calls it with the
//    cwd (and, when supplied, the per-call modeState surface), and
//    returns:
//    - the resolved builder output as `systemPrompt`,
//    - a single `standalone-prompt` block carrying that same text,
//    - the active tool manifest filtered to the profile's tool
//      allowlist (deferred / gated / unavailable tools must already be
//      excluded by the caller; profile-disallowed entries that slip
//      through are still dropped by assembly).
//
// 2. `mode-derived` (Task) — the profile derives from a parent locked
//    mode (`baseMode`). mmr-core calls `assembleActiveSurface` with a
//    minimal mode state stamped for `baseMode`, then appends a
//    `subagent-worker-role` block produced by the profile's builder.
//    Subagent recursion (Task spawning Task) must be prevented by the
//    caller filtering the active tool manifest, but mmr-core must not
//    re-introduce subagent tools through the active-tools block.
//
// All routes must produce deterministic, byte-equal output between
// runs given identical inputs.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const ASSEMBLY_MODULE = "extensions/mmr-core/subagent-prompt-assembly.ts";
const PROFILES_MODULE = "extensions/mmr-core/subagent-profiles.ts";
const PROMPTS_MODULE = "extensions/mmr-subagents/prompts.ts";

const promptFixtureDir = path.join(import.meta.dirname, "fixtures/mmr-core-prompts");
const BASE_PROMPT = readFileSync(path.join(promptFixtureDir, "base.md"), "utf8");

function makeFinderProfile() {
  return Object.freeze({
    name: "finder",
    displayName: "Finder",
    modelPreferences: [{ model: "gpt-5.4-mini" }],
    thinkingLevel: "minimal",
    tools: Object.freeze(["grep", "find", "read"]),
    promptRoute: "standalone",
    promptBuilder: "finder",
    allowMcp: false,
    allowToolbox: false,
    enforceLockedMode: false,
    persistSubagentState: false,
  });
}

function makeTaskProfile() {
  return Object.freeze({
    name: "Task",
    displayName: "Task",
    modelPreferences: [{ model: "claude-opus-4-8" }],
    thinkingLevel: "high",
    // Task gets every smart-mode active tool except subagent surfaces.
    tools: Object.freeze(["read", "bash", "grep", "find"]),
    promptRoute: "mode-derived",
    baseMode: "smart",
    promptBuilder: "task",
    allowMcp: false,
    allowToolbox: false,
    enforceLockedMode: false,
    persistSubagentState: false,
  });
}

function makeParentDerivedProfile() {
  return Object.freeze({
    name: "parent-derived-fixture",
    displayName: "Parent Derived Fixture",
    modelPreferences: [{ model: "claude-opus-4-8" }],
    thinkingLevel: "high",
    tools: Object.freeze(["read"]),
    promptRoute: "mode-derived",
    baseMode: "from-parent",
    promptBuilder: "parent-derived-fixture",
    allowMcp: false,
    allowToolbox: false,
    enforceLockedMode: false,
    persistSubagentState: false,
  });
}

function makeFinderManifest() {
  return [
    {
      name: "grep",
      owner: "pi",
      promptGuidelines: [],
      description: "Search file contents for patterns",
      schema: { type: "object", properties: {} },
    },
    {
      name: "find",
      owner: "pi",
      promptGuidelines: [],
      description: "Find files by glob pattern",
      schema: { type: "object", properties: {} },
    },
    {
      name: "read",
      owner: "pi",
      promptGuidelines: [],
      description: "Read file contents",
      schema: { type: "object", properties: {} },
    },
  ];
}

// Slice the rebuilt worker `Guidelines:` block out of an assembled prompt and
// return its bullet texts (between `Guidelines:\n` and the next blank line).
function sliceGuidelineBullets(systemPrompt) {
  const header = "Guidelines:\n";
  const start = systemPrompt.indexOf(header);
  assert.notEqual(start, -1, "expected a Guidelines block in the assembled prompt");
  const bodyStart = start + header.length;
  const end = systemPrompt.indexOf("\n\n", bodyStart);
  const body = systemPrompt.slice(bodyStart, end === -1 ? undefined : end);
  return [...body.matchAll(/^- (.+)$/gm)].map((m) => m[1]);
}

function replaceAvailableToolsBlock(basePrompt, toolLines) {
  const replacement = [
    "Available tools:",
    ...toolLines,
    "",
    "In addition to the tools above, you may have access to other custom tools depending on the project.",
  ].join("\n");
  return basePrompt.replace(
    /Available tools:\n[\s\S]*?\n\nIn addition to the tools above, you may have access to other custom tools depending on the project\./,
    replacement,
  );
}

describe("assembleMmrSubagentSurface() public API", () => {
  let assembleMmrSubagentSurface;
  let registerMmrSubagentPromptBuilder;
  let clearMmrSubagentPromptBuilders;

  beforeEach(async () => {
    const mod = await importSource(ASSEMBLY_MODULE);
    assembleMmrSubagentSurface = mod.assembleMmrSubagentSurface;
    registerMmrSubagentPromptBuilder = mod.registerMmrSubagentPromptBuilder;
    clearMmrSubagentPromptBuilders = mod.clearMmrSubagentPromptBuilders;
    clearMmrSubagentPromptBuilders?.();
  });

  it("exports assembleMmrSubagentSurface as a function", () => {
    assert.equal(typeof assembleMmrSubagentSurface, "function");
  });

  it("exports a registerMmrSubagentPromptBuilder hook", () => {
    assert.equal(typeof registerMmrSubagentPromptBuilder, "function");
  });
});

describe("assembleMmrSubagentSurface() standalone route", () => {
  let assembleMmrSubagentSurface;
  let registerMmrSubagentPromptBuilder;
  let clearMmrSubagentPromptBuilders;

  beforeEach(async () => {
    const mod = await importSource(ASSEMBLY_MODULE);
    assembleMmrSubagentSurface = mod.assembleMmrSubagentSurface;
    registerMmrSubagentPromptBuilder = mod.registerMmrSubagentPromptBuilder;
    clearMmrSubagentPromptBuilders = mod.clearMmrSubagentPromptBuilders;
    clearMmrSubagentPromptBuilders();
  });

  it("returns the registered prompt builder's output verbatim as systemPrompt for standalone profiles", () => {
    let observedCwd;
    registerMmrSubagentPromptBuilder("finder", ({ cwd }) => {
      observedCwd = cwd;
      return `FINDER PROMPT for ${cwd}`;
    });
    const result = assembleMmrSubagentSurface({
      profile: makeFinderProfile(),
      baseSystemPrompt: BASE_PROMPT,
      activeToolManifest: makeFinderManifest(),
      cwd: "/abs/repo",
    });
    assert.equal(observedCwd, "/abs/repo");
    assert.equal(result.subagent, "finder");
    assert.equal(result.profile.name, "finder");
    assert.equal(result.systemPrompt, "FINDER PROMPT for /abs/repo");
  });

  it("emits a single 'standalone-prompt' block whose text equals the systemPrompt for standalone profiles", () => {
    registerMmrSubagentPromptBuilder("finder", ({ cwd }) => `SP ${cwd}`);
    const result = assembleMmrSubagentSurface({
      profile: makeFinderProfile(),
      baseSystemPrompt: BASE_PROMPT,
      activeToolManifest: makeFinderManifest(),
      cwd: "/x",
    });
    assert.ok(Array.isArray(result.blocks));
    assert.equal(result.blocks.length, 1);
    assert.equal(result.blocks[0].kind, "standalone-prompt");
    assert.equal(result.blocks[0].source, "mmr-subagents");
    assert.equal(result.blocks[0].text, result.systemPrompt);
    assert.equal(result.blocks[0].text, "SP /x");
  });

  it("passes the caller-supplied active tool manifest through unchanged for standalone profiles", () => {
    registerMmrSubagentPromptBuilder("finder", () => "SP");
    const manifest = makeFinderManifest();
    const result = assembleMmrSubagentSurface({
      profile: makeFinderProfile(),
      baseSystemPrompt: BASE_PROMPT,
      activeToolManifest: manifest,
      cwd: "/x",
    });
    assert.equal(result.activeToolManifest.length, manifest.length);
    assert.deepEqual(
      result.activeToolManifest.map((entry) => entry.name),
      manifest.map((entry) => entry.name),
    );
  });

  it("fails closed when the named prompt builder is not registered", () => {
    // No registerMmrSubagentPromptBuilder call.
    assert.throws(
      () =>
        assembleMmrSubagentSurface({
          profile: makeFinderProfile(),
          baseSystemPrompt: BASE_PROMPT,
          activeToolManifest: makeFinderManifest(),
          cwd: "/x",
        }),
      /finder|prompt builder|not registered/i,
    );
  });

  it("does not leak any tool outside the profile allowlist into the active tool manifest", () => {
    registerMmrSubagentPromptBuilder("finder", () => "SP");
    const manifestWithLeak = [
      ...makeFinderManifest(),
      {
        name: "apply_patch",
        owner: "mmr-toolbox",
        promptGuidelines: [],
        description: "Apply a patch",
        schema: {},
      },
    ];
    const result = assembleMmrSubagentSurface({
      profile: makeFinderProfile(),
      baseSystemPrompt: BASE_PROMPT,
      activeToolManifest: manifestWithLeak,
      cwd: "/x",
    });
    const names = result.activeToolManifest.map((entry) => entry.name);
    // Profile tools are authoritative: anything outside profile.tools is filtered.
    assert.ok(names.includes("grep"));
    assert.ok(names.includes("find"));
    assert.ok(names.includes("read"));
    assert.equal(
      names.includes("apply_patch"),
      false,
      "tools outside the profile allowlist must be filtered from the active manifest",
    );
  });

  it("produces byte-equal output across runs for identical inputs (determinism)", () => {
    registerMmrSubagentPromptBuilder("finder", ({ cwd }) => `SP for ${cwd}`);
    const a = assembleMmrSubagentSurface({
      profile: makeFinderProfile(),
      baseSystemPrompt: BASE_PROMPT,
      activeToolManifest: makeFinderManifest(),
      cwd: "/abs/repo",
    });
    const b = assembleMmrSubagentSurface({
      profile: makeFinderProfile(),
      baseSystemPrompt: BASE_PROMPT,
      activeToolManifest: makeFinderManifest(),
      cwd: "/abs/repo",
    });
    assert.equal(a.systemPrompt, b.systemPrompt);
    assert.deepEqual(
      a.activeToolManifest.map((e) => e.name),
      b.activeToolManifest.map((e) => e.name),
    );
    assert.equal(a.blocks.length, b.blocks.length);
    for (let i = 0; i < a.blocks.length; i += 1) {
      assert.equal(a.blocks[i].text, b.blocks[i].text);
      assert.equal(a.blocks[i].kind, b.blocks[i].kind);
    }
  });
});

describe("assembleMmrSubagentSurface() mode-derived route", () => {
  let assembleMmrSubagentSurface;
  let registerMmrSubagentPromptBuilder;
  let clearMmrSubagentPromptBuilders;

  beforeEach(async () => {
    const mod = await importSource(ASSEMBLY_MODULE);
    assembleMmrSubagentSurface = mod.assembleMmrSubagentSurface;
    registerMmrSubagentPromptBuilder = mod.registerMmrSubagentPromptBuilder;
    clearMmrSubagentPromptBuilders = mod.clearMmrSubagentPromptBuilders;
    clearMmrSubagentPromptBuilders();
  });

  it("derives the system prompt from the parent locked mode and appends a worker-role block", () => {
    registerMmrSubagentPromptBuilder("task", ({ profile }) =>
      `## Task Worker Role\n\nYou are running as ${profile.displayName}; do not spawn another Task.`,
    );

    const result = assembleMmrSubagentSurface({
      profile: makeTaskProfile(),
      baseSystemPrompt: BASE_PROMPT,
      activeToolManifest: [],
      cwd: "/abs/repo",
    });

    assert.equal(result.subagent, "Task");
    assert.equal(result.profile.name, "Task");
    // The base mode prompt-assembly head must appear.
    assert.match(result.systemPrompt, /mmr_mode name="smart"/);
    // The appended worker-role block must appear at the end.
    assert.match(result.systemPrompt, /## Task Worker Role/);
    assert.match(result.systemPrompt, /do not spawn another Task/);
    // The flattened blocks reproduce systemPrompt byte-for-byte.
    const flattened = result.blocks.map((b) => b.text).join("");
    assert.equal(flattened, result.systemPrompt);
    // The last block carries the worker-role text.
    const last = result.blocks[result.blocks.length - 1];
    assert.equal(last.kind, "subagent-worker-role");
    assert.equal(last.source, "mmr-subagents");
    assert.match(last.text, /## Task Worker Role/);
  });

  it("scopes built-in tool guidance to the worker's filtered manifest, not the parent's rendered tools block", () => {
    registerMmrSubagentPromptBuilder("task", () => "## Task Worker Role\n");
    // Parent BASE_PROMPT lists read/bash/edit/write/grep/find, but this worker
    // only resolves read + bash. Guidance must follow the worker, so the
    // parent-only built-ins (edit/write/grep/find) must not leak.
    const result = assembleMmrSubagentSurface({
      profile: makeTaskProfile(),
      baseSystemPrompt: BASE_PROMPT,
      activeToolManifest: [
        { name: "read", owner: "pi", promptGuidelines: [], description: "Read file contents.", schema: {} },
        { name: "bash", owner: "pi", promptGuidelines: [], description: "Run shell commands.", schema: {} },
      ],
      cwd: "/abs/repo",
    });
    const start = result.systemPrompt.indexOf("## Built-in tool guidance");
    assert.notEqual(start, -1, "expected a built-in tool guidance block");
    const block = result.systemPrompt.slice(start, result.systemPrompt.indexOf("\n## ", start + 1));
    assert.deepEqual([...block.matchAll(/^([a-z]+):$/gm)].map((m) => m[1]), ["bash", "read"]);
  });

  it("keeps a blank line between the worker Available tools interstitial and Guidelines", () => {
    registerMmrSubagentPromptBuilder("task", () => "## Task Worker Role\n");
    const result = assembleMmrSubagentSurface({
      profile: makeTaskProfile(),
      baseSystemPrompt: BASE_PROMPT,
      activeToolManifest: [
        { name: "read", owner: "pi", promptGuidelines: [], description: "Read file contents.", schema: {} },
      ],
      cwd: "/abs/repo",
    });
    assert.match(
      result.systemPrompt,
      /In addition to the tools above[^\n]*\n\nGuidelines:\n/,
      "worker Available tools block must end with a blank line before Guidelines (matching Pi/parent)",
    );
  });

  it("fails closed when the mode-derived prompt builder is not registered", () => {
    assert.throws(
      () =>
        assembleMmrSubagentSurface({
          profile: makeTaskProfile(),
          baseSystemPrompt: BASE_PROMPT,
          activeToolManifest: [],
          cwd: "/abs/repo",
        }),
      /task|prompt builder|not registered/i,
    );
  });

  it("uses the invocation parent mode when a mode-derived profile declares baseMode 'from-parent'", () => {
    registerMmrSubagentPromptBuilder("parent-derived-fixture", ({ modeState }) =>
      `## Worker Role\n\nparent=${modeState?.mode ?? "missing"}`,
    );

    const result = assembleMmrSubagentSurface({
      profile: makeParentDerivedProfile(),
      baseSystemPrompt: BASE_PROMPT,
      activeToolManifest: [{ name: "read", owner: "pi", promptGuidelines: [], description: "", schema: {} }],
      cwd: "/abs/repo",
      parentMode: "rush",
    });

    assert.match(result.systemPrompt, /mmr_mode name="rush"/);
    assert.match(result.systemPrompt, /parent=rush/);
    assert.deepEqual(result.activeToolManifest.map((entry) => entry.name), ["read"]);
  });

  it("fails closed when baseMode 'from-parent' is used without a parentMode", () => {
    registerMmrSubagentPromptBuilder("parent-derived-fixture", () => "## Worker Role\n");
    assert.throws(
      () =>
        assembleMmrSubagentSurface({
          profile: makeParentDerivedProfile(),
          baseSystemPrompt: BASE_PROMPT,
          activeToolManifest: [],
          cwd: "/abs/repo",
        }),
      /from-parent|parentMode/i,
    );
  });

  it("does not re-introduce subagent tools into the active tool manifest for mode-derived profiles", () => {
    registerMmrSubagentPromptBuilder("task", () => "## Task Worker Role\n");
    // Caller provides a manifest that already includes a subagent tool;
    // the profile's tool allowlist must filter it out.
    const result = assembleMmrSubagentSurface({
      profile: makeTaskProfile(),
      baseSystemPrompt: BASE_PROMPT,
      activeToolManifest: [
        { name: "read", owner: "pi", promptGuidelines: [], description: "", schema: {} },
        { name: "finder", owner: "mmr-subagents", promptGuidelines: [], description: "", schema: {} },
        { name: "Task", owner: "mmr-subagents", promptGuidelines: [], description: "", schema: {} },
      ],
      cwd: "/abs/repo",
    });
    const names = result.activeToolManifest.map((e) => e.name);
    assert.ok(names.includes("read"));
    assert.equal(names.includes("finder"), false, "subagent tools must not leak into a subagent's own manifest");
    assert.equal(names.includes("Task"), false, "subagent must not list itself in the active manifest");
  });

  it("fails closed when modeState.mode disagrees with the resolved pinned baseMode", () => {
    registerMmrSubagentPromptBuilder("task", () => "## Task Worker Role\n");
    const mismatchedModeState = {
      version: 1,
      mode: "deep",
      displayName: "deep",
      source: "settings",
      targetModel: "",
      requestedModels: [],
      provider: "",
      model: "",
      modelFound: true,
      modelApplied: true,
      modelFallbackApplied: false,
      modelCandidates: [],
      promptRoute: "deep",
      requestedTools: [],
      activeTools: [],
      missingTools: [],
      deferredTools: [],
      gatedTools: [],
      disabledTools: [],
      featureGates: [],
      availabilityNotes: [],
      resolution: {
        selectedSource: "settings",
        rejectedSources: [],
        modelDecision: { fallbackApplied: false },
        toolDecisions: [],
        featureGateDecisions: [],
      },
      appliedAt: "1970-01-01T00:00:00.000Z",
    };
    assert.throws(
      () =>
        assembleMmrSubagentSurface({
          profile: makeTaskProfile(),
          baseSystemPrompt: BASE_PROMPT,
          activeToolManifest: [],
          cwd: "/abs/repo",
          modeState: mismatchedModeState,
        }),
      /baseMode|modeState\.mode/i,
    );
  });

  it("fails closed when modeState.mode disagrees with parentMode for baseMode 'from-parent'", () => {
    registerMmrSubagentPromptBuilder("parent-derived-fixture", () => "## Worker Role\n");
    const rushModeState = {
      version: 1,
      mode: "rush",
      displayName: "rush",
      source: "settings",
      targetModel: "",
      requestedModels: [],
      provider: "",
      model: "",
      modelFound: true,
      modelApplied: true,
      modelFallbackApplied: false,
      modelCandidates: [],
      promptRoute: "rush",
      requestedTools: [],
      activeTools: [],
      missingTools: [],
      deferredTools: [],
      gatedTools: [],
      disabledTools: [],
      featureGates: [],
      availabilityNotes: [],
      resolution: {
        selectedSource: "settings",
        rejectedSources: [],
        modelDecision: { fallbackApplied: false },
        toolDecisions: [],
        featureGateDecisions: [],
      },
      appliedAt: "1970-01-01T00:00:00.000Z",
    };
    assert.throws(
      () =>
        assembleMmrSubagentSurface({
          profile: makeParentDerivedProfile(),
          baseSystemPrompt: BASE_PROMPT,
          activeToolManifest: [],
          cwd: "/abs/repo",
          parentMode: "smart",
          modeState: rushModeState,
        }),
      /baseMode|modeState\.mode/i,
    );
  });

  it("inserts a blank-line separator before the worker-role block when the base surface does not end with one", () => {
    registerMmrSubagentPromptBuilder("task", () => "## Task Worker Role\nbody");
    // A baseSystemPrompt that does not contain the MMR identity line
    // makes assembleActiveSurface return a passthrough surface whose
    // text equals the raw base verbatim. Choose endings that exercise
    // each separator branch.
    const cases = [
      { base: "BASE_NO_TRAILER", expectedSep: "\n\n" },
      { base: "BASE_WITH_ONE_NL\n", expectedSep: "\n" },
      { base: "BASE_WITH_TWO_NL\n\n", expectedSep: "" },
      { base: "", expectedSep: "" },
    ];
    for (const { base, expectedSep } of cases) {
      const result = assembleMmrSubagentSurface({
        profile: makeTaskProfile(),
        baseSystemPrompt: base,
        activeToolManifest: [],
        cwd: "/abs/repo",
      });
      const expectedTail = `${expectedSep}## Task Worker Role\nbody`;
      assert.ok(
        result.systemPrompt.endsWith(expectedTail),
        `base=${JSON.stringify(base)} systemPrompt did not end with the expected separator+worker block (got tail=${JSON.stringify(result.systemPrompt.slice(-32))})`,
      );
      // Last block owns the separator so flatten still reproduces systemPrompt.
      const last = result.blocks[result.blocks.length - 1];
      assert.equal(last.kind, "subagent-worker-role");
      assert.equal(last.text, `${expectedSep}## Task Worker Role\nbody`);
      const flattened = result.blocks.map((b) => b.text).join("");
      assert.equal(flattened, result.systemPrompt);
    }
  });

  it("rewrites the mode-derived active-tools block from the worker manifest instead of parent prompt text", () => {
    registerMmrSubagentPromptBuilder("task", () => "## Worker Role\n");
    const basePrompt = replaceAvailableToolsBlock(BASE_PROMPT, [
      "- Task: Spawn another worker",
      "- oracle: Consult an advisor",
      "- read: Read file contents from parent text",
      "- grep: Search file contents from parent text",
      "- find: Find files from parent text",
    ]);
    const result = assembleMmrSubagentSurface({
      profile: makeTaskProfile(),
      baseSystemPrompt: basePrompt,
      activeToolManifest: [
        { name: "Task", owner: "mmr-subagents", promptGuidelines: [], description: "Spawn another worker", schema: {} },
        { name: "oracle", owner: "mmr-subagents", promptGuidelines: [], description: "Consult an advisor", schema: {} },
        { name: "read", owner: "pi", promptGuidelines: [], description: "Read file contents", schema: {} },
        { name: "grep", owner: "pi", promptGuidelines: [], description: "Search file contents", schema: {} },
        { name: "find", owner: "pi", promptGuidelines: [], description: "Find files by glob", schema: {} },
      ],
      cwd: "/abs/repo",
    });
    const activeToolsBlock = result.blocks.find((block) => block.kind === "active-tools");
    assert.ok(activeToolsBlock, "mode-derived surfaces must keep an active-tools block");
    assert.equal(activeToolsBlock.source, "mmr-core");
    assert.doesNotMatch(activeToolsBlock.text, /Task|oracle/);
    assert.match(activeToolsBlock.text, /- read: Read file contents/);
    assert.match(activeToolsBlock.text, /- grep: Search file contents/);
    assert.match(activeToolsBlock.text, /- find: Find files by glob/);
    assert.equal(result.systemPrompt, result.blocks.map((block) => block.text).join(""));
    assert.doesNotMatch(result.systemPrompt, /- Task:|- oracle:/);
  });

  it("renders the worker active-tools block from promptSnippet, flattening multiline text and falling back to description", () => {
    registerMmrSubagentPromptBuilder("task", () => "## Worker Role\n");
    const result = assembleMmrSubagentSurface({
      profile: makeTaskProfile(),
      baseSystemPrompt: BASE_PROMPT,
      activeToolManifest: [
        // promptSnippet present -> use it, not the (longer) description.
        { name: "read", owner: "pi", promptSnippet: "Read file contents (snippet)", promptGuidelines: [], description: "FULL read description that should not appear", schema: {} },
        // no snippet, multiline description -> collapse to a single line.
        { name: "grep", owner: "pi", promptGuidelines: [], description: "Search file\ncontents   for\npatterns", schema: {} },
        // empty/whitespace snippet -> treated as absent, fall back to description.
        { name: "find", owner: "pi", promptSnippet: "   ", promptGuidelines: [], description: "Find files by glob", schema: {} },
      ],
      cwd: "/abs/repo",
    });
    const activeToolsBlock = result.blocks.find((block) => block.kind === "active-tools");
    assert.ok(activeToolsBlock, "mode-derived surfaces must keep an active-tools block");
    assert.match(activeToolsBlock.text, /- read: Read file contents \(snippet\)/);
    assert.doesNotMatch(activeToolsBlock.text, /FULL read description/);
    assert.match(activeToolsBlock.text, /- grep: Search file contents for patterns/);
    assert.match(activeToolsBlock.text, /- find: Find files by glob/);
    // Worker tool lines stay single-line: no embedded newline mid-entry.
    assert.doesNotMatch(activeToolsBlock.text, /- grep: Search file\ncontents/);
    assert.equal(result.systemPrompt, result.blocks.map((block) => block.text).join(""));
  });

  it("renders Pi's (none) placeholder when no worker tool yields a summary line", () => {
    registerMmrSubagentPromptBuilder("task", () => "## Worker Role\n");
    const result = assembleMmrSubagentSurface({
      profile: makeTaskProfile(),
      baseSystemPrompt: BASE_PROMPT,
      activeToolManifest: [
        { name: "read", owner: "pi", promptSnippet: "", promptGuidelines: [], description: "   ", schema: {} },
      ],
      cwd: "/abs/repo",
    });
    const activeToolsBlock = result.blocks.find((block) => block.kind === "active-tools");
    assert.ok(activeToolsBlock, "mode-derived surfaces must keep an active-tools block");
    assert.match(activeToolsBlock.text, /Available tools:\n\(none\)\n/);
  });

  it("rebuilds the worker Guidelines block from the worker manifest, dropping parent-only tool guidance", () => {
    registerMmrSubagentPromptBuilder("task", () => "## Worker Role\n");
    // Parent BASE_PROMPT lists read/bash/edit/write/grep/find guidance, but
    // this worker resolves only `read`. The rebuilt block must contain read's
    // own bullets plus the two always-on constants, and none of the
    // parent-only edit/write/grep/find guidance.
    const result = assembleMmrSubagentSurface({
      profile: makeTaskProfile(),
      baseSystemPrompt: BASE_PROMPT,
      activeToolManifest: [
        {
          name: "read",
          owner: "pi",
          promptGuidelines: ["Use read to examine files instead of cat or sed."],
          description: "Read file contents.",
          schema: {},
        },
      ],
      cwd: "/abs/repo",
    });
    const bullets = sliceGuidelineBullets(result.systemPrompt);
    assert.deepEqual(bullets, [
      "Use read to examine files instead of cat or sed.",
      "Be concise in your responses",
      "Show file paths clearly when working with files",
    ]);
    // Parent-only guidance must not leak.
    assert.doesNotMatch(result.systemPrompt.slice(0, result.systemPrompt.indexOf("Pi documentation")), /edits\[\]\.oldText/);
    assert.ok(!bullets.includes("Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)"));
  });

  it("emits the conditional bash-exploration guideline when the worker has bash but no grep/find/ls", () => {
    registerMmrSubagentPromptBuilder("task", () => "## Worker Role\n");
    const result = assembleMmrSubagentSurface({
      profile: makeTaskProfile(),
      baseSystemPrompt: BASE_PROMPT,
      activeToolManifest: [
        { name: "bash", owner: "pi", promptGuidelines: [], description: "Run shell commands.", schema: {} },
      ],
      cwd: "/abs/repo",
    });
    const bullets = sliceGuidelineBullets(result.systemPrompt);
    assert.ok(bullets.includes("Use bash for file operations like ls, rg, find"));
    // It comes first (Pi prepends it before the per-tool loop).
    assert.equal(bullets[0], "Use bash for file operations like ls, rg, find");
  });

  it("omits the conditional bash-exploration guideline when the worker also has grep/find/ls", () => {
    registerMmrSubagentPromptBuilder("task", () => "## Worker Role\n");
    const result = assembleMmrSubagentSurface({
      profile: makeTaskProfile(),
      baseSystemPrompt: BASE_PROMPT,
      activeToolManifest: [
        { name: "bash", owner: "pi", promptGuidelines: [], description: "Run shell commands.", schema: {} },
        { name: "grep", owner: "pi", promptGuidelines: [], description: "Search file contents.", schema: {} },
      ],
      cwd: "/abs/repo",
    });
    const bullets = sliceGuidelineBullets(result.systemPrompt);
    assert.ok(!bullets.includes("Use bash for file operations like ls, rg, find"));
  });

  it("keeps the always-on guidelines exactly once even when a tool already lists one", () => {
    registerMmrSubagentPromptBuilder("task", () => "## Worker Role\n");
    const result = assembleMmrSubagentSurface({
      profile: makeTaskProfile(),
      baseSystemPrompt: BASE_PROMPT,
      activeToolManifest: [
        {
          name: "read",
          owner: "pi",
          promptGuidelines: ["Be concise in your responses", "Use read to examine files instead of cat or sed."],
          description: "Read file contents.",
          schema: {},
        },
      ],
      cwd: "/abs/repo",
    });
    const bullets = sliceGuidelineBullets(result.systemPrompt);
    assert.equal(bullets.filter((b) => b === "Be concise in your responses").length, 1);
    assert.equal(bullets.filter((b) => b === "Show file paths clearly when working with files").length, 1);
    // The deduped always-on bullet keeps its first-occurrence position.
    assert.deepEqual(bullets, [
      "Be concise in your responses",
      "Use read to examine files instead of cat or sed.",
      "Show file paths clearly when working with files",
    ]);
  });

  it("marks the rebuilt active-guidelines block as mmr-core and preserves byte-for-byte flatten", () => {
    registerMmrSubagentPromptBuilder("task", () => "## Worker Role\n");
    const result = assembleMmrSubagentSurface({
      profile: makeTaskProfile(),
      baseSystemPrompt: BASE_PROMPT,
      activeToolManifest: [
        { name: "read", owner: "pi", promptGuidelines: ["Use read to examine files instead of cat or sed."], description: "Read file contents.", schema: {} },
      ],
      cwd: "/abs/repo",
    });
    const guidelinesBlock = result.blocks.find((block) => block.kind === "active-guidelines");
    assert.ok(guidelinesBlock, "mode-derived surfaces must keep an active-guidelines block");
    assert.equal(guidelinesBlock.source, "mmr-core");
    assert.ok(guidelinesBlock.text.startsWith("Guidelines:\n"));
    assert.ok(guidelinesBlock.text.endsWith("\n\n"));
    assert.equal(result.systemPrompt, result.blocks.map((block) => block.text).join(""));
  });

  it("returns mode-derived results deterministically across runs", () => {
    registerMmrSubagentPromptBuilder("task", ({ cwd }) => `## Task Worker Role\n\ncwd=${cwd}`);
    const a = assembleMmrSubagentSurface({
      profile: makeTaskProfile(),
      baseSystemPrompt: BASE_PROMPT,
      activeToolManifest: [],
      cwd: "/abs/repo",
    });
    const b = assembleMmrSubagentSurface({
      profile: makeTaskProfile(),
      baseSystemPrompt: BASE_PROMPT,
      activeToolManifest: [],
      cwd: "/abs/repo",
    });
    assert.equal(a.systemPrompt, b.systemPrompt);
  });
});

describe("assembleMmrSubagentSurface() profile<->registry safety", () => {
  let assembleMmrSubagentSurface;
  let registerMmrSubagentPromptBuilder;
  let clearMmrSubagentPromptBuilders;
  let getMmrSubagentProfile;

  beforeEach(async () => {
    const mod = await importSource(ASSEMBLY_MODULE);
    const profiles = await importSource(PROFILES_MODULE);
    assembleMmrSubagentSurface = mod.assembleMmrSubagentSurface;
    registerMmrSubagentPromptBuilder = mod.registerMmrSubagentPromptBuilder;
    clearMmrSubagentPromptBuilders = mod.clearMmrSubagentPromptBuilders;
    getMmrSubagentProfile = profiles.getMmrSubagentProfile;
    clearMmrSubagentPromptBuilders();
  });

  it("accepts the canonical finder profile straight from the registry", () => {
    registerMmrSubagentPromptBuilder("finder", ({ cwd }) => `SP ${cwd}`);
    const profile = getMmrSubagentProfile("finder");
    const result = assembleMmrSubagentSurface({
      profile,
      baseSystemPrompt: BASE_PROMPT,
      activeToolManifest: makeFinderManifest(),
      cwd: "/abs/repo",
    });
    assert.equal(result.subagent, "finder");
    assert.equal(result.systemPrompt, "SP /abs/repo");
  });

  it("produces the canonical finder prompt through the registered mmr-subagents builder", async () => {
    const { registerMmrSubagentsPromptBuilders, buildFinderWorkerSystemPrompt } = await importSource(PROMPTS_MODULE);
    clearMmrSubagentPromptBuilders();
    registerMmrSubagentsPromptBuilders();
    const profile = getMmrSubagentProfile("finder");
    const result = assembleMmrSubagentSurface({
      profile,
      baseSystemPrompt: "",
      activeToolManifest: [],
      cwd: "/abs/repo",
    });
    assert.equal(result.systemPrompt, buildFinderWorkerSystemPrompt("/abs/repo"));
  });
});
