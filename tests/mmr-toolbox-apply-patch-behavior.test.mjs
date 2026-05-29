import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { makeCtx, patch } from "./helpers/apply-patch.mjs";
import { createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

describe("mmr-toolbox apply_patch tool behavior", () => {
  let workdir;
  beforeEach(() => {
    workdir = mkdtempSync(path.join(tmpdir(), "pi-mmr-apply-patch-"));
  });
  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  async function getTool() {
    const toolbox = await importSource("extensions/mmr-toolbox/index.ts");
    const { pi } = createMockPi();
    toolbox.default(pi);
    return pi.tools.get("apply_patch");
  }

  async function runTool(patchText, cwd) {
    const tool = await getTool();
    return tool.execute("call-1", { patchText }, undefined, undefined, makeCtx(cwd));
  }

  it("applies a simple Update File hunk by context match", async () => {
    const target = path.join(workdir, "file.txt");
    writeFileSync(target, "alpha\nbeta\ngamma\n");
    const result = await runTool(patch(
      "*** Begin Patch",
      "*** Update File: file.txt",
      "@@",
      " alpha",
      "-beta",
      "+BETA",
      " gamma",
      "*** End Patch",
    ), workdir);
    assert.equal(readFileSync(target, "utf8"), "alpha\nBETA\ngamma\n");
    assert.ok(Array.isArray(result.content) && result.content.length > 0);
  });

  it("creates a new file via Add File", async () => {
    await runTool(patch(
      "*** Begin Patch",
      "*** Add File: created.txt",
      "+hello",
      "+world",
      "*** End Patch",
    ), workdir);
    assert.equal(readFileSync(path.join(workdir, "created.txt"), "utf8"), "hello\nworld\n");
  });

  it("Add File supports '\\ No newline at end of file' to create a file without a trailing newline", async () => {
    // The unified-diff machinery already round-trips the no-trailing-
    // newline marker on update-side hunks. Extending the Add File grammar
    // to recognize a trailing `\ No newline at end of file` line lets a
    // patch create a file without a final newline, mirroring update
    // semantics so add->update round-trips don't spuriously change the
    // trailing-newline marker.
    await runTool(patch(
      "*** Begin Patch",
      "*** Add File: no-nl.txt",
      "+hello",
      "+world",
      "\\ No newline at end of file",
      "*** End Patch",
    ), workdir);
    assert.equal(readFileSync(path.join(workdir, "no-nl.txt"), "utf8"), "hello\nworld");
  });

  it("creates a new file in a nested directory", async () => {
    await runTool(patch(
      "*** Begin Patch",
      "*** Add File: nested/dir/created.txt",
      "+content",
      "*** End Patch",
    ), workdir);
    assert.equal(readFileSync(path.join(workdir, "nested/dir/created.txt"), "utf8"), "content\n");
  });

  it("deletes an existing file via Delete File", async () => {
    const target = path.join(workdir, "gone.txt");
    writeFileSync(target, "bye\n");
    await runTool(patch(
      "*** Begin Patch",
      "*** Delete File: gone.txt",
      "*** End Patch",
    ), workdir);
    assert.equal(existsSync(target), false);
  });

  it("renames a file via Update File + Move to:", async () => {
    const oldPath = path.join(workdir, "old.txt");
    const newPath = path.join(workdir, "renamed.txt");
    writeFileSync(oldPath, "alpha\nbeta\ngamma\n");
    await runTool(patch(
      "*** Begin Patch",
      "*** Update File: old.txt",
      "*** Move to: renamed.txt",
      "@@",
      " alpha",
      "-beta",
      "+BETA",
      " gamma",
      "*** End Patch",
    ), workdir);
    assert.equal(existsSync(oldPath), false);
    assert.equal(readFileSync(newPath, "utf8"), "alpha\nBETA\ngamma\n");
  });

  it("supports multiple consecutive @@ headers within one hunk for scope narrowing", async () => {
    const target = path.join(workdir, "f.py");
    writeFileSync(
      target,
      [
        "class Foo:",
        "    def helper(self):",
        "        return 1",
        "    def target(self):",
        "        return 'old'",
        "",
        "class Bar:",
        "    def helper(self):",
        "        return 1",
        "    def target(self):",
        "        return 'old'",
        "",
      ].join("\n"),
    );
    // Two `@@` lines in a single hunk: first narrows to `class Bar:`, second
    // narrows to `def target(self):` within it. Without consecutive-header
    // narrowing, the body's `return 'old'` would match in two places.
    await runTool(patch(
      "*** Begin Patch",
      "*** Update File: f.py",
      "@@ class Bar:",
      "@@ def target(self):",
      "-        return 'old'",
      "+        return 'new'",
      "*** End Patch",
    ), workdir);
    assert.equal(
      readFileSync(target, "utf8"),
      [
        "class Foo:",
        "    def helper(self):",
        "        return 1",
        "    def target(self):",
        "        return 'old'",
        "",
        "class Bar:",
        "    def helper(self):",
        "        return 1",
        "    def target(self):",
        "        return 'new'",
        "",
      ].join("\n"),
    );
  });

  it("falls back to body matching when an @@ header anchor is not present in the file", async () => {
    const target = path.join(workdir, "f.txt");
    writeFileSync(target, "alpha\nbeta\ngamma\n");
    // The `@@ does not exist` anchor is missing from the file, but the body
    // context is unique on its own — apply must fall back to body matching
    // rather than failing on the missing anchor.
    await runTool(patch(
      "*** Begin Patch",
      "*** Update File: f.txt",
      "@@ does not exist",
      " alpha",
      "-beta",
      "+BETA",
      " gamma",
      "*** End Patch",
    ), workdir);
    assert.equal(readFileSync(target, "utf8"), "alpha\nBETA\ngamma\n");
  });

  it("supports an insert-only hunk anchored by an @@ header", async () => {
    const target = path.join(workdir, "f.py");
    writeFileSync(target, "class Foo:\n    pass\n\nclass Bar:\n    pass\n");
    // No context lines, only an add — must insert immediately after the line
    // matched by the `@@ class Bar:` anchor.
    await runTool(patch(
      "*** Begin Patch",
      "*** Update File: f.py",
      "@@ class Bar:",
      "+    inserted = True",
      "*** End Patch",
    ), workdir);
    assert.equal(
      readFileSync(target, "utf8"),
      "class Foo:\n    pass\n\nclass Bar:\n    inserted = True\n    pass\n",
    );
  });

  it("applies repeated Update File ops on the same file cumulatively", async () => {
    const target = path.join(workdir, "f.txt");
    writeFileSync(target, "a\nb\nc\n");
    // Two separate Update File ops in the same patch. The second op's
    // context (` b`) only matches the result of the first op, so the
    // implementation must thread an in-memory virtual file state, not
    // re-read from disk for every op.
    await runTool(patch(
      "*** Begin Patch",
      "*** Update File: f.txt",
      "@@",
      "-a",
      "+A",
      " b",
      "*** Update File: f.txt",
      "@@",
      " b",
      "-c",
      "+C",
      "*** End Patch",
    ), workdir);
    assert.equal(readFileSync(target, "utf8"), "A\nb\nC\n");
  });

  it("accepts an absolute path that resolves inside the workspace", async () => {
    const abs = path.join(workdir, "abs.txt");
    await runTool(patch(
      "*** Begin Patch",
      `*** Add File: ${abs}`,
      "+ok",
      "*** End Patch",
    ), workdir);
    assert.equal(readFileSync(abs, "utf8"), "ok\n");
  });

  it("locks symlink aliases under a single canonical lock so concurrent patches via different aliases serialize", async () => {
    // workdir/real/file.txt is the real file; workdir/link is a symlink to
    // workdir/real. Two concurrent patches use different aliases (`real/`
    // and `link/`) and edit independent lines. If the queue keys by
    // canonical realpath, both calls share one lock and read the file
    // sequentially, so both edits land. If aliases ended up on separate
    // queues, both reads could happen before either write, and one edit
    // would be stomped.
    mkdirSync(path.join(workdir, "real"));
    writeFileSync(path.join(workdir, "real/file.txt"), "alpha\nbeta\n");
    symlinkSync(path.join(workdir, "real"), path.join(workdir, "link"));

    const tool = await getTool();
    const ctx = makeCtx(workdir);
    const p1 = tool.execute("c1", { patchText: patch(
      "*** Begin Patch",
      "*** Update File: real/file.txt",
      "@@",
      "-alpha",
      "+ALPHA",
      "*** End Patch",
    ) }, undefined, undefined, ctx);
    const p2 = tool.execute("c2", { patchText: patch(
      "*** Begin Patch",
      "*** Update File: link/file.txt",
      "@@",
      "-beta",
      "+BETA",
      "*** End Patch",
    ) }, undefined, undefined, ctx);
    await Promise.all([p1, p2]);
    assert.equal(readFileSync(path.join(workdir, "real/file.txt"), "utf8"), "ALPHA\nBETA\n");
  });

  it("applies multiple hunks in one Update File using a header anchor", async () => {
    const target = path.join(workdir, "file.txt");
    writeFileSync(target,
      "class Foo:\n  level = 'info'\n\nclass Bar:\n  level = 'info'\n",
    );
    // Use the @@ class Bar anchor so the second-occurrence 'level' line is unambiguous.
    await runTool(patch(
      "*** Begin Patch",
      "*** Update File: file.txt",
      "@@ class Bar:",
      "-  level = 'info'",
      "+  level = 'debug'",
      "*** End Patch",
    ), workdir);
    assert.equal(
      readFileSync(target, "utf8"),
      "class Foo:\n  level = 'info'\n\nclass Bar:\n  level = 'debug'\n",
    );
  });

  it("applies multiple Update File hunks in one operation in document order", async () => {
    const target = path.join(workdir, "file.txt");
    writeFileSync(target, "one\ntwo\nthree\nfour\nfive\n");
    await runTool(patch(
      "*** Begin Patch",
      "*** Update File: file.txt",
      "@@",
      " one",
      "-two",
      "+TWO",
      "@@",
      " four",
      "-five",
      "+FIVE",
      "*** End Patch",
    ), workdir);
    assert.equal(readFileSync(target, "utf8"), "one\nTWO\nthree\nfour\nFIVE\n");
  });

  it("rejects out-of-order hunks: a later hunk whose @@ anchor only matches before a previous hunk's cursor must fail loudly, not silently mis-anchor", async () => {
    // Two `class` blocks. First hunk anchors on `class Bar:` and edits a
    // line inside it, advancing the cursor past `class Bar:`. The second
    // hunk anchors on `class Foo:`, which only exists *before* `class Bar:`.
    // Per the documented monotonic-cursor invariant, hunks must be in
    // document order; an out-of-order hunk must be rejected loudly rather
    // than silently failing to anchor or matching at the wrong site.
    const target = path.join(workdir, "f.py");
    writeFileSync(
      target,
      [
        "class Foo:",
        "    value = 1",
        "",
        "class Bar:",
        "    value = 2",
        "",
      ].join("\n"),
    );
    await assert.rejects(
      () => runTool(patch(
        "*** Begin Patch",
        "*** Update File: f.py",
        "@@ class Bar:",
        "-    value = 2",
        "+    value = 22",
        "@@ class Foo:",
        "-    value = 1",
        "+    value = 11",
        "*** End Patch",
      ), workdir),
      /document order|out of order|previously applied/i,
    );
    // File must be unchanged because pre-flush validation failed.
    assert.equal(
      readFileSync(target, "utf8"),
      "class Foo:\n    value = 1\n\nclass Bar:\n    value = 2\n",
    );
  });

  it("rejects an ambiguous hunk that matches multiple locations", async () => {
    const target = path.join(workdir, "file.txt");
    writeFileSync(target, "x\n  level = 'info'\ny\n  level = 'info'\n");
    // No header anchor and no surrounding context = ambiguous match.
    await assert.rejects(
      () => runTool(patch(
        "*** Begin Patch",
        "*** Update File: file.txt",
        "@@",
        "-  level = 'info'",
        "+  level = 'debug'",
        "*** End Patch",
      ), workdir),
      /matched|ambiguous|disambiguate/i,
    );
    // File untouched.
    assert.equal(readFileSync(target, "utf8"), "x\n  level = 'info'\ny\n  level = 'info'\n");
  });

  it("rejects a hunk whose context does not match the file on disk", async () => {
    const target = path.join(workdir, "file.txt");
    writeFileSync(target, "alpha\nbeta\ngamma\n");
    await assert.rejects(
      () => runTool(patch(
        "*** Begin Patch",
        "*** Update File: file.txt",
        "@@",
        " alpha",
        "-WRONG_CONTEXT",
        "+BETA",
        " gamma",
        "*** End Patch",
      ), workdir),
      /context|match|hunk/i,
    );
    assert.equal(readFileSync(target, "utf8"), "alpha\nbeta\ngamma\n");
  });

  it("rejects an absolute path that escapes the workspace", async () => {
    await assert.rejects(
      () => runTool(patch(
        "*** Begin Patch",
        "*** Update File: /etc/passwd",
        "@@",
        "-root",
        "+pwned",
        "*** End Patch",
      ), workdir),
      /outside|workspace|absolute/i,
    );
  });

  it("rejects a relative path that escapes the workspace via ..", async () => {
    await assert.rejects(
      () => runTool(patch(
        "*** Begin Patch",
        "*** Add File: ../escape.txt",
        "+leak",
        "*** End Patch",
      ), workdir),
      /outside|workspace|escape/i,
    );
  });

  it("rejects a path that traverses a symlink out of the workspace", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "pi-mmr-apply-patch-out-"));
    try {
      symlinkSync(outside, path.join(workdir, "link"));
      await assert.rejects(
        () => runTool(patch(
          "*** Begin Patch",
          "*** Add File: link/leak.txt",
          "+leak",
          "*** End Patch",
        ), workdir),
        /outside|workspace|symlink/i,
      );
      assert.equal(existsSync(path.join(outside, "leak.txt")), false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a patch that writes both a file and a descendant of that file (path topology conflict)", async () => {
    // Adding `a` as a file and `a/b` as a file is a topology conflict that
    // any correct flush must fail. We catch it pre-flush so the workspace
    // stays untouched, rather than relying on the documented mid-flush
    // failure caveat.
    await assert.rejects(
      () => runTool(patch(
        "*** Begin Patch",
        "*** Add File: a",
        "+content of a",
        "*** Add File: a/b",
        "+content of a slash b",
        "*** End Patch",
      ), workdir),
      /topology|conflict|both a file and|parent of/i,
    );
    assert.equal(existsSync(path.join(workdir, "a")), false, "a must not be created");
    assert.equal(existsSync(path.join(workdir, "a", "b")), false, "a/b must not be created");
  });

  it("reports user-facing relative paths in the success summary even when ctx.cwd is a symlinked alias", async () => {
    // Companion to the rejection test below: when ctx.cwd is a symlinked
    // alias of the real workspace, the success-path summary text must use
    // the same namespace as the user's input. Concretely, a patch that
    // adds `a/b.txt` via the alias must surface `add a/b.txt` in the
    // result text, not `add ../wd-real/a/b.txt` (which is what naive
    // path.relative against the un-canonical cwd would produce).
    const aliasParent = mkdtempSync(path.join(tmpdir(), "pi-mmr-apply-patch-alias-"));
    const alias = path.join(aliasParent, "link");
    symlinkSync(workdir, alias);
    let result;
    try {
      result = await runTool(patch(
        "*** Begin Patch",
        "*** Add File: a/b.txt",
        "+hello",
        "*** End Patch",
      ), alias);
    } finally {
      rmSync(aliasParent, { recursive: true, force: true });
    }
    const summary = result.details.summary;
    assert.match(summary, /add: a\/b\.txt \(\+1\/-0\)/, `summary should show 'add: a/b.txt (+1/-0)'; got: ${summary}`);
    assert.doesNotMatch(
      summary,
      /\.\.\//,
      `summary must not escape the user-supplied workspace alias with '../'; got: ${summary}`,
    );
    assert.equal(readFileSync(path.join(workdir, "a", "b.txt"), "utf8"), "hello\n");
  });

  it("reports user-facing relative paths when the patch uses an absolute path through a workspace symlink", async () => {
    // Relative raw paths were covered above. This covers the absolute-path
    // branch of resolveSafePath: an absolute path containing a symlink
    // component may still resolve inside the workspace and should display
    // relative to the real workspace root, not as `../alias/...`.
    const aliasParent = mkdtempSync(path.join(tmpdir(), "pi-mmr-apply-patch-alias-"));
    const alias = path.join(aliasParent, "link");
    symlinkSync(workdir, alias);
    let result;
    try {
      result = await runTool(patch(
        "*** Begin Patch",
        `*** Add File: ${path.join(alias, "a", "absolute.txt")}`,
        "+hello",
        "*** End Patch",
      ), workdir);
    } finally {
      rmSync(aliasParent, { recursive: true, force: true });
    }
    const summary = result.details.summary;
    assert.match(summary, /add: a\/absolute\.txt \(\+1\/-0\)/, `summary should show 'add: a/absolute.txt (+1/-0)'; got: ${summary}`);
    assert.doesNotMatch(
      summary,
      /\.\.\//,
      `summary must not display the symlink alias via '../'; got: ${summary}`,
    );
    assert.equal(readFileSync(path.join(workdir, "a", "absolute.txt"), "utf8"), "hello\n");
  });

  it("rejects a non-absolute ctx.cwd (the workspace contract is absolute paths only)", async () => {
    // Pi always supplies an absolute ctx.cwd, but the implementation
    // should make that contract explicit at the boundary rather than
    // silently resolving against process.cwd().
    await assert.rejects(
      () => runTool(patch(
        "*** Begin Patch",
        "*** Add File: x.txt",
        "+hi",
        "*** End Patch",
      ), "./relative/cwd"),
      /absolute|workspace/i,
    );
  });

  it("applies the existing-ancestor topology check even when ctx.cwd is a symlinked alias of the workspace", async () => {
    // Reproduces a previously-silent bypass: when ctx.cwd is a symlink
    // (e.g. /tmp -> /private/tmp on macOS, or any user-supplied symlinked
    // workdir), the topology walk's namespace mismatch caused the
    // existing-ancestor check to be a no-op and partial writes (`aa`
    // committed, mkdir on `place` failing) to slip through.
    writeFileSync(path.join(workdir, "place"), "old\n");
    const aliasParent = mkdtempSync(path.join(tmpdir(), "pi-mmr-apply-patch-alias-"));
    const alias = path.join(aliasParent, "link");
    symlinkSync(workdir, alias);
    try {
      await assert.rejects(
        () => runTool(patch(
          "*** Begin Patch",
          "*** Add File: aa",
          "+sibling",
          "*** Add File: place/inside.txt",
          "+leak",
          "*** End Patch",
        ), alias),
        /topology|conflict|not a directory|parent/i,
      );
    } finally {
      rmSync(aliasParent, { recursive: true, force: true });
    }
    assert.equal(existsSync(path.join(workdir, "aa")), false, "aa must not be created via the symlinked alias");
    assert.equal(
      existsSync(path.join(workdir, "place", "inside.txt")),
      false,
      "place/inside.txt must not be created via the symlinked alias",
    );
    assert.equal(
      readFileSync(path.join(workdir, "place"), "utf8"),
      "old\n",
      "place must be untouched",
    );
  });

  it("maps EISDIR (Update File targeting a directory) to ApplyPatchError", async () => {
    // If a patch targets a path that exists as a directory, the underlying
    // readFile raises EISDIR; without an explicit map, callers see a raw
    // Node error rather than a clean apply-patch error message. The tool
    // must reject with an ApplyPatchError-shaped message naming the path.
    mkdirSync(path.join(workdir, "is-a-dir"));
    await assert.rejects(
      () => runTool(patch(
        "*** Begin Patch",
        "*** Update File: is-a-dir",
        "@@",
        "-x",
        "+y",
        "*** End Patch",
      ), workdir),
      (err) => {
        assert.equal(err.name, "ApplyPatchError", `expected ApplyPatchError, got ${err.name}: ${err.message}`);
        assert.match(err.message, /is-a-dir/);
        assert.match(err.message, /director|EISDIR/i);
        return true;
      },
    );
  });

  it("wraps unexpected fs errors during the flush phase as ApplyPatchError with workspace-relative path and the originating errno", async () => {
    // A read-only directory makes writeFile fail with EACCES during the
    // flush phase. The raw Node error message would be
    // "EACCES: permission denied, open '<absolute path>'", which both
    // leaks the absolute filesystem path into shared logs and is not
    // classified as an ApplyPatchError. The tool must catch and re-throw
    // an ApplyPatchError that names the workspace-relative path and the
    // errno code, and must not include the absolute workdir prefix.
    if (process.getuid && process.getuid() === 0) return; // chmod is a no-op for root
    const roDir = path.join(workdir, "ro");
    mkdirSync(roDir);
    chmodSync(roDir, 0o500); // r-x only: writeFile inside this dir fails EACCES
    try {
      await assert.rejects(
        () => runTool(patch(
          "*** Begin Patch",
          "*** Add File: ro/new.txt",
          "+content",
          "*** End Patch",
        ), workdir),
        (err) => {
          assert.equal(err.name, "ApplyPatchError", `expected ApplyPatchError, got ${err.name}: ${err.message}`);
          assert.match(err.message, /ro\/new\.txt/, "message must include workspace-relative path");
          assert.match(err.message, /EACCES|EPERM|permission/i, "message must include the originating errno or 'permission'");
          assert.ok(
            !err.message.includes(workdir),
            `message must not leak the absolute workdir prefix; got: ${err.message}`,
          );
          return true;
        },
      );
    } finally {
      // Restore permissions so afterEach can rmSync.
      chmodSync(roDir, 0o700);
    }
  });

  it("applies a multi-hunk Update where the last hunk is anchored by *** End of File", async () => {
    const target = path.join(workdir, "multi.txt");
    writeFileSync(target, "alpha\nbeta\ngamma\nzz\n");
    // Two hunks in one Update: a body-anchored edit on `beta`, and an
    // EOF-anchored edit on the trailing `zz` line. The EOF anchor must be
    // honored even when other hunks have already shifted the cursor.
    await runTool(patch(
      "*** Begin Patch",
      "*** Update File: multi.txt",
      "@@",
      " alpha",
      "-beta",
      "+BETA",
      " gamma",
      "@@",
      "-zz",
      "+ZZ",
      "*** End of File",
      "*** End Patch",
    ), workdir);
    assert.equal(readFileSync(target, "utf8"), "alpha\nBETA\ngamma\nZZ\n");
  });

  it("patches a file whose context lines themselves start with +, -, or space in column 1", async () => {
    // File content contains lines that look like patch markers (e.g.
    // an embedded diff or markdown list). The patch body's leading
    // marker is stripped to produce the on-disk text, so a context
    // line ` +foo` corresponds to the file line `+foo` and a remove
    // line `- -bar` corresponds to the file line `-bar`.
    const target = path.join(workdir, "diff-in-diff.md");
    writeFileSync(target, "+foo\n-bar\n baz\n");
    await runTool(patch(
      "*** Begin Patch",
      "*** Update File: diff-in-diff.md",
      "@@",
      " +foo",
      "--bar",
      "+-BAR",
      "  baz",
      "*** End Patch",
    ), workdir);
    assert.equal(readFileSync(target, "utf8"), "+foo\n-BAR\n baz\n");
  });

  it("rejects a patch that adds a new file beneath a pre-existing regular file ancestor", async () => {
    // `place` exists on disk as a regular file. The patch adds a new
    // sibling `aa` (which would write fine) and then `place/inside.txt`
    // (which requires `place` to be a directory). Without an
    // existing-ancestor topology check, the flush would write `aa`,
    // then fail mkdir on `place`, leaving `aa` behind.
    writeFileSync(path.join(workdir, "place"), "old\n");
    await assert.rejects(
      () => runTool(patch(
        "*** Begin Patch",
        "*** Add File: aa",
        "+sibling",
        "*** Add File: place/inside.txt",
        "+leak",
        "*** End Patch",
      ), workdir),
      /topology|conflict|not a directory|parent/i,
    );
    assert.equal(existsSync(path.join(workdir, "aa")), false, "aa must not be created");
    assert.equal(
      existsSync(path.join(workdir, "place", "inside.txt")),
      false,
      "place/inside.txt must not be created",
    );
    assert.equal(
      readFileSync(path.join(workdir, "place"), "utf8"),
      "old\n",
      "place must be untouched",
    );
  });

  it("allows replacing a regular file with a directory tree by deleting the file first", async () => {
    // `place` exists as a regular file on disk. The patch deletes it and
    // immediately adds `place/inside.txt`, which requires the flush to do
    // deletes before writes so mkdir of the new parent succeeds.
    writeFileSync(path.join(workdir, "place"), "old\n");
    await runTool(patch(
      "*** Begin Patch",
      "*** Delete File: place",
      "*** Add File: place/inside.txt",
      "+new",
      "*** End Patch",
    ), workdir);
    assert.equal(
      readFileSync(path.join(workdir, "place", "inside.txt"), "utf8"),
      "new\n",
    );
  });

  it("does not partially write when one file in a multi-file patch fails validation", async () => {
    const okTarget = path.join(workdir, "ok.txt");
    const badTarget = path.join(workdir, "bad.txt");
    writeFileSync(okTarget, "one\n");
    writeFileSync(badTarget, "actual\n");
    await assert.rejects(
      () => runTool(patch(
        "*** Begin Patch",
        "*** Update File: ok.txt",
        "@@",
        "-one",
        "+ONE",
        "*** Update File: bad.txt",
        "@@",
        "-WRONG",
        "+BAD",
        "*** End Patch",
      ), workdir),
      /context|match|hunk/i,
    );
    assert.equal(readFileSync(okTarget, "utf8"), "one\n", "ok.txt must be untouched");
    assert.equal(readFileSync(badTarget, "utf8"), "actual\n", "bad.txt must be untouched");
  });

  it("rejects Add File whose target already exists", async () => {
    writeFileSync(path.join(workdir, "exists.txt"), "already\n");
    await assert.rejects(
      () => runTool(patch(
        "*** Begin Patch",
        "*** Add File: exists.txt",
        "+new",
        "*** End Patch",
      ), workdir),
      /already exists/i,
    );
  });

  it("rejects Delete File for a missing path", async () => {
    await assert.rejects(
      () => runTool(patch(
        "*** Begin Patch",
        "*** Delete File: missing.txt",
        "*** End Patch",
      ), workdir),
      /missing|not.*exist|cannot delete/i,
    );
  });

  it("rejects Move to: when the destination already exists", async () => {
    writeFileSync(path.join(workdir, "src.txt"), "src\n");
    writeFileSync(path.join(workdir, "dest.txt"), "dest\n");
    await assert.rejects(
      () => runTool(patch(
        "*** Begin Patch",
        "*** Update File: src.txt",
        "*** Move to: dest.txt",
        "@@",
        "-src",
        "+SRC",
        "*** End Patch",
      ), workdir),
      /destination|already exists/i,
    );
    // Both files unchanged.
    assert.equal(readFileSync(path.join(workdir, "src.txt"), "utf8"), "src\n");
    assert.equal(readFileSync(path.join(workdir, "dest.txt"), "utf8"), "dest\n");
  });

  it("serializes concurrent patches on the same file via the mutation queue", async () => {
    // Two concurrent patches that edit independent lines in the same file.
    // Without the queue holding the full read-modify-write window, both
    // calls could read the original content simultaneously and the second
    // write would stomp the first edit. With the queue, the two calls
    // serialize regardless of which acquires the lock first, and both
    // edits land deterministically. We deliberately avoid dependent edits
    // (where one patch's context only matches after the other's write)
    // because their outcome depends on lock-acquisition order even when
    // serialization is correct.
    const target = path.join(workdir, "race.txt");
    writeFileSync(target, "alpha\nbeta\n");
    const tool = await getTool();
    const ctx = makeCtx(workdir);

    const p1 = tool.execute("c1", { patchText: patch(
      "*** Begin Patch",
      "*** Update File: race.txt",
      "@@",
      "-alpha",
      "+ALPHA",
      "*** End Patch",
    ) }, undefined, undefined, ctx);
    const p2 = tool.execute("c2", { patchText: patch(
      "*** Begin Patch",
      "*** Update File: race.txt",
      "@@",
      "-beta",
      "+BETA",
      "*** End Patch",
    ) }, undefined, undefined, ctx);

    await Promise.all([p1, p2]);
    assert.equal(readFileSync(target, "utf8"), "ALPHA\nBETA\n");
  });
});

