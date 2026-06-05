// Phase 6: subagent effective-surface fixtures.
//
// Pins the rendered debug surface for the finder subagent so any drift
// in its system prompt or active tool manifest is caught at PR time.
// Mirrors the workflow used by tests/mmr-subagents-finder-fixture.test.mjs:
// PI_MMR_UPDATE_FIXTURES=1 rewrites the snapshot, every other run pins
// it.
//
// Independent structural assertions guarantee the rendered output
// always carries the required sections (System Messages / Tools) and
// excludes tools outside the profile allowlist, regardless of exact
// rendering of any one line.

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const subagentFixtureDir = path.join(
  import.meta.dirname,
  "fixtures/mmr-subagent-surface",
);
const UPDATE_FIXTURES = process.env.PI_MMR_UPDATE_FIXTURES === "1";

function assertFixtureMatches(filename, actual) {
  const fixturePath = path.join(subagentFixtureDir, filename);
  if (UPDATE_FIXTURES) {
    writeFileSync(fixturePath, actual);
    return;
  }
  if (!existsSync(fixturePath)) {
    assert.fail(`fixture ${filename} is missing; rerun with PI_MMR_UPDATE_FIXTURES=1 to create it after reviewing the rendered surface`);
  }
  const expected = readFileSync(fixturePath, "utf8");
  assert.equal(
    actual,
    expected,
    `fixture ${filename} drift; rerun with PI_MMR_UPDATE_FIXTURES=1 to refresh`,
  );
}

function assertNoRepeatedLongSystemPromptLines(name, rendered) {
  const systemPrompt = rendered.split("=== Tools ===")[0] ?? rendered;
  const counts = new Map();
  for (const line of systemPrompt.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length < 80) continue;
    counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
  }

  const duplicates = [...counts]
    .filter(([, count]) => count > 1)
    .map(([line, count]) => `${count}x ${line}`);

  assert.deepEqual(duplicates, [], `${name}: subagent system prompt must not duplicate long instruction lines`);
}

function makePiToolManifestEntry(name, description, schema, promptGuidelines = []) {
  return {
    name,
    owner: "pi",
    promptGuidelines: [...promptGuidelines],
    description,
    schema,
  };
}

// A small but representative slice of Pi's read-only tool surface so
// the fixture is realistic without dragging in every Pi tool.
function buildOracleActiveManifest() {
  return [
    makePiToolManifestEntry("read", "Read file contents.", {
      type: "object",
      additionalProperties: false,
      properties: { path: { type: "string" } },
      required: ["path"],
    }),
    makePiToolManifestEntry("grep", "Search file contents for patterns (respects .gitignore).", {
      type: "object",
      additionalProperties: false,
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
      },
      required: ["pattern"],
    }),
    makePiToolManifestEntry("find", "Find files by glob pattern (respects .gitignore).", {
      type: "object",
      additionalProperties: false,
      properties: { glob: { type: "string" } },
      required: ["glob"],
    }),
    makePiToolManifestEntry("web_search", "Search the web for a topic.", {
      type: "object",
      additionalProperties: false,
      properties: { objective: { type: "string" } },
      required: ["objective"],
    }),
    makePiToolManifestEntry("read_web_page", "Fetch and convert a web page to Markdown.", {
      type: "object",
      additionalProperties: false,
      properties: { url: { type: "string" } },
      required: ["url"],
    }),
    // Deliberately include a tool the profile does NOT allow so the
    // structural test confirms it is filtered out before reaching the
    // rendered manifest.
    makePiToolManifestEntry("bash", "Run a shell command.", {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    }),
  ];
}

function buildLibrarianActiveManifest() {
  return [
    makePiToolManifestEntry("read_github", "Read a file or directory listing from a GitHub repository.", {
      type: "object",
      additionalProperties: false,
      properties: { repository: { type: "string" }, path: { type: "string" } },
      required: ["repository", "path"],
    }),
    makePiToolManifestEntry("list_directory_github", "List a directory's contents in a GitHub repository.", {
      type: "object",
      additionalProperties: false,
      properties: { repository: { type: "string" }, path: { type: "string" } },
      required: ["repository"],
    }),
    makePiToolManifestEntry("glob_github", "Find repository files by glob pattern.", {
      type: "object",
      additionalProperties: false,
      properties: { repository: { type: "string" }, filePattern: { type: "string" } },
      required: ["repository", "filePattern"],
    }),
    makePiToolManifestEntry("search_github", "Search code inside a single GitHub repository.", {
      type: "object",
      additionalProperties: false,
      properties: { repository: { type: "string" }, pattern: { type: "string" } },
      required: ["repository", "pattern"],
    }),
    makePiToolManifestEntry("commit_search", "Search or list a GitHub repository's commit history.", {
      type: "object",
      additionalProperties: false,
      properties: { repository: { type: "string" }, query: { type: "string" } },
      required: ["repository"],
    }),
    makePiToolManifestEntry("diff_github", "Compare two refs in a GitHub repository.", {
      type: "object",
      additionalProperties: false,
      properties: { repository: { type: "string" }, base: { type: "string" }, head: { type: "string" } },
      required: ["repository", "base", "head"],
    }),
    makePiToolManifestEntry("list_repositories", "List or search GitHub repositories.", {
      type: "object",
      additionalProperties: false,
      properties: { pattern: { type: "string" }, organization: { type: "string" }, language: { type: "string" } },
      required: [],
    }),
    makePiToolManifestEntry("read", "Read local file contents.", {
      type: "object",
      additionalProperties: false,
      properties: { path: { type: "string" } },
      required: ["path"],
    }),
    makePiToolManifestEntry("bash", "Run a shell command.", {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    }),
  ];
}

// Representative built-in `promptGuidelines` mirroring Pi's per-tool strings
// (copied from tests/fixtures/mmr-core-prompts/base.md `Guidelines:`). At
// runtime these come from Pi's `getAllTools()` via `buildWorkerToolManifest`;
// the fixture hand-builds synthetic entries, so without these the rebuilt
// worker `Guidelines:` block would drop read/edit/write bullets and be
// unrepresentative. Worker-only tools (web_search/read_web_page/finder/
// task_list) carry short representative bullets the parent prompt lacks.
function buildTaskActiveManifest() {
  return [
    makePiToolManifestEntry(
      "read",
      "Read file contents.",
      {
        type: "object",
        additionalProperties: false,
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      // The Task worker has no grep/find/ls tools, so the "Prefer grep/find/ls
      // over bash" guideline (owned by those tools in real Pi) must not appear
      // here — otherwise the rebuilt block contradicts the always-on bash
      // file-operations bullet it also emits.
      ["Use read to examine files instead of cat or sed."],
    ),
    makePiToolManifestEntry("bash", "Run shell commands.", {
      type: "object",
      additionalProperties: false,
      properties: { command: { type: "string" } },
      required: ["command"],
    }),
    makePiToolManifestEntry(
      "edit",
      "Edit existing files.",
      {
        type: "object",
        additionalProperties: false,
        properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } },
        required: ["path", "oldText", "newText"],
      },
      [
        "Use edit for precise changes (edits[].oldText must match exactly)",
        "When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
        "Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
        "Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
      ],
    ),
    makePiToolManifestEntry(
      "write",
      "Create or overwrite files.",
      {
        type: "object",
        additionalProperties: false,
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
      ["Use write only for new files or complete rewrites."],
    ),
    makePiToolManifestEntry(
      "web_search",
      "Search the web for a topic.",
      {
        type: "object",
        additionalProperties: false,
        properties: { objective: { type: "string" } },
        required: ["objective"],
      },
      ["Use web_search only for public, non-sensitive research; never include secrets or private data in queries."],
    ),
    makePiToolManifestEntry(
      "read_web_page",
      "Fetch and convert a web page to Markdown.",
      {
        type: "object",
        additionalProperties: false,
        properties: { url: { type: "string" } },
        required: ["url"],
      },
      ["Use read_web_page only for public http(s) URLs; pass forceRefetch when the latest contents are required."],
    ),
    makePiToolManifestEntry(
      "finder",
      "Search code by behavior or concept.",
      {
        type: "object",
        additionalProperties: false,
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      ["Use finder for multi-step, concept-level code search instead of chaining greps."],
    ),
    makePiToolManifestEntry(
      "task_list",
      "Manage the session-local todo list.",
      {
        type: "object",
        additionalProperties: false,
        properties: { tasks: { type: "array" } },
        required: ["tasks"],
      },
      ["Submit the full task_list every call (whole-list replacement); keep at most one item in_progress."],
    ),
    // Deliberately include recursive/advisory tools the Task profile
    // does NOT allow so the fixture pins deny-list filtering.
    makePiToolManifestEntry("Task", "Spawn another worker.", {
      type: "object",
      properties: { prompt: { type: "string" }, description: { type: "string" } },
      required: ["prompt", "description"],
    }),
    makePiToolManifestEntry("oracle", "Consult an advisor worker.", {
      type: "object",
      properties: { task: { type: "string" } },
      required: ["task"],
    }),
  ];
}

function buildFinderActiveManifest() {
  return [
    makePiToolManifestEntry("grep", "Search file contents for patterns (respects .gitignore).", {
      type: "object",
      additionalProperties: false,
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
      },
      required: ["pattern"],
    }),
    makePiToolManifestEntry("find", "Find files by glob pattern (respects .gitignore).", {
      type: "object",
      additionalProperties: false,
      properties: { glob: { type: "string" } },
      required: ["glob"],
    }),
    makePiToolManifestEntry("read", "Read file contents.", {
      type: "object",
      additionalProperties: false,
      properties: { path: { type: "string" } },
      required: ["path"],
    }),
    // Deliberately include a tool the profile does NOT allow so the
    // structural test confirms it is filtered out before reaching the
    // rendered manifest.
    makePiToolManifestEntry("bash", "Run a shell command.", {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    }),
  ];
}

describe("mmr-subagent-surface: finder fixture", () => {
  let assembleMmrSubagentSurface;
  let renderMmrPromptDebugFixture;
  let clearMmrSubagentPromptBuilders;
  let registerMmrSubagentsPromptBuilders;
  let getMmrSubagentProfile;

  beforeEach(async () => {
    const assembly = await importSource("extensions/mmr-core/subagent-prompt-assembly.ts");
    const renderer = await importSource("extensions/mmr-core/prompt-debug-renderer.ts");
    const prompts = await importSource("extensions/mmr-subagents/prompts.ts");
    const profiles = await importSource("extensions/mmr-core/subagent-profiles.ts");
    assembleMmrSubagentSurface = assembly.assembleMmrSubagentSurface;
    renderMmrPromptDebugFixture = renderer.renderMmrPromptDebugFixture;
    clearMmrSubagentPromptBuilders = assembly.clearMmrSubagentPromptBuilders;
    registerMmrSubagentsPromptBuilders = prompts.registerMmrSubagentsPromptBuilders;
    getMmrSubagentProfile = profiles.getMmrSubagentProfile;
    clearMmrSubagentPromptBuilders();
    registerMmrSubagentsPromptBuilders();
  });

  it("pins the rendered debug surface for the finder subagent", () => {
    const profile = getMmrSubagentProfile("finder");
    const result = assembleMmrSubagentSurface({
      profile,
      baseSystemPrompt: "",
      activeToolManifest: buildFinderActiveManifest(),
      cwd: "/abs/repo",
    });

    const rendered = renderMmrPromptDebugFixture(result);

    // Structural guarantees independent of exact wording.
    assert.match(rendered, /^=== System Messages ===/m);
    assert.match(rendered, /^=== Tools ===/m);
    // Profile-allowlisted tools must appear; out-of-allowlist tools
    // (`bash`) must not, because the framework filters them out before
    // returning the active manifest.
    assert.match(rendered, /^# grep$/m);
    assert.match(rendered, /^# find$/m);
    assert.match(rendered, /^# read$/m);
    assert.doesNotMatch(rendered, /^# bash$/m);
    // Tool descriptions and schema bodies must be rendered.
    assert.match(rendered, /Search file contents for patterns/);
    assert.match(rendered, /Find files by glob pattern/);
    assert.match(rendered, /Read file contents/);
    assert.match(rendered, /"type": "object"/);
    // Finder system-prompt landmarks must be present.
    assert.match(rendered, /You are a fast, parallel code search agent\./);
    assert.match(rendered, /Workspace root: \/abs\/repo/);
    assert.match(rendered, /8\+ parallel tool calls/);
    assertNoRepeatedLongSystemPromptLines("finder", rendered);

    assertFixtureMatches("finder.md", rendered);
  });
});

describe("mmr-subagent-surface: Task fixture", () => {
  let assembleMmrSubagentSurface;
  let renderMmrPromptDebugFixture;
  let clearMmrSubagentPromptBuilders;
  let registerMmrSubagentsPromptBuilders;
  let getMmrSubagentProfile;

  beforeEach(async () => {
    const assembly = await importSource("extensions/mmr-core/subagent-prompt-assembly.ts");
    const renderer = await importSource("extensions/mmr-core/prompt-debug-renderer.ts");
    const prompts = await importSource("extensions/mmr-subagents/prompts.ts");
    const profiles = await importSource("extensions/mmr-core/subagent-profiles.ts");
    assembleMmrSubagentSurface = assembly.assembleMmrSubagentSurface;
    renderMmrPromptDebugFixture = renderer.renderMmrPromptDebugFixture;
    clearMmrSubagentPromptBuilders = assembly.clearMmrSubagentPromptBuilders;
    registerMmrSubagentsPromptBuilders = prompts.registerMmrSubagentsPromptBuilders;
    getMmrSubagentProfile = profiles.getMmrSubagentProfile;
    clearMmrSubagentPromptBuilders();
    registerMmrSubagentsPromptBuilders();
  });

  it("pins the rendered debug surface for the Task subagent", () => {
    const profile = getMmrSubagentProfile("task-subagent");
    const baseSystemPrompt = readFileSync(path.join(import.meta.dirname, "fixtures/mmr-core-prompts/base.md"), "utf8");
    const result = assembleMmrSubagentSurface({
      profile,
      baseSystemPrompt,
      activeToolManifest: buildTaskActiveManifest(),
      cwd: "/abs/repo",
      parentMode: "smart",
    });

    const rendered = renderMmrPromptDebugFixture(result);

    assert.match(rendered, /^=== System Messages ===/m);
    assert.match(rendered, /^=== Tools ===/m);
    assert.match(rendered, /^# read$/m);
    assert.match(rendered, /^# bash$/m);
    assert.match(rendered, /^# edit$/m);
    assert.match(rendered, /^# write$/m);
    assert.match(rendered, /^# web_search$/m);
    assert.match(rendered, /^# read_web_page$/m);
    assert.match(rendered, /^# finder$/m);
    assert.match(rendered, /^# task_list$/m);
    assert.doesNotMatch(rendered, /^# Task$/m);
    assert.doesNotMatch(rendered, /^# oracle$/m);
    assert.match(rendered, /<mmr_mode name="smart">/);
    assert.match(rendered, /## Task Worker Role/);
    assert.match(rendered, /Return a compact result, not a transcript/);
    assertNoRepeatedLongSystemPromptLines("Task", rendered);

    assertFixtureMatches("task.md", rendered);
  });

  it("does not duplicate parent mode guidance when Task receives an already-rewritten parent prompt", () => {
    const profile = getMmrSubagentProfile("task-subagent");
    const rewrittenParentPrompt = readFileSync(path.join(import.meta.dirname, "fixtures/mmr-core-prompts/smart.md"), "utf8");
    const result = assembleMmrSubagentSurface({
      profile,
      baseSystemPrompt: rewrittenParentPrompt,
      activeToolManifest: buildTaskActiveManifest(),
      cwd: "/abs/repo",
      parentMode: "smart",
    });

    const rendered = renderMmrPromptDebugFixture(result);
    assert.match(rendered, /## Task Worker Role/);
    assertNoRepeatedLongSystemPromptLines("Task runtime parent prompt", rendered);
  });
});

describe("mmr-subagent-surface: oracle fixture", () => {
  let assembleMmrSubagentSurface;
  let renderMmrPromptDebugFixture;
  let clearMmrSubagentPromptBuilders;
  let registerMmrSubagentsPromptBuilders;
  let getMmrSubagentProfile;

  beforeEach(async () => {
    const assembly = await importSource("extensions/mmr-core/subagent-prompt-assembly.ts");
    const renderer = await importSource("extensions/mmr-core/prompt-debug-renderer.ts");
    const prompts = await importSource("extensions/mmr-subagents/prompts.ts");
    const profiles = await importSource("extensions/mmr-core/subagent-profiles.ts");
    assembleMmrSubagentSurface = assembly.assembleMmrSubagentSurface;
    renderMmrPromptDebugFixture = renderer.renderMmrPromptDebugFixture;
    clearMmrSubagentPromptBuilders = assembly.clearMmrSubagentPromptBuilders;
    registerMmrSubagentsPromptBuilders = prompts.registerMmrSubagentsPromptBuilders;
    getMmrSubagentProfile = profiles.getMmrSubagentProfile;
    clearMmrSubagentPromptBuilders();
    registerMmrSubagentsPromptBuilders();
  });

  it("pins the rendered debug surface for the oracle subagent", () => {
    const profile = getMmrSubagentProfile("oracle");
    const result = assembleMmrSubagentSurface({
      profile,
      baseSystemPrompt: "",
      activeToolManifest: buildOracleActiveManifest(),
      cwd: "/abs/repo",
    });

    const rendered = renderMmrPromptDebugFixture(result);

    assert.match(rendered, /^=== System Messages ===/m);
    assert.match(rendered, /^=== Tools ===/m);
    // Profile-allowlisted tools must appear; bash (out-of-allowlist)
    // must not.
    assert.match(rendered, /^# read$/m);
    assert.match(rendered, /^# grep$/m);
    assert.match(rendered, /^# find$/m);
    assert.match(rendered, /^# web_search$/m);
    assert.match(rendered, /^# read_web_page$/m);
    assert.doesNotMatch(rendered, /^# bash$/m);
    // Oracle system-prompt landmarks must be present.
    assert.match(rendered, /You are the Oracle - an expert AI advisor/);
    assert.match(rendered, /Workspace root: \/abs\/repo/);
    assert.match(rendered, /TL;DR/);
    assert.match(rendered, /IMPORTANT: Only your last message is returned/);
    assertNoRepeatedLongSystemPromptLines("oracle", rendered);

    assertFixtureMatches("oracle.md", rendered);
  });
});

describe("mmr-subagent-surface: librarian fixture", () => {
  let assembleMmrSubagentSurface;
  let renderMmrPromptDebugFixture;
  let clearMmrSubagentPromptBuilders;
  let registerMmrSubagentsPromptBuilders;
  let getMmrSubagentProfile;

  beforeEach(async () => {
    const assembly = await importSource("extensions/mmr-core/subagent-prompt-assembly.ts");
    const renderer = await importSource("extensions/mmr-core/prompt-debug-renderer.ts");
    const prompts = await importSource("extensions/mmr-subagents/prompts.ts");
    const profiles = await importSource("extensions/mmr-core/subagent-profiles.ts");
    assembleMmrSubagentSurface = assembly.assembleMmrSubagentSurface;
    renderMmrPromptDebugFixture = renderer.renderMmrPromptDebugFixture;
    clearMmrSubagentPromptBuilders = assembly.clearMmrSubagentPromptBuilders;
    registerMmrSubagentsPromptBuilders = prompts.registerMmrSubagentsPromptBuilders;
    getMmrSubagentProfile = profiles.getMmrSubagentProfile;
    clearMmrSubagentPromptBuilders();
    registerMmrSubagentsPromptBuilders();
  });

  it("pins the rendered debug surface for the librarian subagent", () => {
    const profile = getMmrSubagentProfile("librarian");
    const result = assembleMmrSubagentSurface({
      profile,
      baseSystemPrompt: "",
      activeToolManifest: buildLibrarianActiveManifest(),
      cwd: "/abs/repo",
    });

    const rendered = renderMmrPromptDebugFixture(result);

    assert.match(rendered, /^=== System Messages ===/m);
    assert.match(rendered, /^=== Tools ===/m);
    assert.match(rendered, /^# read_github$/m);
    assert.match(rendered, /^# search_github$/m);
    assert.match(rendered, /^# diff_github$/m);
    assert.match(rendered, /^# commit_search$/m);
    assert.match(rendered, /^# list_repositories$/m);
    assert.doesNotMatch(rendered, /^# read$/m);
    assert.doesNotMatch(rendered, /^# bash$/m);
    assert.doesNotMatch(rendered, /^# web_search$/m);
    assert.match(rendered, /You are Librarian, a specialized repository research worker\./);
    assert.match(rendered, /Use the available tools extensively/);
    assert.match(rendered, /reads public GitHub repositories/);
    assert.match(rendered, /Search code inside a single GitHub repository/);
    assert.doesNotMatch(rendered, /\/home\//);
    assert.doesNotMatch(rendered, /docs\/private\//i);
    assertNoRepeatedLongSystemPromptLines("librarian", rendered);

    assertFixtureMatches("librarian-github.md", rendered);
  });
});
