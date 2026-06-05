import assert from "node:assert/strict";
import path from "node:path";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const IMPORT_MODULE = "extensions/mmr-subagents/custom-import.ts";
const LOADER_MODULE = "extensions/mmr-subagents/custom-loader.ts";

describe("mmr-subagents custom import planner", () => {
  it("maps Claude aliases, blocks unsafe tools, and flags unknown tools", async () => {
    const { mapImportTools } = await importSource(IMPORT_MODULE);
    const result = mapImportTools({
      tokens: ["Read", "Grep", "Bash", "Task", "mcp__github", "read_github", "totally_unknown"],
      availableTools: ["read", "grep", "bash", "read_github"],
    });
    assert.deepEqual(result.tools, ["read", "grep", "bash", "read_github"]);
    const byStatus = Object.fromEntries(result.results.map((r) => [r.source, r.status]));
    assert.equal(byStatus.Read, "mapped");
    assert.equal(byStatus.read_github, "kept");
    assert.equal(byStatus.Task, "blocked");
    assert.equal(byStatus.mcp__github, "blocked");
    assert.equal(byStatus.totally_unknown, "unknown");
    assert.ok(result.diagnostics.some((d) => d.severity === "error"));
    assert.ok(result.diagnostics.some((d) => d.severity === "warning"));
  });

  it("recommends a read-only toolset when the source declares no tools (never all tools)", async () => {
    const { parseMmrCustomSubagentMarkdown } = await importSource(LOADER_MODULE);
    const { planMmrCustomSubagentImport } = await importSource(IMPORT_MODULE);
    const definition = parseMmrCustomSubagentMarkdown({
      filePath: path.join("/repo", ".claude", "agents", "noTools.md"),
      markdown: ["---", "name: No Tools", "description: Declares no tools.", "---", "Body."].join("\n"),
    });
    const plan = planMmrCustomSubagentImport({ definition });
    assert.deepEqual(plan.tools, ["read", "find", "grep"]);
    assert.ok(plan.diagnostics.some((d) => d.message.includes("least-privilege")));
  });

  it("recommends read-only when every declared tool is unknown to the parent inventory", async () => {
    const { parseMmrCustomSubagentMarkdown } = await importSource(LOADER_MODULE);
    const { planMmrCustomSubagentImport } = await importSource(IMPORT_MODULE);
    const definition = parseMmrCustomSubagentMarkdown({
      filePath: path.join("/repo", ".claude", "agents", "unknown.md"),
      markdown: ["---", "name: Unknown Tools", "description: Declares unknown tools.", "tools: not_a_real_tool", "---", "Body."].join("\n"),
    });
    const plan = planMmrCustomSubagentImport({ definition, availableTools: ["read", "find", "grep"] });
    assert.deepEqual(plan.tools, ["read", "find", "grep"]);
    assert.ok(plan.diagnostics.some((d) => d.message.includes("read-only toolset")));
  });

  it("flags a declared model that is not available", async () => {
    const { parseMmrCustomSubagentMarkdown } = await importSource(LOADER_MODULE);
    const { planMmrCustomSubagentImport } = await importSource(IMPORT_MODULE);
    const definition = parseMmrCustomSubagentMarkdown({
      filePath: path.join("/repo", ".claude", "agents", "model.md"),
      markdown: ["---", "name: Pinned", "description: Pins a model.", "model: openai-codex/gpt-9", "tools: read", "---", "Body."].join("\n"),
    });
    const plan = planMmrCustomSubagentImport({ definition, availableModels: ["openai-codex/gpt-5.5"] });
    assert.ok(plan.diagnostics.some((d) => d.message.includes("not available")));
  });
});
