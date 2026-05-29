import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { makeCtx, patch } from "./helpers/apply-patch.mjs";
import { createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

describe("mmr-toolbox apply_patch structured result shape", () => {
  let workdir;
  beforeEach(() => {
    workdir = mkdtempSync(path.join(tmpdir(), "pi-mmr-apply-patch-shape-"));
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

  // The result must surface meaningful model/user-visible text and the same
  // structured per-file fields the tool exposes:
  //   content[0].text begins with a single `Applied patch: …` status line,
  //   followed by a blank line, then a structured display diff body
  //   (context plus +/- lines, without unified-diff file headers or hunk
  //   headers). The status line is `Applied patch: <path> (+a/-d)` for
  //   single-file patches and `Applied patch: N files` for multi-file
  //   patches, so API surfaces that hide `details` see an unambiguous
  //   success marker instead of a bare diff body.
  //   details.summary is the compact summary,
  //   details.files[] has type/path/uri/additions/deletions/unified diff.

  it("update: returns a structured summary and files[] with diff stats", async () => {
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
    const text = result.content[0].text;
    assert.match(text, /^Applied patch: file\.txt \(\+1\/-1\)$/m, "visible output must start with an explicit status line so the LLM does not mistake the diff for a partial/failed result");
    assert.match(text, /^Applied patch: /, "status line must be at the very start of the visible text");
    assert.doesNotMatch(text, /^Applied patch to \d+ files?/m, "legacy 'Applied patch to N files' wording must not return");
    assert.doesNotMatch(text, /^--- a\/file\.txt$/m, "visible output should not include unified diff old header");
    assert.doesNotMatch(text, /^\+\+\+ b\/file\.txt$/m, "visible output should not include unified diff new header");
    assert.doesNotMatch(text, /^@@ /m, "visible output should not include unified diff hunk headers");
    assert.match(text, /^ alpha$/m, "visible output must include context lines");
    assert.match(text, /^-beta$/m, "visible output must include removed lines");
    assert.match(text, /^\+BETA$/m, "visible output must include added lines");
    // Status line + blank line must precede the diff body so trivially
    // stripping the first two lines yields pure diff.
    const [statusLine, blank] = text.split("\n");
    assert.match(statusLine, /^Applied patch: /);
    assert.equal(blank, "", "second line of visible text must be blank to separate status from diff body");
    assert.ok(result.details, "details must be set for renderResult/UI consumers");
    assert.equal(result.details.summary, "update: file.txt (+1/-1)", "details.summary stays compact");
    assert.equal(result.details.files.length, 1);
    const file = result.details.files[0];
    assert.equal(file.type, "update");
    assert.equal(file.path, "file.txt");
    assert.equal(file.additions, 1);
    assert.equal(file.deletions, 1);
    assert.equal(typeof file.uri, "string");
    assert.match(file.uri, /^file:\/\//, "uri must be a file:// URL of the final destination");
    assert.ok(file.uri.endsWith("/file.txt"), `uri should end with /file.txt; got ${file.uri}`);
    assert.equal(typeof file.diff, "string");
    assert.match(file.diff, /-beta/);
    assert.match(file.diff, /\+BETA/);
  });

  it("add: reports type 'add', additions = line count, deletions = 0, and file:// uri", async () => {
    const result = await runTool(patch(
      "*** Begin Patch",
      "*** Add File: nested/created.txt",
      "+one",
      "+two",
      "+three",
      "*** End Patch",
    ), workdir);
    const text = result.content[0].text;
    assert.match(text, /^Applied patch: nested\/created\.txt \(\+3\/-0\)$/m, "visible add must start with explicit status line");
    assert.match(text, /^\+one$/m, `visible add body: ${text}`);
    assert.equal(result.details.summary, "add: nested/created.txt (+3/-0)");
    const file = result.details.files[0];
    assert.equal(file.type, "add");
    assert.equal(file.path, "nested/created.txt");
    assert.equal(file.additions, 3);
    assert.equal(file.deletions, 0);
    assert.match(file.uri, /^file:\/\/.*\/nested\/created\.txt$/);
    assert.match(file.diff, /\+one\n\+two\n\+three/);
  });

  it("delete: reports type 'delete', additions = 0, deletions = original line count", async () => {
    const target = path.join(workdir, "gone.txt");
    writeFileSync(target, "a\nb\nc\n");
    const result = await runTool(patch(
      "*** Begin Patch",
      "*** Delete File: gone.txt",
      "*** End Patch",
    ), workdir);
    const text = result.content[0].text;
    assert.match(text, /^Applied patch: gone\.txt \(\+0\/-3\)$/m, "visible delete must start with explicit status line");
    assert.match(text, /^-a$/m, `visible delete body: ${text}`);
    assert.equal(result.details.summary, "delete: gone.txt (+0/-3)");
    const file = result.details.files[0];
    assert.equal(file.type, "delete");
    assert.equal(file.path, "gone.txt");
    assert.equal(file.additions, 0);
    assert.equal(file.deletions, 3);
    assert.match(file.uri, /\/gone\.txt$/);
    assert.match(file.diff, /-a\n-b\n-c/);
  });

  it("move: reports type 'move' with destination path, oldPath for source, and uri pointing at destination", async () => {
    const oldPath = path.join(workdir, "old.txt");
    writeFileSync(oldPath, "alpha\nbeta\ngamma\n");
    const result = await runTool(patch(
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
    const text = result.content[0].text;
    assert.match(text, /^Applied patch: old\.txt -> renamed\.txt \(\+1\/-1\)$/m, "visible move must start with explicit status line including rename arrow");
    assert.match(text, /^-beta$/m, `visible move body: ${text}`);
    assert.match(text, /^\+BETA$/m, `visible move body: ${text}`);
    assert.equal(result.details.summary, "move: old.txt -> renamed.txt (+1/-1)");
    const file = result.details.files[0];
    assert.equal(file.type, "move");
    assert.equal(file.path, "renamed.txt");
    assert.equal(file.oldPath, "old.txt");
    assert.equal(file.additions, 1);
    assert.equal(file.deletions, 1);
    assert.match(file.uri, /\/renamed\.txt$/);
    assert.match(file.diff, /-beta/);
    assert.match(file.diff, /\+BETA/);
  });

  it("multi-file patch: emits one summary line and one files[] entry per op in document order", async () => {
    writeFileSync(path.join(workdir, "existing.txt"), "keep\nremove\n");
    const result = await runTool(patch(
      "*** Begin Patch",
      "*** Add File: new.txt",
      "+hi",
      "*** Update File: existing.txt",
      "@@",
      " keep",
      "-remove",
      "*** End Patch",
    ), workdir);
    const text = result.content[0].text;
    assert.match(text, /^Applied patch: 2 files$/m, "multi-file visible output must start with explicit `Applied patch: N files` status line");
    assert.doesNotMatch(text, /^Applied patch to \d+ files?/m, "legacy 'Applied patch to N files' wording must not return");
    assert.match(text, /^new\.txt \(\+1\/-0\)$/m, "multi-file visible output should label add section");
    assert.match(text, /^existing\.txt \(\+0\/-1\)$/m, "multi-file visible output should label update section");
    assert.match(text, /^\+hi$/m, "visible output must include add body");
    assert.match(text, /^-remove$/m, "visible output must include update body");
    assert.doesNotMatch(text, /^--- /m, "visible output should not include unified diff file headers");
    assert.doesNotMatch(text, /^@@ /m, "visible output should not include unified diff hunk headers");
    // Status line + blank line precede the per-file sections.
    const lines = text.split("\n");
    assert.match(lines[0], /^Applied patch: 2 files$/);
    assert.equal(lines[1], "", "blank line must separate the status line from the multi-file diff body");
    assert.deepEqual(result.details.summary.split("\n"), [
      "add: new.txt (+1/-0)",
      "update: existing.txt (+0/-1)",
    ]);
    assert.equal(result.details.files.length, 2);
    assert.equal(result.details.files[0].type, "add");
    assert.equal(result.details.files[1].type, "update");
  });

  it("renderResult emits Pi edit-style numbered diff lines for renderDiff", async () => {
    // The interactive TUI feeds renderResult output through Pi's renderDiff
    // (after theme initialization). Without an initialized theme, our
    // renderResult falls back to the raw renderable diff text. Either way,
    // the lines must use the same `-NN`, `+NN`, ` NN` format that the
    // built-in `edit` tool produces, so renderDiff can apply diff colors
    // and intra-line highlighting consistently.
    const tool = await getTool();
    const target = path.join(workdir, "render.txt");
    writeFileSync(target, "alpha\nbeta\ngamma\n");
    const result = await tool.execute("call-1", { patchText: patch(
      "*** Begin Patch",
      "*** Update File: render.txt",
      "@@",
      " alpha",
      "-beta",
      "+BETA",
      " gamma",
      "*** End Patch",
    ) }, undefined, undefined, makeCtx(workdir));

    const fallbackText = result.content[0].text;
    assert.doesNotMatch(fallbackText, /^--- /m, "fallback text should be the structured body, not unified diff");
    assert.match(fallbackText, /^-beta$/m);
    assert.match(fallbackText, /^\+BETA$/m);

    const fakeTheme = {
      fg(_color, text) { return text; },
      bold(text) { return text; },
    };
    const component = tool.renderResult(result, {}, fakeTheme, { isError: false });
    const rendered = component.render(200).join("\n");
    const plain = rendered.replace(/\u001b\[[0-9;]*m/g, "");
    assert.match(plain, /^\s+1 alpha\s*$/m, "context line should carry padded line number");
    assert.match(plain, /^\s*-2 beta\s*$/m, "removed line should be `-N text`");
    assert.match(plain, /^\s*\+2 BETA\s*$/m, "added line should be `+N text`");
    assert.match(plain, /^\s+3 gamma\s*$/m, "trailing context line should carry line number");
    assert.doesNotMatch(plain, /^\s*--- /m, "rendered output should not include unified diff headers");
    assert.doesNotMatch(plain, /^\s*\+\+\+ /m, "rendered output should not include unified diff headers");
    assert.doesNotMatch(plain, /^\s*@@ /m, "rendered output should not include unified diff hunk headers");
  });

  it("renderResult labels each file in a multi-file patch with a path header", async () => {
    const tool = await getTool();
    writeFileSync(path.join(workdir, "a.txt"), "a\n");
    writeFileSync(path.join(workdir, "b.txt"), "b\n");
    const result = await tool.execute("call-multi", { patchText: patch(
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      "-a",
      "+A",
      "*** Update File: b.txt",
      "@@",
      "-b",
      "+B",
      "*** End Patch",
    ) }, undefined, undefined, makeCtx(workdir));

    const fakeTheme = {
      fg(_color, text) { return text; },
      bold(text) { return text; },
    };
    const rendered = tool.renderResult(result, {}, fakeTheme, { isError: false }).render(200).join("\n");
    const plain = rendered.replace(/\u001b\[[0-9;]*m/g, "");
    assert.match(plain, /^\s*a\.txt \(\+1\/-1\)\s*$/m, "first file should get a labeled header");
    assert.match(plain, /^\s*b\.txt \(\+1\/-1\)\s*$/m, "second file should get a labeled header");
    assert.match(plain, /^\s*-1 a\s*$/m);
    assert.match(plain, /^\s*\+1 A\s*$/m);
    assert.match(plain, /^\s*-1 b\s*$/m);
    assert.match(plain, /^\s*\+1 B\s*$/m);
  });

  it("text content has a status line plus structured diff body, not the legacy 'Applied patch to N files' wording", async () => {
    // Regression guard: previous text formats either leaked the legacy
    // `Applied patch to N files:` preamble, or returned only a compact
    // `update: file (+1/-1)` summary, or returned a bare diff body with no
    // success marker (easy for the LLM to misread as a partial result).
    // content[0].text must now begin with a single `Applied patch: …`
    // status line, then a blank line, then the structured diff body.
    writeFileSync(path.join(workdir, "f.txt"), "a\n");
    const result = await runTool(patch(
      "*** Begin Patch",
      "*** Update File: f.txt",
      "@@",
      "-a",
      "+A",
      "*** End Patch",
    ), workdir);
    const text = result.content[0].text;
    assert.match(text, /^Applied patch: f\.txt \(\+1\/-1\)$/m, "text must start with the new status line");
    assert.doesNotMatch(text, /^Applied patch to \d+ files?/m, "legacy 'Applied patch to N files' wording must not return");
    assert.doesNotMatch(text, /^--- a\/f\.txt$/m);
    assert.doesNotMatch(text, /^\+\+\+ b\/f\.txt$/m);
    assert.doesNotMatch(text, /^@@ /m);
    assert.match(text, /^-a$/m);
    assert.match(text, /^\+A$/m);
  });

  // Diff envelope is the structurally most useful piece of details.files[].diff:
  // a regression in the `--- a/<path>` / `+++ b/<path>` headers or the `@@ -a,b
  // +c,d @@` hunk header counts would silently break any consumer that tries to
  // parse the diff with off-the-shelf unified-diff tooling. Lock down all four
  // op types.

  it("update diff: uses standard '--- a/<path>', '+++ b/<path>', '@@ -a,b +c,d @@' envelope", async () => {
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
    const diff = result.details.files[0].diff;
    assert.match(diff, /^--- a\/file\.txt$/m);
    assert.match(diff, /^\+\+\+ b\/file\.txt$/m);
    // The single hunk covers all 3 lines on each side starting at line 1.
    assert.match(diff, /^@@ -1,3 \+1,3 @@$/m);
  });

  it("add diff: uses '/dev/null' on the old side and 'b/<path>' on the new side", async () => {
    const result = await runTool(patch(
      "*** Begin Patch",
      "*** Add File: created.txt",
      "+one",
      "+two",
      "*** End Patch",
    ), workdir);
    const diff = result.details.files[0].diff;
    assert.match(diff, /^--- \/dev\/null$/m);
    assert.match(diff, /^\+\+\+ b\/created\.txt$/m);
    // Standard convention: the missing-side range is `0,0` and the present
    // side starts at line 1.
    assert.match(diff, /^@@ -0,0 \+1,2 @@$/m);
  });

  it("delete diff: uses 'a/<path>' on the old side and '/dev/null' on the new side", async () => {
    const target = path.join(workdir, "gone.txt");
    writeFileSync(target, "a\nb\n");
    const result = await runTool(patch(
      "*** Begin Patch",
      "*** Delete File: gone.txt",
      "*** End Patch",
    ), workdir);
    const diff = result.details.files[0].diff;
    assert.match(diff, /^--- a\/gone\.txt$/m);
    assert.match(diff, /^\+\+\+ \/dev\/null$/m);
    assert.match(diff, /^@@ -1,2 \+0,0 @@$/m);
  });

  it("move diff: uses 'a/<oldPath>' and 'b/<newPath>' so the rename is visible in the headers", async () => {
    writeFileSync(path.join(workdir, "old.txt"), "alpha\nbeta\n");
    const result = await runTool(patch(
      "*** Begin Patch",
      "*** Update File: old.txt",
      "*** Move to: new.txt",
      "@@",
      " alpha",
      "-beta",
      "+BETA",
      "*** End Patch",
    ), workdir);
    const diff = result.details.files[0].diff;
    assert.match(diff, /^--- a\/old\.txt$/m);
    assert.match(diff, /^\+\+\+ b\/new\.txt$/m);
  });

  it("diff includes '\\ No newline at end of file' marker when the file has no trailing newline", async () => {
    // applyHunksToContent preserves the original file's trailing-newline state.
    // When that state is 'no trailing newline', the unified diff must include
    // the standard `\ No newline at end of file` marker so consumers (e.g.
    // `git apply`) round-trip correctly. Both sides lack the trailing newline
    // here, so a single marker after the last line is canonical.
    const target = path.join(workdir, "no-trailing.txt");
    writeFileSync(target, "alpha\nbeta\ngamma");
    const result = await runTool(patch(
      "*** Begin Patch",
      "*** Update File: no-trailing.txt",
      "@@",
      " alpha",
      "-beta",
      "+BETA",
      " gamma",
      "*** End Patch",
    ), workdir);
    assert.equal(
      readFileSync(target, "utf8"),
      "alpha\nBETA\ngamma",
      "file must still lack a trailing newline after the patch",
    );
    const diff = result.details.files[0].diff;
    assert.match(diff, /\\ No newline at end of file/, `diff must include the no-newline marker; got:\n${diff}`);
  });
});
