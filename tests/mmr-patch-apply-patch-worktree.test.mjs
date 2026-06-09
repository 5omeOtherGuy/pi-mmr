import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, mkdirSync, rmSync, realpathSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { makeCtx, patch } from "./helpers/apply-patch.mjs";
import { createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

describe("mmr-patch apply_patch path safety extends to same-repo git worktrees", () => {
  let tmpRoot;
  let mainWt;
  let siblingWt;

  function git(cwd, ...args) {
    return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  }

  beforeEach(() => {
    tmpRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "pi-mmr-apply-patch-wt-")));
    mainWt = path.join(tmpRoot, "main");
    siblingWt = path.join(tmpRoot, "sibling");
    mkdirSync(mainWt);
    git(mainWt, "init", "-q");
    git(mainWt, "commit", "--allow-empty", "-q", "-m", "init");
    git(mainWt, "worktree", "add", "-q", "-b", "sibling", siblingWt);
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  async function getTool() {
    const toolbox = await importSource("extensions/mmr-patch/index.ts");
    const { pi } = createMockPi();
    toolbox.default(pi);
    return pi.tools.get("apply_patch");
  }

  async function runTool(patchText, cwd) {
    const tool = await getTool();
    return tool.execute("call-1", { patchText }, undefined, undefined, makeCtx(cwd));
  }

  it("accepts an absolute path that lands inside a sibling same-repo git worktree", async () => {
    await runTool(patch(
      "*** Begin Patch",
      `*** Add File: ${path.join(siblingWt, "created.txt")}`,
      "+hello from main wt",
      "*** End Patch",
    ), mainWt);
    assert.equal(readFileSync(path.join(siblingWt, "created.txt"), "utf8"), "hello from main wt\n");
  });

  it("accepts a relative ../sibling-worktree/... path when the sibling is a same-repo worktree", async () => {
    await runTool(patch(
      "*** Begin Patch",
      "*** Add File: ../sibling/created.txt",
      "+hello relative",
      "*** End Patch",
    ), mainWt);
    assert.equal(readFileSync(path.join(siblingWt, "created.txt"), "utf8"), "hello relative\n");
  });

  it("summary uses ../sibling/... relative form when patching a sibling worktree", async () => {
    const result = await runTool(patch(
      "*** Begin Patch",
      `*** Add File: ${path.join(siblingWt, "created.txt")}`,
      "+x",
      "*** End Patch",
    ), mainWt);
    const summary = result.details.summary;
    assert.match(summary, /add: \.\.\/sibling\/created\.txt \(\+1\/-0\)/);
  });

  it("rejects an absolute path that lands in an unrelated sibling directory (not a same-repo worktree)", async () => {
    const unrelated = realpathSync(mkdtempSync(path.join(tmpdir(), "pi-mmr-apply-patch-unrelated-")));
    try {
      await assert.rejects(
        () => runTool(patch(
          "*** Begin Patch",
          `*** Add File: ${path.join(unrelated, "leak.txt")}`,
          "+leak",
          "*** End Patch",
        ), mainWt),
        /outside|workspace|worktree/i,
      );
      assert.equal(existsSync(path.join(unrelated, "leak.txt")), false);
    } finally {
      rmSync(unrelated, { recursive: true, force: true });
    }
  });

  it("rejects a symlink escape from inside a sibling worktree", async () => {
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), "pi-mmr-apply-patch-out-")));
    try {
      symlinkSync(outside, path.join(siblingWt, "link"));
      await assert.rejects(
        () => runTool(patch(
          "*** Begin Patch",
          `*** Add File: ${path.join(siblingWt, "link", "leak.txt")}`,
          "+leak",
          "*** End Patch",
        ), mainWt),
        /outside|workspace|worktree|symlink/i,
      );
      assert.equal(existsSync(path.join(outside, "leak.txt")), false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("non-git temp workspace keeps cwd-only behavior (rejects sibling tmpdirs)", async () => {
    const nonGitWorkdir = realpathSync(mkdtempSync(path.join(tmpdir(), "pi-mmr-apply-patch-nogit-")));
    const sibling = realpathSync(mkdtempSync(path.join(tmpdir(), "pi-mmr-apply-patch-sibling-")));
    try {
      await assert.rejects(
        () => runTool(patch(
          "*** Begin Patch",
          `*** Add File: ${path.join(sibling, "leak.txt")}`,
          "+leak",
          "*** End Patch",
        ), nonGitWorkdir),
        /outside|workspace|worktree/i,
      );
      assert.equal(existsSync(path.join(sibling, "leak.txt")), false);
    } finally {
      rmSync(nonGitWorkdir, { recursive: true, force: true });
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  it("boundary error message includes current workspace, allowed worktree roots, and the rejected target", async () => {
    const unrelated = realpathSync(mkdtempSync(path.join(tmpdir(), "pi-mmr-apply-patch-msg-")));
    try {
      let err;
      try {
        await runTool(patch(
          "*** Begin Patch",
          `*** Add File: ${path.join(unrelated, "leak.txt")}`,
          "+leak",
          "*** End Patch",
        ), mainWt);
      } catch (e) {
        err = e;
      }
      assert.ok(err, "expected the boundary check to throw");
      const msg = String(err.message);
      assert.match(msg, new RegExp(`current workspace[^\\n]*${mainWt.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}`));
      assert.match(msg, /allowed worktree roots/i);
      assert.ok(msg.includes(siblingWt), `error message should list sibling worktree root; got: ${msg}`);
      assert.match(msg, /rejected target/i);
      assert.ok(msg.includes(path.join(unrelated, "leak.txt")), `error message should include the rejected target; got: ${msg}`);
    } finally {
      rmSync(unrelated, { recursive: true, force: true });
    }
  });
});

