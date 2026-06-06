import assert from "node:assert/strict";
import path from "node:path";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const MODULE = "extensions/mmr-subagents/config-flow.ts";

describe("mmr-subagents config-flow pure helpers", () => {
  it("derives a stable record id slug from a display name", async () => {
    const { importIdForName } = await importSource(MODULE);
    assert.equal(importIdForName("Repo Reviewer"), "repo_reviewer");
    assert.equal(importIdForName("API/Docs Bot!"), "api_docs_bot");
  });

  it("resolves a project destination, copying an external source in", async () => {
    const { resolveImportDestination } = await importSource(MODULE);
    const dest = resolveImportDestination({
      plan: { name: "Repo Reviewer", sourcePath: "/home/u/.claude/agents/reviewer.md" },
      destination: "project",
      cwd: "/work/proj",
      homeDir: "/home/u",
    });
    assert.equal(dest.root, "project");
    assert.equal(dest.file, "repo_reviewer.md");
    assert.equal(dest.absPath, path.join("/work/proj", ".pi", "subagents", "repo_reviewer.md"));
    assert.equal(dest.alreadyAtDest, false);
  });

  it("enables a Pi-owned source in place without renaming", async () => {
    const { resolveImportDestination } = await importSource(MODULE);
    const dest = resolveImportDestination({
      plan: { name: "Manual Drop", sourcePath: "/work/proj/.pi/subagents/manual.md" },
      destination: "project",
      cwd: "/work/proj",
      homeDir: "/home/u",
    });
    assert.equal(dest.alreadyAtDest, true);
    assert.equal(dest.file, "manual.md");
  });

  it("enables a nested-in-root source in place without copying or renaming", async () => {
    const { resolveImportDestination } = await importSource(MODULE);
    const dest = resolveImportDestination({
      plan: { name: "Nested Agent", sourcePath: "/work/proj/.pi/subagents/sub/agent.md" },
      destination: "project",
      cwd: "/work/proj",
      homeDir: "/home/u",
    });
    assert.equal(dest.alreadyAtDest, true, "nested-in-root source is enabled in place");
    assert.equal(dest.file, path.join("sub", "agent.md"), "keeps the nested relative path under the root");
    assert.equal(
      dest.absPath,
      path.join("/work/proj", ".pi", "subagents", "sub", "agent.md"),
      "absPath points at the existing on-disk file, not a renamed copy",
    );
  });

  it("copies a sibling-of-root source that escapes the root via ..", async () => {
    const { resolveImportDestination } = await importSource(MODULE);
    const dest = resolveImportDestination({
      plan: { name: "Escapee", sourcePath: "/work/proj/.pi/agent.md" },
      destination: "project",
      cwd: "/work/proj",
      homeDir: "/home/u",
    });
    assert.equal(dest.alreadyAtDest, false, "a source outside the root is copied, not enabled in place");
    assert.equal(dest.file, "escapee.md");
  });

  it("builds a global config input with project scope; omits projects for project destination", async () => {
    const { buildImportConfigInput, resolveImportDestination } = await importSource(MODULE);
    const plan = { name: "Scout", description: "d", toolName: "sa__scout", model: "inherit", modelDeclared: false, tools: ["read"], toolResults: [], diagnostics: [], sourcePath: "/home/u/.pi/agent/subagents/scout.md" };

    const globalDest = resolveImportDestination({ plan, destination: "global", cwd: "/work/proj", homeDir: "/home/u" });
    const globalInput = buildImportConfigInput(plan, {
      toolName: "sa__scout", model: "inherit", thinkingLevel: "medium", tools: ["read", "find"], modes: "allLocked", projects: "all", destination: globalDest,
    });
    assert.equal(globalInput.id, "scout");
    assert.equal(globalInput.input.projects, "all");
    assert.equal(globalInput.input.thinkingLevel, "medium");
    assert.equal(globalInput.input.source.root, "global");

    const projDest = resolveImportDestination({ plan, destination: "project", cwd: "/work/proj", homeDir: "/home/u" });
    const projInput = buildImportConfigInput(plan, {
      toolName: "sa__scout", model: "inherit", tools: ["read"], modes: ["deep"], destination: projDest,
    });
    assert.equal(projInput.input.projects, undefined, "project destination omits projects scope");
    assert.deepEqual(projInput.input.modes, ["deep"]);
  });
});
