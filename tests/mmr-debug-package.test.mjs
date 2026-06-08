import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const debugExtensionDir = "src/extensions/mmr-debug/";
const debugExtensionEntry = "./src/extensions/mmr-debug/index.ts";

async function readPackageJson() {
  return JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
}

// The `mmr-debug` capture extension is a developer-only, `-e`-loaded tool.
// It must stay out of the shipped surface on all three axes: not registered
// in `pi.extensions`, not reachable through `exports`, and never packaged.
// These assertions guard the negative contract so a future edit cannot
// silently start auto-loading or shipping it.
describe("mmr-debug packaging exclusion", () => {
  it("is not registered in package.json pi.extensions", async () => {
    const pkg = await readPackageJson();
    assert.ok(Array.isArray(pkg.pi?.extensions), "package.json must declare pi.extensions");
    assert.ok(
      !pkg.pi.extensions.includes(debugExtensionEntry),
      "mmr-debug must not be registered in pi.extensions (it would auto-load for users).",
    );
    assert.ok(
      !pkg.pi.extensions.some((entry) => entry.includes("mmr-debug")),
      "no pi.extensions entry may reference mmr-debug.",
    );
  });

  it("is not reachable through package.json exports", async () => {
    const pkg = await readPackageJson();
    assert.ok(pkg.exports && typeof pkg.exports === "object", "package.json must declare exports");
    // Scan keys and string leaves recursively so a future conditional-export
    // object (e.g. { "./debug": { "default": "...mmr-debug..." } }) cannot
    // smuggle the dev-only extension into the resolved surface unnoticed.
    const offenders = [];
    const walk = (node, where) => {
      if (typeof node === "string") {
        if (node.includes("mmr-debug")) offenders.push(`${where} -> ${node}`);
        return;
      }
      if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node)) {
          if (key.includes("mmr-debug")) offenders.push(`${where}${key}`);
          walk(value, `${where}${key}.`);
        }
      }
    };
    walk(pkg.exports, "exports.");
    assert.deepEqual(
      offenders,
      [],
      `package.json exports must not reference mmr-debug; found: ${offenders.join(", ")}`,
    );
  });

  it("declares the .npmignore exclusion rule", async () => {
    const npmignore = await readFile(path.join(repoRoot, ".npmignore"), "utf8");
    assert.ok(
      npmignore.split(/\r?\n/).includes(debugExtensionDir),
      `.npmignore must contain the line "${debugExtensionDir}" so the extension is never packaged.`,
    );
  });

  it("ships no mmr-debug extension file in the npm pack file list", () => {
    let raw;
    try {
      raw = execFileSync("npm", ["pack", "--dry-run", "--json"], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch (error) {
      assert.fail(
        `Could not run "npm pack --dry-run --json" to verify packaging exclusion: ${
          error instanceof Error ? error.message : String(error)
        }. This is the ground-truth packaging check; do not skip it.`,
      );
    }

    const parsed = JSON.parse(raw);
    const entry = Array.isArray(parsed) ? parsed[0] : parsed;
    assert.ok(entry && Array.isArray(entry.files), "npm pack --json must report a files[] array.");

    const packaged = entry.files
      .map((file) => file.path)
      .filter((filePath) => filePath.startsWith(debugExtensionDir));
    assert.deepEqual(
      packaged,
      [],
      `mmr-debug extension files must not be packaged; found: ${packaged.join(", ")}`,
    );
  });
});
