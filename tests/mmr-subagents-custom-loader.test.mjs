import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const LOADER_MODULE = "extensions/mmr-subagents/custom-loader.ts";

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-mmr-custom-subagents-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeMarkdown(filePath, text) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text, "utf8");
}

describe("mmr-subagents custom sa__ loader framework", () => {
  it("normalizes custom subagent tool names with the sa__ prefix and a 64 character cap", async () => {
    const { toMmrCustomSubagentToolName, MMR_CUSTOM_SUBAGENT_TOOL_PREFIX, MMR_CUSTOM_SUBAGENT_MAX_TOOL_NAME_LENGTH } =
      await importSource(LOADER_MODULE);
    assert.equal(MMR_CUSTOM_SUBAGENT_TOOL_PREFIX, "sa__");
    assert.equal(toMmrCustomSubagentToolName("Repo Auditor"), "sa__repo_auditor");
    assert.equal(toMmrCustomSubagentToolName("---"), "sa__subagent");
    const veryLong = toMmrCustomSubagentToolName("A".repeat(300));
    assert.equal(veryLong.startsWith("sa__"), true);
    assert.ok(veryLong.length <= MMR_CUSTOM_SUBAGENT_MAX_TOOL_NAME_LENGTH);
  });

  it("normalizes Claude Code tool aliases and preserves exact Pi tool names", async () => {
    const { normalizeMmrCustomSubagentToolPatterns } = await importSource(LOADER_MODULE);
    assert.deepEqual(
      normalizeMmrCustomSubagentToolPatterns(["Read", "Grep", "Glob", "Bash", "Edit", "MultiEdit", "Write", "WebSearch", "WebFetch", "read_github"]),
      ["read", "grep", "find", "bash", "edit", "write", "web_search", "read_web_page", "read_github"],
    );
    assert.deepEqual(normalizeMmrCustomSubagentToolPatterns("Read, Bash, read"), ["read", "bash"]);
    assert.deepEqual(normalizeMmrCustomSubagentToolPatterns(["shell", "browser", "planner"]), ["shell", "browser", "planner"]);
  });

  it("reuses the shared subagent tool-policy constants for denied and read-only tool sets", async () => {
    const loader = await importSource(LOADER_MODULE);
    const policy = await importSource("extensions/mmr-core/subagent-tool-policy.ts");
    assert.deepEqual(
      [...loader.MMR_CUSTOM_SUBAGENT_DENIED_TOOLS].sort(),
      [...policy.MMR_SUBAGENT_SHARED_DENY_TOOLS].sort(),
    );
    assert.deepEqual(
      [...loader.MMR_CUSTOM_SUBAGENT_RECOMMENDED_READONLY_TOOLS].sort(),
      [...policy.MMR_SUBAGENT_READ_ONLY_TOOLS].filter((tool) => ["read", "find", "grep"].includes(tool)).sort(),
    );
  });

  it("parses subagent frontmatter, derives a tool name, substitutes baseDir, and keeps inherit as a model sentinel", async () => {
    const { parseMmrCustomSubagentMarkdown } = await importSource(LOADER_MODULE);
    const filePath = path.join("/repo", ".pi", "subagents", "repo-auditor.md");
    const definition = parseMmrCustomSubagentMarkdown({
      filePath,
      markdown: [
        "---",
        "type: subagent",
        "name: Repo Auditor",
        "description: Reviews a repository slice.",
        "model: inherit",
        "tools: Read, Bash, Write",
        "skills: [audit, review]",
        "---",
        "Inspect {baseDir} and report concise findings.",
      ].join("\n"),
    });

    assert.ok(definition);
    assert.equal(definition.name, "Repo Auditor");
    assert.equal(definition.toolName, "sa__repo_auditor");
    assert.equal(definition.description, "Reviews a repository slice.");
    assert.equal(definition.model, "inherit");
    assert.deepEqual([...definition.toolPatterns], ["read", "bash", "write"]);
    assert.equal(definition.toolsDeclared, true);
    assert.equal(definition.modelDeclared, true, "explicit model: inherit counts as declared");
    assert.equal(definition.thinkingLevel, undefined, "no thinking key -> undefined");
    assert.deepEqual([...definition.skills], ["audit", "review"]);
    assert.equal(definition.baseDir, path.dirname(filePath));
    assert.equal(definition.systemPrompt, `Inspect ${path.dirname(filePath)} and report concise findings.`);
  });

  it("parses frontmatter whose closing fence is at EOF", async () => {
    const { parseMmrCustomSubagentMarkdown } = await importSource(LOADER_MODULE);
    const definition = parseMmrCustomSubagentMarkdown({
      filePath: path.join("/repo", "agents", "empty-body.md"),
      markdown: ["---", "type: subagent", "name: Empty Body", "---"].join("\n"),
    });
    assert.ok(definition);
    assert.equal(definition.name, "Empty Body");
    assert.equal(definition.systemPrompt, "");
  });

  it("discovers markdown subagents recursively, ignores node_modules/.git, symlinks, respects max depth, and skips duplicate tool names", async () => {
    await withTempDir(async (root) => {
      await writeMarkdown(
        path.join(root, "agents", "repo-auditor.md"),
        [
          "---",
          "type: subagent",
          "name: Repo Auditor",
          "description: first wins",
          "tools: read",
          "---",
          "First body",
        ].join("\n"),
      );
      await writeMarkdown(
        path.join(root, "agents", "zz-duplicate.md"),
        [
          "---",
          "type: subagent",
          "name: Repo Auditor",
          "description: duplicate loses",
          "tools: bash",
          "---",
          "Duplicate body",
        ].join("\n"),
      );
      await writeMarkdown(
        path.join(root, "agents", "isolated.md"),
        [
          "---",
          "isolatedContext: true",
          "description: isolated context also counts",
          "tools: read",
          "---",
          "Isolated body",
        ].join("\n"),
      );
      await writeMarkdown(path.join(root, "agents", "plain.md"), "No frontmatter here");
      await writeMarkdown(path.join(root, "agents", "node_modules", "hidden.md"), "---\ntype: subagent\n---\nHidden");
      await writeMarkdown(path.join(root, "agents", ".git", "hidden.md"), "---\ntype: subagent\n---\nHidden");
      await writeMarkdown(path.join(root, "a", "b", "c", "d", "e", "f", "too-deep.md"), "---\ntype: subagent\n---\nToo deep");
      await symlink(root, path.join(root, "agents", "cycle"), "dir");

      const { discoverMmrCustomSubagents } = await importSource(LOADER_MODULE);
      const definitions = await discoverMmrCustomSubagents({ roots: [root] });
      assert.deepEqual(definitions.map((definition) => definition.toolName).sort(), ["sa__isolated", "sa__repo_auditor"]);
      const repoAuditor = definitions.find((definition) => definition.toolName === "sa__repo_auditor");
      assert.ok(repoAuditor);
      assert.equal(repoAuditor.description, "first wins");
      assert.equal(definitions.some((definition) => definition.filePath.includes("node_modules")), false);
      assert.equal(definitions.some((definition) => definition.filePath.includes(`${path.sep}.git${path.sep}`)), false);
      assert.equal(definitions.some((definition) => definition.filePath.endsWith("too-deep.md")), false);
      assert.equal(definitions.some((definition) => definition.filePath.includes(`${path.sep}cycle${path.sep}`)), false);
    });
  });

  it("parses YAML block-list tools/skills with indented - entries", async () => {
    const { parseMmrCustomSubagentMarkdown } = await importSource(LOADER_MODULE);
    const definition = parseMmrCustomSubagentMarkdown({
      filePath: path.join("/repo", "agents", "block-list.md"),
      markdown: [
        "---",
        "type: subagent",
        "name: Block Lister",
        "tools:",
        "  - read",
        "  - bash",
        "  - Write",
        "skills:",
        "  - audit",
        "  - review",
        "---",
        "Body",
      ].join("\n"),
    });
    assert.ok(definition);
    assert.deepEqual([...definition.toolPatterns], ["read", "bash", "write"]);
    assert.deepEqual([...definition.skills], ["audit", "review"]);
  });

  it("mixes block-list tools with inline skills (and vice versa)", async () => {
    const { parseMmrCustomSubagentMarkdown } = await importSource(LOADER_MODULE);
    const blockToolsInlineSkills = parseMmrCustomSubagentMarkdown({
      filePath: path.join("/repo", "agents", "mixed-a.md"),
      markdown: [
        "---",
        "type: subagent",
        "name: Mixed A",
        "tools:",
        "  - read",
        "  - bash",
        "skills: [audit, review]",
        "---",
        "",
      ].join("\n"),
    });
    assert.ok(blockToolsInlineSkills);
    assert.deepEqual([...blockToolsInlineSkills.toolPatterns], ["read", "bash"]);
    assert.deepEqual([...blockToolsInlineSkills.skills], ["audit", "review"]);

    const inlineToolsBlockSkills = parseMmrCustomSubagentMarkdown({
      filePath: path.join("/repo", "agents", "mixed-b.md"),
      markdown: [
        "---",
        "type: subagent",
        "name: Mixed B",
        "tools: read, bash",
        "skills:",
        "  - audit",
        "  - review",
        "---",
        "",
      ].join("\n"),
    });
    assert.ok(inlineToolsBlockSkills);
    assert.deepEqual([...inlineToolsBlockSkills.toolPatterns], ["read", "bash"]);
    assert.deepEqual([...inlineToolsBlockSkills.skills], ["audit", "review"]);
  });

  it("empty block-list parses as [] and does not swallow the next frontmatter key", async () => {
    const { parseMmrCustomSubagentMarkdown } = await importSource(LOADER_MODULE);
    const definition = parseMmrCustomSubagentMarkdown({
      filePath: path.join("/repo", "agents", "empty-block.md"),
      markdown: [
        "---",
        "type: subagent",
        "name: Empty Block",
        "tools:",
        "description: Stays as a real description.",
        "---",
        "",
      ].join("\n"),
    });
    assert.ok(definition);
    assert.deepEqual([...definition.toolPatterns], []);
    assert.equal(definition.toolsDeclared, true, "an empty `tools:` block still counts as a declared (but empty) tool list");
    assert.equal(definition.description, "Stays as a real description.");
  });

  it("marks toolsDeclared false when no tools field is present at all", async () => {
    const { parseMmrCustomSubagentMarkdown } = await importSource(LOADER_MODULE);
    const definition = parseMmrCustomSubagentMarkdown({
      filePath: path.join("/repo", "agents", "prompt-only.md"),
      markdown: [
        "---",
        "type: subagent",
        "name: Prompt Only",
        "description: Answers from its prompt only.",
        "---",
        "Respond using only the task prompt.",
      ].join("\n"),
    });
    assert.ok(definition);
    assert.deepEqual([...definition.toolPatterns], []);
    assert.equal(definition.toolsDeclared, false);
    assert.equal(definition.modelDeclared, false, "no model field -> not declared");
    assert.equal(definition.thinkingLevel, undefined);
  });

  it("parses thinkingLevel/thinking/effort aliases and ignores invalid levels", async () => {
    const { parseMmrCustomSubagentMarkdown } = await importSource(LOADER_MODULE);
    const make = (line) => parseMmrCustomSubagentMarkdown({
      filePath: path.join("/repo", "agents", "t.md"),
      markdown: ["---", "type: subagent", "name: T", "description: d", line, "---", "Body."].join("\n"),
    });
    assert.equal(make("thinkingLevel: high")?.thinkingLevel, "high");
    assert.equal(make("thinking: LOW")?.thinkingLevel, "low", "value is case-insensitive");
    assert.equal(make("effort: minimal")?.thinkingLevel, "minimal", "effort is an alias");
    assert.equal(make("thinkingLevel: ludicrous")?.thinkingLevel, undefined, "invalid level is ignored");
    assert.equal(make("model: inherit")?.thinkingLevel, undefined, "omitted -> undefined");
  });

  it("tolerates blank lines and comments inside a block-list", async () => {
    const { parseMmrCustomSubagentMarkdown } = await importSource(LOADER_MODULE);
    const definition = parseMmrCustomSubagentMarkdown({
      filePath: path.join("/repo", "agents", "comments.md"),
      markdown: [
        "---",
        "type: subagent",
        "name: Comments",
        "tools:",
        "  # search-shaped tools first",
        "  - read",
        "",
        "  - grep",
        "  # then shell",
        "  - bash",
        "---",
        "",
      ].join("\n"),
    });
    assert.ok(definition);
    assert.deepEqual([...definition.toolPatterns], ["read", "grep", "bash"]);
  });

  it("inline tools: read, bash continues to parse as a comma-separated list (regression)", async () => {
    const { parseMmrCustomSubagentMarkdown } = await importSource(LOADER_MODULE);
    const definition = parseMmrCustomSubagentMarkdown({
      filePath: path.join("/repo", "agents", "inline.md"),
      markdown: [
        "---",
        "type: subagent",
        "name: Inline",
        "tools: read, bash",
        "---",
        "",
      ].join("\n"),
    });
    assert.ok(definition);
    assert.deepEqual([...definition.toolPatterns], ["read", "bash"]);
  });

  it("can opt into markdown files without subagent frontmatter", async () => {
    const { parseMmrCustomSubagentMarkdown } = await importSource(LOADER_MODULE);
    const definition = parseMmrCustomSubagentMarkdown({
      filePath: path.join("/repo", "agents", "skill.md"),
      markdown: "Use this body.",
      allowMissingFrontmatter: true,
    });
    assert.ok(definition);
    assert.equal(definition.name, "agents");
    assert.equal(definition.toolName, "sa__agents");
    assert.equal(definition.description, "Custom subagent agents.");
    assert.equal(definition.systemPrompt, "Use this body.");
  });

  it("accepts Claude Code-style frontmatter with name/description/body and no type key", async () => {
    const { parseMmrCustomSubagentMarkdown } = await importSource(LOADER_MODULE);
    const definition = parseMmrCustomSubagentMarkdown({
      filePath: path.join("/repo", ".claude", "agents", "reviewer.md"),
      markdown: [
        "---",
        "name: Code Reviewer",
        "description: Reviews code changes.",
        "tools: Read, Grep, Glob",
        "---",
        "Review the diff.",
      ].join("\n"),
    });
    assert.ok(definition);
    assert.equal(definition.toolName, "sa__code_reviewer");
    assert.deepEqual([...definition.toolPatterns], ["read", "grep", "find"]);
  });

  it("does not include markdown files whose frontmatter does not mark them as a subagent, even with allowMissingFrontmatter", async () => {
    const { parseMmrCustomSubagentMarkdown } = await importSource(LOADER_MODULE);
    const definition = parseMmrCustomSubagentMarkdown({
      filePath: path.join("/repo", "agents", "unrelated.md"),
      markdown: [
        "---",
        "title: Some doc",
        "description: Not a subagent.",
        "---",
        "Body.",
      ].join("\n"),
      allowMissingFrontmatter: true,
    });
    assert.equal(definition, undefined);
  });

  it("fails closed on unsafe custom subagent tool requests", async () => {
    const { parseMmrCustomSubagentMarkdown } = await importSource(LOADER_MODULE);
    for (const tool of ["Task", "oracle", "start_task", "apply_patch", "mcp__repo__read", "sa__other"]) {
      const definition = parseMmrCustomSubagentMarkdown({
        filePath: path.join("/repo", ".claude", "agents", `${tool}.md`),
        markdown: [
          "---",
          "name: Unsafe",
          "description: Unsafe tool request.",
          `tools: read, ${tool}`,
          "---",
          "Body.",
        ].join("\n"),
      });
      assert.equal(definition, undefined, tool);
    }
  });

  it("drops prototype-polluting frontmatter keys without poisoning the attributes object", async () => {
    const { parseMmrCustomSubagentMarkdown } = await importSource(LOADER_MODULE);
    const definition = parseMmrCustomSubagentMarkdown({
      filePath: path.join("/repo", "agents", "hostile.md"),
      markdown: [
        "---",
        "type: subagent",
        "name: Hostile",
        "__proto__: polluted",
        "constructor: also-polluted",
        "prototype: still-polluted",
        "---",
        "Body.",
      ].join("\n"),
    });
    assert.ok(definition);
    // The polluting keys must not become own properties anywhere
    // observable, and the global Object prototype must not be modified.
    assert.equal({}.polluted, undefined);
    assert.equal(Object.prototype.polluted, undefined);
    // The valid subagent fields are still parsed.
    assert.equal(definition.name, "Hostile");
    assert.equal(definition.toolName, "sa__hostile");
  });

  it("skips markdown files that exceed the per-file byte cap during discovery", async () => {
    await withTempDir(async (root) => {
      const { discoverMmrCustomSubagents, MMR_CUSTOM_SUBAGENT_MAX_FILE_BYTES } =
        await importSource(LOADER_MODULE);
      assert.equal(MMR_CUSTOM_SUBAGENT_MAX_FILE_BYTES, 256 * 1024);
      const oversizedBody = "x".repeat(MMR_CUSTOM_SUBAGENT_MAX_FILE_BYTES + 1);
      await writeMarkdown(
        path.join(root, "agents", "too-big.md"),
        ["---", "type: subagent", "name: Too Big", "---", oversizedBody].join("\n"),
      );
      await writeMarkdown(
        path.join(root, "agents", "ok.md"),
        ["---", "type: subagent", "name: Ok", "---", "small body"].join("\n"),
      );
      const definitions = await discoverMmrCustomSubagents({ roots: [root] });
      assert.deepEqual(
        definitions.map((definition) => definition.toolName).sort(),
        ["sa__ok"],
      );
    });
  });

  it("bounds scanned markdown files before parsing definitions", async () => {
    await withTempDir(async (root) => {
      for (const name of ["a", "b", "c"]) {
        await writeMarkdown(
          path.join(root, "agents", `${name}.md`),
          ["---", `name: ${name}`, `description: ${name}`, "---", "body"].join("\n"),
        );
      }
      const { discoverMmrCustomSubagents, discoverMmrCustomSubagentsSync } = await importSource(LOADER_MODULE);
      const asyncDefinitions = await discoverMmrCustomSubagents({ roots: [root], maxFiles: 2 });
      const syncDefinitions = discoverMmrCustomSubagentsSync({ roots: [root], maxFiles: 2 });
      assert.equal(asyncDefinitions.length, 2);
      assert.deepEqual(syncDefinitions.map((definition) => definition.toolName), asyncDefinitions.map((definition) => definition.toolName));
    });
  });

  it("bounds registered definitions independently from scanned file count", async () => {
    await withTempDir(async (root) => {
      for (const name of ["a", "b", "c"]) {
        await writeMarkdown(
          path.join(root, "agents", `${name}.md`),
          ["---", `name: ${name}`, `description: ${name}`, "---", "body"].join("\n"),
        );
      }
      const { discoverMmrCustomSubagents, discoverMmrCustomSubagentsSync, DEFAULT_MMR_CUSTOM_SUBAGENT_MAX_DEFINITIONS, DEFAULT_MMR_CUSTOM_SUBAGENT_MAX_FILES } = await importSource(LOADER_MODULE);
      assert.equal(DEFAULT_MMR_CUSTOM_SUBAGENT_MAX_DEFINITIONS, 100);
      assert.equal(DEFAULT_MMR_CUSTOM_SUBAGENT_MAX_FILES, 1000);
      const asyncDefinitions = await discoverMmrCustomSubagents({ roots: [root], maxDefinitions: 1 });
      const syncDefinitions = discoverMmrCustomSubagentsSync({ roots: [root], maxDefinitions: 1 });
      assert.deepEqual(asyncDefinitions.map((definition) => definition.toolName), ["sa__a"]);
      assert.deepEqual(syncDefinitions.map((definition) => definition.toolName), ["sa__a"]);
    });
  });

  it("refuses to walk a symlinked discovery root", async () => {
    await withTempDir(async (real) => {
      await writeMarkdown(
        path.join(real, "agents", "only.md"),
        ["---", "type: subagent", "name: Only", "---", "body"].join("\n"),
      );
      await withTempDir(async (linkParent) => {
        const linkRoot = path.join(linkParent, "link");
        await symlink(real, linkRoot, "dir");
        const { discoverMmrCustomSubagents } = await importSource(LOADER_MODULE);
        const definitions = await discoverMmrCustomSubagents({ roots: [linkRoot] });
        assert.deepEqual(definitions, []);
      });
    });
  });
});
