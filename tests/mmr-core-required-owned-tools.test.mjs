// Generic owner-scoped owned-tools contract.
//
// mmr-core gates owner-specific subagent tools (e.g. librarian's repo tools
// owned by mmr-github) WITHOUT importing the owning sibling extension. The
// owner declares its entrypoint source path through
// `registerMmrOwnedToolSourcePath`, the profile declares `requiredOwnedTools`,
// and activation validates fail-closed via `hasOwnedToolsFromOwner`.

import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const OWNED_TOOLS_MODULE = "extensions/mmr-core/owned-tools.ts";
const GITHUB_MODULE = "extensions/mmr-github/tool-ownership.ts";
const PROFILES_MODULE = "extensions/mmr-core/subagent-profiles.ts";

const OWNER = "mmr-github";
const OWNER_PATH = "/virtual/pi-mmr/extensions/mmr-github/index.ts";
const NAMES = ["read_github", "search_github"];

function toolInfos(names, sourcePath) {
  return names.map((name) => ({
    name,
    ...(sourcePath === null ? {} : { sourceInfo: { path: sourcePath } }),
  }));
}

async function freshRegistry() {
  const mod = await importSource(OWNED_TOOLS_MODULE);
  mod.__resetMmrOwnedToolSourcePathsForTests();
  return mod;
}

describe("owner-scoped owned-tools registry", () => {
  beforeEach(async () => {
    await freshRegistry();
  });

  it("matches only when every required tool is present and owned by the owner", async () => {
    const { registerMmrOwnedToolSourcePath, hasOwnedToolsFromOwner, getMmrOwnedToolSourcePaths } =
      await importSource(OWNED_TOOLS_MODULE);
    registerMmrOwnedToolSourcePath(OWNER, OWNER_PATH);
    assert.deepEqual(getMmrOwnedToolSourcePaths(OWNER), [OWNER_PATH]);
    assert.equal(hasOwnedToolsFromOwner(OWNER, NAMES, toolInfos(NAMES, OWNER_PATH)), true);
  });

  it("fails closed for missing source metadata, third-party paths, and absent tools", async () => {
    const { registerMmrOwnedToolSourcePath, hasOwnedToolsFromOwner } = await importSource(OWNED_TOOLS_MODULE);
    registerMmrOwnedToolSourcePath(OWNER, OWNER_PATH);
    // missing sourceInfo
    assert.equal(hasOwnedToolsFromOwner(OWNER, NAMES, toolInfos(NAMES, null)), false);
    // third-party source path
    assert.equal(hasOwnedToolsFromOwner(OWNER, NAMES, toolInfos(NAMES, "/virtual/other/index.ts")), false);
    // one required tool absent
    assert.equal(hasOwnedToolsFromOwner(OWNER, NAMES, toolInfos(["read_github"], OWNER_PATH)), false);
  });

  it("fails closed when the owner has no registered paths or the requirement is empty", async () => {
    const { registerMmrOwnedToolSourcePath, hasOwnedToolsFromOwner } = await importSource(OWNED_TOOLS_MODULE);
    // no paths registered for owner
    assert.equal(hasOwnedToolsFromOwner(OWNER, NAMES, toolInfos(NAMES, OWNER_PATH)), false);
    registerMmrOwnedToolSourcePath(OWNER, OWNER_PATH);
    // empty requirement is never vacuously satisfied
    assert.equal(hasOwnedToolsFromOwner(OWNER, [], []), false);
  });

  it("ignores empty owner/path registrations", async () => {
    const { registerMmrOwnedToolSourcePath, getMmrOwnedToolSourcePaths } = await importSource(OWNED_TOOLS_MODULE);
    registerMmrOwnedToolSourcePath("", OWNER_PATH);
    registerMmrOwnedToolSourcePath(OWNER, "   ");
    assert.deepEqual(getMmrOwnedToolSourcePaths(OWNER), []);
  });
});

describe("mmr-github mirrors source paths into the core owner registry", () => {
  beforeEach(async () => {
    await freshRegistry();
  });

  it("registerMmrGithubToolSourcePath populates owner \"mmr-github\"", async () => {
    const { registerMmrGithubToolSourcePath, MMR_GITHUB_TOOL_OWNER } = await importSource(GITHUB_MODULE);
    const { getMmrOwnedToolSourcePaths } = await importSource(OWNED_TOOLS_MODULE);
    assert.equal(MMR_GITHUB_TOOL_OWNER, OWNER);
    registerMmrGithubToolSourcePath(OWNER_PATH);
    assert.deepEqual(getMmrOwnedToolSourcePaths(OWNER), [OWNER_PATH]);
  });
});

describe("librarian profile declares mmr-github owned-tool requirements", () => {
  it("requires the seven repo tools owned by mmr-github", async () => {
    const { getMmrSubagentProfile } = await importSource(PROFILES_MODULE);
    const librarian = getMmrSubagentProfile("librarian");
    assert.ok(librarian, "librarian profile exists");
    assert.ok(Array.isArray(librarian.requiredOwnedTools) && librarian.requiredOwnedTools.length === 1);
    const group = librarian.requiredOwnedTools[0];
    assert.equal(group.owner, "mmr-github");
    assert.deepEqual([...group.toolNames].sort(), [...librarian.tools].sort());
    assert.match(group.description, /mmr-github-owned read-only GitHub tools/);
    assert.match(group.unmetHint, /MMR_GITHUB_ENABLE=true/);
  });
});
