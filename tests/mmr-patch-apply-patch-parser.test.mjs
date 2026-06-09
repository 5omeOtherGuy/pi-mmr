import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { patch } from "./helpers/apply-patch.mjs";

after(cleanupLoadedSource);

describe("mmr-patch apply_patch parser", () => {
  it("parses Add/Delete/Update with hunks and Move to", async () => {
    const { parseCodexPatch } = await importSource("extensions/mmr-patch/apply-patch.ts");
    const ops = parseCodexPatch(patch(
      "*** Begin Patch",
      "*** Add File: a.txt",
      "+hello",
      "+world",
      "*** Delete File: gone.txt",
      "*** Update File: src/old.ts",
      "*** Move to: src/new.ts",
      "@@",
      " keep",
      "-old",
      "+new",
      "*** End Patch",
    ));
    assert.equal(ops.length, 3);
    assert.equal(ops[0].kind, "add");
    assert.equal(ops[0].rawPath, "a.txt");
    assert.deepEqual(ops[0].addLines, ["hello", "world"]);
    assert.equal(ops[1].kind, "delete");
    assert.equal(ops[1].rawPath, "gone.txt");
    assert.equal(ops[2].kind, "update");
    assert.equal(ops[2].movePath, "src/new.ts");
    assert.equal(ops[2].hunks.length, 1);
  });

  it("rejects payloads missing the Begin/End envelope", async () => {
    const { parseCodexPatch } = await importSource("extensions/mmr-patch/apply-patch.ts");
    assert.throws(() => parseCodexPatch("*** Add File: a.txt\n+x\n"), /Begin Patch/);
    assert.throws(() => parseCodexPatch("*** Begin Patch\n*** Add File: a.txt\n+x\n"), /End Patch/);
  });

  it("rejects an Add File body line that does not start with +", async () => {
    const { parseCodexPatch } = await importSource("extensions/mmr-patch/apply-patch.ts");
    assert.throws(
      () => parseCodexPatch(patch("*** Begin Patch", "*** Add File: a.txt", "no plus prefix", "*** End Patch")),
      /does not start with '\+'/,
    );
  });

  it("applyHunksToContent: removing every line of a file with a trailing newline yields a single blank line, not an empty file (use Delete File for true delete)", async () => {
    // Pinned semantics: Update File hunks preserve the original file's
    // trailing-newline state. If a hunk strips every line out of a file
    // that ended with a newline, the result is `"\n"` — a one-blank-line
    // file — not `""`. Callers that want a truly empty/removed file must
    // use `*** Delete File`. See apply-patch.ts applyHunksToContent.
    const { applyHunksToContent } = await importSource("extensions/mmr-patch/apply-patch.ts");
    const result = applyHunksToContent(
      "f.txt",
      "only\n",
      [{ headers: [], body: [{ kind: "remove", text: "only" }], endOfFile: false }],
    );
    assert.equal(result, "\n");
  });
});

