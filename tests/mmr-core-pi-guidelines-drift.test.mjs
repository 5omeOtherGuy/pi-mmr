// Drift guard for Pi's constant `Guidelines:` composition.
//
// Mode-derived subagent workers rebuild their `Guidelines:` block from the
// worker's profile-filtered manifest (see
// src/extensions/mmr-core/subagent-prompt-assembly.ts:buildWorkerGuidelinesBlock),
// reproducing Pi's `buildSystemPrompt` composition. Per-tool bullets are Pi's
// own data flowing through the manifest, but the conditional bash-exploration
// bullet and the two always-on bullets are Pi-owned *constants* reproduced from
// a pinned Pi version. The worker prompt has no runtime drift validator (unlike
// the parent path), so this test is the tripwire: if Pi changes those constant
// guidelines on a dependency bump, this fails loudly instead of letting the
// worker prompt diverge silently.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

describe("Pi Guidelines composition drift guard", () => {
  it("our reproduced constant guidelines still match Pi's buildSystemPrompt", async () => {
    const { PI_CONSTANT_GUIDELINES } = await importSource(
      "extensions/mmr-core/subagent-prompt-assembly.ts",
    );

    // Resolve the installed Pi package via its ESM entry (the package's
    // `exports` map does not expose `package.json` or a CJS `require`, so
    // `import.meta.resolve` is the robust hoisting-agnostic lookup).
    const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const piRoot = path.resolve(path.dirname(piEntry), "..");
    const mapPath = path.join(piRoot, "dist/core/system-prompt.js.map");

    // Match against the sourcemap's `sourcesContent` (the unminified original,
    // the same source we extracted the algorithm from) so dist minification
    // cannot defeat the check.
    let raw;
    try {
      raw = readFileSync(mapPath, "utf8");
    } catch (err) {
      assert.fail(
        "Pi system-prompt sourcemap not found at " + mapPath + " (" + (err?.code ?? err) + "); " +
          "the drift guard can no longer verify Pi's constant guidelines — re-evaluate " +
          "buildWorkerGuidelinesBlock against the installed Pi build.",
      );
    }
    const map = JSON.parse(raw);
    const src = (map.sourcesContent ?? []).join("\n");
    assert.ok(
      src.includes("buildSystemPrompt"),
      "could not locate Pi system-prompt source; re-evaluate drift guard",
    );

    // Every literal `addGuideline("…")` call is one of Pi's constant
    // guidelines. The per-tool loop calls `addGuideline(<variable>)`, so it is
    // not captured by this string-literal scan.
    const literals = [...src.matchAll(/addGuideline\(\s*"((?:[^"\\]|\\.)*)"\s*\)/g)].map((m) =>
      JSON.parse(`"${m[1]}"`),
    );
    assert.deepEqual(
      new Set(literals),
      new Set(PI_CONSTANT_GUIDELINES),
      "Pi's constant Guidelines changed; re-sync buildWorkerGuidelinesBlock (PI_CONSTANT_GUIDELINES constants + the bash-exploration conditional)",
    );

    // The literal scan ignores ordering and the conditional logic. Pin the
    // bash-exploration condition and the always-on bullet order too, so a
    // change to those (without changing the literal strings) still trips.
    const condensed = src.replace(/\s+/g, " ");
    assert.ok(
      condensed.includes("hasBash && !hasGrep && !hasFind && !hasLs"),
      "Pi changed the bash-exploration conditional; re-sync buildWorkerGuidelinesBlock's tool-name guard",
    );
    assert.ok(
      src.indexOf("Be concise in your responses") <
        src.indexOf("Show file paths clearly when working with files"),
      "Pi reordered its always-on guidelines; re-sync PI_ALWAYS_ON_GUIDELINES order",
    );
  });
});
