import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const TOOLS_MODULE = "extensions/mmr-github/tools.ts";
const GLOB_MODULE = "extensions/mmr-github/glob.ts";

function settings(partial = {}) {
  return { enabled: true, token: undefined, apiBaseUrl: "https://api.github.test", requestTimeoutMs: 1000, maxResultBytes: 200000, ...partial };
}

function fakeClient(overrides = {}) {
  const calls = [];
  const record = (name) => (...args) => { calls.push({ name, args }); const fn = overrides[name]; if (!fn) throw new Error(`unexpected client call: ${name}`); return fn(...args); };
  return {
    calls,
    client: {
      getRepo: record("getRepo"),
      getContents: record("getContents"),
      getTree: record("getTree"),
      searchCode: record("searchCode"),
      searchCommits: record("searchCommits"),
      listCommits: record("listCommits"),
      compare: record("compare"),
      searchRepositories: record("searchRepositories"),
      listAccessibleRepositories: record("listAccessibleRepositories"),
    },
  };
}

async function makeTool(factoryName, clientOverrides = {}, settingsPartial = {}) {
  const mod = await importSource(TOOLS_MODULE);
  const fc = fakeClient(clientOverrides);
  const tool = mod[factoryName]({ getSettings: () => settings(settingsPartial), createClient: () => fc.client });
  return { tool, fc, mod };
}

function text(result) {
  return result.content.find((e) => e.type === "text")?.text ?? "";
}

describe("mmr-github tool schemas", () => {
  it("read_github requires repository + path with optional read_range", async () => {
    const { mod } = await makeTool("createReadGithubTool");
    const schema = mod.READ_GITHUB_PARAMETERS_SCHEMA;
    assert.deepEqual(schema.required, ["repository", "path"]);
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties.read_range.type, "array");
  });

  it("every factory yields a definition with read-only guidelines and no mutation surface", async () => {
    const mod = await importSource(TOOLS_MODULE);
    const factories = ["createReadGithubTool", "createListDirectoryGithubTool", "createGlobGithubTool", "createSearchGithubTool", "createCommitSearchTool", "createDiffGithubTool", "createListRepositoriesTool"];
    const deps = { getSettings: () => settings() };
    const names = factories.map((f) => mod[f]({ ...deps, createClient: () => fakeClient().client }).name);
    assert.deepEqual(names, ["read_github", "list_directory_github", "glob_github", "search_github", "commit_search", "diff_github", "list_repositories"]);
    for (const f of factories) {
      const tool = mod[f]({ ...deps, createClient: () => fakeClient().client });
      assert.ok(tool.promptGuidelines.some((g) => /read-only/i.test(g)), `${tool.name} must carry the read-only guideline`);
    }
  });
});

describe("read_github", () => {
  it("formats a file with line numbers and applies read_range", async () => {
    const { tool } = await makeTool("createReadGithubTool", {
      getContents: async () => ({ kind: "file", path: "src/a.ts", size: 20, encoding: "base64", text: "a\nb\nc\nd", truncated: false }),
    });
    const result = await tool.execute("c", { repository: "acme/repo", path: "src/a.ts", read_range: [2, 3] }, undefined);
    assert.match(text(result), /2: b\n3: c/);
    assert.doesNotMatch(text(result), /1: a/);
  });

  it("returns a directory listing when the path is a directory (dirs first)", async () => {
    const { tool } = await makeTool("createReadGithubTool", {
      getContents: async () => ({ kind: "directory", path: "src", entries: [{ name: "z.ts", type: "file" }, { name: "sub", type: "dir" }] }),
    });
    const result = await tool.execute("c", { repository: "acme/repo", path: "src" }, undefined);
    assert.match(text(result), /sub\//);
    assert.match(text(result), /z\.ts/);
  });

  it("pages a directory listing with read_range and omitted markers", async () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({ name: `f${i}.ts`, type: "file" }));
    const { tool } = await makeTool("createReadGithubTool", {
      getContents: async () => ({ kind: "directory", path: "", entries }),
    });
    const result = await tool.execute("c", { repository: "acme/repo", path: "", read_range: [3, 5] }, undefined);
    assert.match(text(result), /\[\.\.\. omitted 2 entries \.\.\.\]/);
    assert.match(text(result), /\[\.\.\. omitted 5 more \.\.\.\]/);
  });

  it("reads a large file when read_range selects a slice under the output gate", async () => {
    // 4000 lines (~32 KB) total: too large to return whole, but a small
    // read_range must succeed because the slice is gated, not the whole file.
    const bigFile = Array.from({ length: 4000 }, (_, i) => `line ${i + 1} ${"x".repeat(30)}`).join("\n");
    const { tool } = await makeTool("createReadGithubTool", {
      getContents: async () => ({ kind: "file", path: "big.txt", size: bigFile.length, encoding: "base64", text: bigFile, truncated: false }),
    });
    const sliced = await tool.execute("c", { repository: "acme/repo", path: "big.txt", read_range: [10, 12] }, undefined);
    assert.match(text(sliced), /10: line 10/);
    assert.match(text(sliced), /12: line 12/);
    assert.doesNotMatch(text(sliced), /too large/);
  });

  it("rejects a read_range slice that still exceeds the output byte gate and reports total lines", async () => {
    const huge = Array.from({ length: 5000 }, () => "y".repeat(40)).join("\n");
    const { tool } = await makeTool("createReadGithubTool", {
      getContents: async () => ({ kind: "file", path: "huge.txt", size: huge.length, encoding: "base64", text: huge, truncated: false }),
    });
    const result = await tool.execute("c", { repository: "acme/repo", path: "huge.txt", read_range: [1, 5000] }, undefined);
    assert.match(text(result), /file is too large/);
    assert.match(text(result), /5000 lines/);
    assert.match(text(result), /smaller read_range/);
  });

  it("reports a file that exceeds the contents API inline ceiling as too large", async () => {
    const { tool } = await makeTool("createReadGithubTool", {
      getContents: async () => ({ kind: "file", path: "blob.bin", size: 2_000_000, encoding: "none", text: "", truncated: true }),
    });
    const result = await tool.execute("c", { repository: "acme/repo", path: "blob.bin" }, undefined);
    assert.match(text(result), /too large for the contents API/);
  });

  it("surfaces a repository parse error", async () => {
    const { tool } = await makeTool("createReadGithubTool", {});
    const result = await tool.execute("c", { repository: "https://github.com/search?q=x", path: "a" }, undefined);
    assert.match(text(result), /read_github:/);
    assert.equal(result.details.error !== undefined, true);
  });
});

describe("list_directory_github", () => {
  it("rejects a file path", async () => {
    const { tool } = await makeTool("createListDirectoryGithubTool", {
      getContents: async () => ({ kind: "file", path: "a.ts", size: 1, encoding: "base64", text: "x", truncated: false }),
    });
    const result = await tool.execute("c", { repository: "acme/repo", path: "a.ts" }, undefined);
    assert.match(text(result), /is a file, not a directory/);
  });

  it("applies the limit and reports how many of the total entries were shown", async () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({ name: `f${i}.ts`, path: `f${i}.ts`, type: "file" }));
    const { tool } = await makeTool("createListDirectoryGithubTool", {
      getContents: async () => ({ kind: "directory", path: "", entries }),
    });
    const result = await tool.execute("c", { repository: "acme/repo", limit: 3 }, undefined);
    assert.match(text(result), /showing 3 of 10 entries/);
    assert.equal(result.details.returned, 3);
    assert.equal(result.details.count, 10);
  });
});

describe("glob_github", () => {
  it("matches files by filePattern and paginates", async () => {
    const { tool } = await makeTool("createGlobGithubTool", {
      getTree: async () => ({ ref: "main", truncated: false, entries: [
        { path: "src/a.ts", type: "blob" }, { path: "src/b.ts", type: "blob" }, { path: "src/c.js", type: "blob" }, { path: "src", type: "tree" },
      ] }),
    });
    const result = await tool.execute("c", { repository: "acme/repo", filePattern: "src/*.ts", limit: 1, offset: 0 }, undefined);
    assert.match(text(result), /src\/a\.ts/);
    assert.doesNotMatch(text(result), /c\.js/);
    assert.equal(result.details.matches, 2);
    assert.equal(result.details.returned, 1);
  });

  it("supports brace alternation across the tree", async () => {
    const { tool } = await makeTool("createGlobGithubTool", {
      getTree: async () => ({ ref: "main", truncated: false, entries: [
        { path: "a.js", type: "blob" }, { path: "b.ts", type: "blob" }, { path: "c.md", type: "blob" },
      ] }),
    });
    const result = await tool.execute("c", { repository: "acme/repo", filePattern: "**/*.{js,ts}" }, undefined);
    assert.match(text(result), /a\.js/);
    assert.match(text(result), /b\.ts/);
    assert.doesNotMatch(text(result), /c\.md/);
  });

  it("hard-fails when the repository tree is truncated", async () => {
    const { tool } = await makeTool("createGlobGithubTool", {
      getTree: async () => ({ ref: "main", truncated: true, entries: [] }),
    });
    const result = await tool.execute("c", { repository: "acme/repo", filePattern: "**/*.ts" }, undefined);
    assert.match(text(result), /tree is too large/);
  });

  it("returns a clear glob-syntax error result (does not throw) for a malformed class", async () => {
    const { tool } = await makeTool("createGlobGithubTool", {
      getTree: async () => ({ ref: "main", truncated: false, entries: [{ path: "src/a.ts", type: "blob" }] }),
    });
    const result = await tool.execute("c", { repository: "acme/repo", filePattern: "src/[z-a].ts" }, undefined);
    assert.match(text(result), /glob_github: unsupported glob pattern/);
    assert.equal(result.details.error !== undefined, true);
    assert.doesNotMatch(text(result), /Invalid regular expression/i);
  });
});

describe("mmr-github error convention", () => {
  it("returns error-shaped results (details.error) rather than throwing across failure paths", async () => {
    // Invalid params via coerce (non-object).
    const glob = await makeTool("createGlobGithubTool", {});
    const badParams = await glob.tool.execute("c", "not-an-object", undefined);
    assert.equal(badParams.details.error !== undefined, true);
    assert.match(text(badParams), /glob_github:/);

    // Repository parse error.
    const parse = await makeTool("createReadGithubTool", {});
    const badRepo = await parse.tool.execute("c", { repository: "https://github.com/search?q=x", path: "a" }, undefined);
    assert.equal(badRepo.details.error !== undefined, true);
    assert.match(text(badRepo), /read_github:/);

    // Malformed glob.
    const glob2 = await makeTool("createGlobGithubTool", {
      getTree: async () => ({ ref: "main", truncated: false, entries: [{ path: "a.ts", type: "blob" }] }),
    });
    const badGlob = await glob2.tool.execute("c", { repository: "acme/repo", filePattern: "[z-a]" }, undefined);
    assert.equal(badGlob.details.error !== undefined, true);
    assert.match(text(badGlob), /glob_github: unsupported glob pattern/);
  });
});

describe("search_github", () => {
  it("builds a repo-qualified query, validates offset, and groups results", async () => {
    const { tool, fc } = await makeTool("createSearchGithubTool", {
      searchCode: async (q, opts) => ({ totalCount: 1, incompleteResults: false, items: [{ path: "src/a.ts", htmlUrl: "https://github.com/acme/repo/blob/main/src/a.ts", repository: "acme/repo", fragments: ["const x = 1"] }] }),
    });
    const result = await tool.execute("c", { repository: "acme/repo", pattern: "x", path: "src", limit: 10, offset: 10 }, undefined);
    assert.match(fc.calls[0].args[0], /x repo:acme\/repo path:src/);
    assert.equal(fc.calls[0].args[1].page, 2);
    assert.match(text(result), /const x = 1/);
  });

  it("rejects an offset that is not a multiple of limit", async () => {
    const { tool } = await makeTool("createSearchGithubTool", { searchCode: async () => ({ totalCount: 0, incompleteResults: false, items: [] }) });
    const result = await tool.execute("c", { repository: "acme/repo", pattern: "x", limit: 10, offset: 5 }, undefined);
    assert.match(text(result), /must be a multiple of limit/);
  });

  it("truncates long context fragments", async () => {
    const longFrag = "z".repeat(3000);
    const { tool } = await makeTool("createSearchGithubTool", {
      searchCode: async () => ({ totalCount: 1, incompleteResults: false, items: [{ path: "a.ts", htmlUrl: "u", repository: "acme/repo", fragments: [longFrag] }] }),
    });
    const result = await tool.execute("c", { repository: "acme/repo", pattern: "z" }, undefined);
    assert.match(text(result), /\.\.\. \(truncated\)/);
  });
});

describe("commit_search", () => {
  it("uses search mode with a query and list mode without", async () => {
    const { tool: searchTool, fc: searchFc } = await makeTool("createCommitSearchTool", {
      searchCommits: async () => ({ totalCount: 1, items: [{ sha: "abcdef1234567890", message: "fix bug", author: "Dev", date: "2024-01-01", htmlUrl: "u" }] }),
    });
    const searchResult = await searchTool.execute("c", { repository: "acme/repo", query: "bug", author: "dev" }, undefined);
    assert.match(searchFc.calls[0].args[0], /bug repo:acme\/repo author:dev/);
    assert.match(text(searchResult), /fix bug/);
    assert.equal(searchResult.details.mode, "search");

    const { tool: listTool, fc: listFc } = await makeTool("createCommitSearchTool", {
      listCommits: async () => [{ sha: "0011223344", message: "init", author: "Dev", date: "2024-01-01", htmlUrl: "u" }],
    });
    const listResult = await listTool.execute("c", { repository: "acme/repo", path: "src" }, undefined);
    assert.equal(listFc.calls[0].args[1].path, "src");
    assert.equal(listResult.details.mode, "list");
  });

  it("uses author-date qualifiers in search mode", async () => {
    const { tool, fc } = await makeTool("createCommitSearchTool", {
      searchCommits: async () => ({ totalCount: 0, items: [] }),
    });
    await tool.execute("c", { repository: "acme/repo", query: "bug", since: "2024-01-01", until: "2024-02-01" }, undefined);
    assert.match(fc.calls[0].args[0], /author-date:>=2024-01-01/);
    assert.match(fc.calls[0].args[0], /author-date:<=2024-02-01/);
  });

  it("routes query+path to a client-side filtered listing", async () => {
    const commits = [
      { sha: "1", message: "fix login", author: "Ann", authorEmail: "ann@e", date: "", htmlUrl: "" },
      { sha: "2", message: "update docs", author: "Bob", authorEmail: "bob@e", date: "", htmlUrl: "" },
    ];
    const { tool, fc } = await makeTool("createCommitSearchTool", { listCommits: async () => commits });
    const result = await tool.execute("c", { repository: "acme/repo", query: "login", path: "src" }, undefined);
    assert.equal(fc.calls[0].name, "listCommits");
    assert.match(text(result), /fix login/);
    assert.doesNotMatch(text(result), /update docs/);
  });
});

describe("diff_github", () => {
  it("renders changed files and filters to a single path", async () => {
    const { tool } = await makeTool("createDiffGithubTool", {
      compare: async () => ({ base: "main", head: "feat", status: "ahead", aheadBy: 1, behindBy: 0, totalCommits: 1, files: [
        { filename: "a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "@@ a @@" },
        { filename: "b.ts", status: "added", additions: 5, deletions: 0, changes: 5, patch: "@@ b @@" },
      ] }),
    });
    const all = await tool.execute("c", { repository: "acme/repo", base: "main", head: "feat" }, undefined);
    assert.equal(all.details.files, 2);
    const one = await tool.execute("c", { repository: "acme/repo", base: "main", head: "feat", path: "b.ts" }, undefined);
    assert.equal(one.details.files, 1);
    assert.match(text(one), /b\.ts/);
    assert.doesNotMatch(text(one), /## a\.ts/);
  });

  it("omits patches by default and includes truncated patches when requested", async () => {
    const bigPatch = "@@ x".repeat(2000); // > 4096 chars
    const compare = async () => ({ base: "main", head: "feat", status: "ahead", aheadBy: 1, behindBy: 0, totalCommits: 1, files: [{ filename: "a.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: bigPatch }] });
    const { tool: noPatch } = await makeTool("createDiffGithubTool", { compare });
    const r1 = await noPatch.execute("c", { repository: "acme/repo", base: "main", head: "feat" }, undefined);
    assert.doesNotMatch(text(r1), /```diff/);
    assert.equal(r1.details.includePatches, false);

    const { tool: withPatch } = await makeTool("createDiffGithubTool", { compare });
    const r2 = await withPatch.execute("c", { repository: "acme/repo", base: "main", head: "feat", includePatches: true }, undefined);
    assert.match(text(r2), /```diff/);
    assert.match(text(r2), /\.\.\. \[truncated\]/);
  });
});

describe("list_repositories", () => {
  const repo = (name, extra = {}) => ({ fullName: name, description: "d", htmlUrl: "u", defaultBranch: "main", language: "TS", stars: 3, forks: 1, isPrivate: false, isFork: false, isArchived: false, pushedAt: "", ...extra });

  it("prioritizes accessible repos, filters by pattern/org/language, and over-fetches", async () => {
    const { tool, fc } = await makeTool("createListRepositoriesTool", {
      listAccessibleRepositories: async () => [
        repo("acme/api", { language: "TS", stars: 5 }),
        repo("acme/web", { language: "Go", stars: 9 }),
        repo("other/api", { language: "TS", stars: 1 }),
      ],
      searchRepositories: async () => ({ totalCount: 0, items: [] }),
    });
    const result = await tool.execute("c", { pattern: "api", organization: "acme", language: "TS", limit: 5 }, undefined);
    // over-fetch = limit*5
    assert.equal(fc.calls[0].args[0].perPage, 25);
    assert.match(text(result), /acme\/api/);
    assert.doesNotMatch(text(result), /acme\/web/);
    assert.doesNotMatch(text(result), /other\/api/);
  });

  it("supplements with public search when accessible results are short and dedups by full name", async () => {
    const { tool, fc } = await makeTool("createListRepositoriesTool", {
      listAccessibleRepositories: async () => [repo("acme/api")],
      searchRepositories: async () => ({ totalCount: 2, items: [repo("acme/api"), repo("public/api")] }),
    });
    const result = await tool.execute("c", { pattern: "api", limit: 5 }, undefined);
    assert.match(fc.calls[1].args[0], /api in:name/);
    assert.match(text(result), /public\/api/);
    // acme/api appears once (deduped)
    assert.equal(text(result).match(/acme\/api/g).length, 1);
  });

  it("falls back to public search when accessible enumeration is unauthorized (no token)", async () => {
    const mod = await importSource(TOOLS_MODULE);
    const { GithubApiError } = await importSource("extensions/mmr-github/client.ts");
    const fc = fakeClient({
      listAccessibleRepositories: () => { throw new GithubApiError("auth failed", 401); },
      searchRepositories: async () => ({ totalCount: 1, items: [repo("public/api")] }),
    });
    const tool = mod.createListRepositoriesTool({ getSettings: () => settings(), createClient: () => fc.client });
    const result = await tool.execute("c", { pattern: "api" }, undefined);
    assert.match(text(result), /public\/api/);
  });

  it("rejects an offset that is not a multiple of limit", async () => {
    const { tool } = await makeTool("createListRepositoriesTool", {});
    const result = await tool.execute("c", { pattern: "api", limit: 10, offset: 5 }, undefined);
    assert.match(text(result), /must be a multiple of limit/);
  });
});

describe("registerMmrGithubTools", () => {
  it("registers nothing when disabled", async () => {
    const mod = await importSource(TOOLS_MODULE);
    const registered = [];
    const pi = { registerTool: (t) => registered.push(t.name) };
    const result = mod.registerMmrGithubTools(pi, { getSettings: () => settings({ enabled: false }) }, "/virtual/mmr-github/index.ts");
    assert.deepEqual(result.registered, []);
    assert.deepEqual(registered, []);
  });

  it("registers all 7 read-only tools and records the source path when enabled", async () => {
    const mod = await importSource(TOOLS_MODULE);
    const ownership = await importSource("extensions/mmr-github/tool-ownership.ts");
    ownership.__resetMmrGithubToolSourcePathsForTests();
    const registered = [];
    const pi = { registerTool: (t) => registered.push(t.name) };
    const result = mod.registerMmrGithubTools(pi, { getSettings: () => settings({ enabled: true }), createClient: () => fakeClient().client }, "/virtual/mmr-github/index.ts");
    assert.deepEqual(result.registered.sort(), ["commit_search", "diff_github", "glob_github", "list_directory_github", "list_repositories", "read_github", "search_github"]);
    assert.equal(registered.length, 7);
    assert.ok(ownership.getMmrGithubToolSourcePaths().includes("/virtual/mmr-github/index.ts"));
  });
});

describe("glob matcher", () => {
  it("supports *, **, and ? anchored to the full path", async () => {
    const { matchGlob } = await importSource(GLOB_MODULE);
    assert.equal(matchGlob("*.ts", "a.ts"), true);
    assert.equal(matchGlob("*.ts", "src/a.ts"), false);
    assert.equal(matchGlob("src/**/*.ts", "src/a.ts"), true);
    assert.equal(matchGlob("src/**/*.ts", "src/x/y/a.ts"), true);
    assert.equal(matchGlob("src/?.ts", "src/a.ts"), true);
    assert.equal(matchGlob("src/?.ts", "src/ab.ts"), false);
    assert.equal(matchGlob("a.ts", "a.tsx"), false);
  });

  it("supports brace alternation and character classes", async () => {
    const { matchGlob } = await importSource(GLOB_MODULE);
    assert.equal(matchGlob("**/*.{js,ts}", "src/a.js"), true);
    assert.equal(matchGlob("**/*.{js,ts}", "a.ts"), true);
    assert.equal(matchGlob("**/*.{js,ts}", "src/a.md"), false);
    assert.equal(matchGlob("src/[a-z]*.ts", "src/abc.ts"), true);
    assert.equal(matchGlob("src/[a-z]*.ts", "src/Abc.ts"), false);
  });

  it("supports negated character classes via ! and ^", async () => {
    const { matchGlob } = await importSource(GLOB_MODULE);
    // `!` and `^` both negate: match a single char NOT in the class.
    assert.equal(matchGlob("src/[!a-z].ts", "src/A.ts"), true);
    assert.equal(matchGlob("src/[!a-z].ts", "src/b.ts"), false);
    assert.equal(matchGlob("src/[^0-9].ts", "src/a.ts"), true);
    assert.equal(matchGlob("src/[^0-9].ts", "src/5.ts"), false);
  });

  it("throws a typed glob error for a reversed character-class range without leaking regex text", async () => {
    const { matchGlob, globToRegExp, GlobPatternError } = await importSource(GLOB_MODULE);
    for (const compile of [() => globToRegExp("src/[z-a].ts"), () => matchGlob("src/[z-a].ts", "src/a.ts")]) {
      assert.throws(compile, (err) => {
        assert.ok(err instanceof GlobPatternError, "expected a GlobPatternError");
        assert.ok(/\[z-a\]|z-a/.test(err.message), "message should name the offending pattern");
        assert.doesNotMatch(err.message, /Invalid regular expression/i);
        assert.doesNotMatch(err.message, /\^\.\*\$|\/\^/);
        return true;
      });
    }
  });

  it("rejects an empty character class as unsupported", async () => {
    const { globToRegExp, GlobPatternError } = await importSource(GLOB_MODULE);
    assert.throws(() => globToRegExp("src/[].ts"), (err) => {
      assert.ok(err instanceof GlobPatternError);
      assert.match(err.message, /empty/i);
      assert.doesNotMatch(err.message, /Invalid regular expression/i);
      return true;
    });
  });

  it("rejects class characters outside the documented subset", async () => {
    const { globToRegExp, GlobPatternError } = await importSource(GLOB_MODULE);
    assert.throws(() => globToRegExp("src/[a&b].ts"), (err) => {
      assert.ok(err instanceof GlobPatternError);
      assert.doesNotMatch(err.message, /Invalid regular expression/i);
      return true;
    });
  });
});
