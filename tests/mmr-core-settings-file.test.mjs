import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), "pi-mmr-settings-file-"));
}

describe("mmr-core internal settings-file: atomic + symlink-safe", () => {
  it("treats a missing file as an empty object and writes valid JSON with trailing newline", async () => {
    const { rewriteJsonSettingsFile } = await importSource("extensions/mmr-core/internal/settings-file.ts");
    const root = tempDir();
    try {
      const filePath = path.join(root, ".pi", "settings.json");
      assert.equal(existsSync(filePath), false);

      const returned = rewriteJsonSettingsFile(filePath, (existing) => {
        assert.deepEqual(existing, {});
        return { mmrCore: { defaultMode: "deep" } };
      });

      assert.equal(returned, filePath);
      const text = readFileSync(filePath, "utf8");
      assert.equal(text.endsWith("\n"), true);
      assert.deepEqual(JSON.parse(text), { mmrCore: { defaultMode: "deep" } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves no temp files behind after a successful write", async () => {
    const { rewriteJsonSettingsFile } = await importSource("extensions/mmr-core/internal/settings-file.ts");
    const root = tempDir();
    try {
      const dir = path.join(root, ".pi");
      const filePath = path.join(dir, "settings.json");
      rewriteJsonSettingsFile(filePath, () => ({ a: 1 }));
      rewriteJsonSettingsFile(filePath, () => ({ a: 2 }));

      const entries = readdirSync(dir);
      assert.deepEqual(entries, ["settings.json"], `unexpected leftover files: ${entries.join(", ")}`);
      assert.deepEqual(JSON.parse(readFileSync(filePath, "utf8")), { a: 2 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite a file whose contents are not valid JSON", async () => {
    const { rewriteJsonSettingsFile } = await importSource("extensions/mmr-core/internal/settings-file.ts");
    const root = tempDir();
    try {
      const dir = path.join(root, ".pi");
      mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, "settings.json");
      writeFileSync(filePath, "{ not json");

      assert.throws(
        () => rewriteJsonSettingsFile(filePath, () => ({ replaced: true })),
        /not valid JSON/,
      );
      // Untouched on refusal.
      assert.equal(readFileSync(filePath, "utf8"), "{ not json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not corrupt the original file when the transform throws", async () => {
    const { rewriteJsonSettingsFile } = await importSource("extensions/mmr-core/internal/settings-file.ts");
    const root = tempDir();
    try {
      const dir = path.join(root, ".pi");
      mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, "settings.json");
      const original = `${JSON.stringify({ mmrCore: { defaultMode: "smart" } }, null, 2)}\n`;
      writeFileSync(filePath, original);

      assert.throws(() => {
        rewriteJsonSettingsFile(filePath, () => {
          throw new Error("boom");
        });
      }, /boom/);

      assert.equal(readFileSync(filePath, "utf8"), original);
      assert.deepEqual(readdirSync(dir), ["settings.json"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to read or rewrite through a symlinked settings path", async () => {
    const { readJsonSettingsFile, rewriteJsonSettingsFile } = await importSource(
      "extensions/mmr-core/internal/settings-file.ts",
    );
    const root = tempDir();
    try {
      const dir = path.join(root, ".pi");
      mkdirSync(dir, { recursive: true });
      const realTarget = path.join(root, "outside.json");
      writeFileSync(realTarget, JSON.stringify({ secret: true }));
      const linkPath = path.join(dir, "settings.json");
      symlinkSync(realTarget, linkPath);

      assert.throws(() => readJsonSettingsFile(linkPath), /symbolic link/);
      assert.throws(() => rewriteJsonSettingsFile(linkPath, () => ({ replaced: true })), /symbolic link/);

      // The symlink target is never overwritten.
      assert.deepEqual(JSON.parse(readFileSync(realTarget, "utf8")), { secret: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("flags prototype-polluting object keys via isUnsafeObjectKey", async () => {
    const { isUnsafeObjectKey } = await importSource("extensions/mmr-core/internal/settings-file.ts");
    assert.equal(isUnsafeObjectKey("__proto__"), true);
    assert.equal(isUnsafeObjectKey("prototype"), true);
    assert.equal(isUnsafeObjectKey("constructor"), true);
    assert.equal(isUnsafeObjectKey("deep"), false);
    assert.equal(isUnsafeObjectKey("finder"), false);
  });
});

describe("mmr-core config-writer: prototype-pollution guards", () => {
  it("refuses an unsafe mode key", async () => {
    const { applyMmrConfigUpdate } = await importSource("extensions/mmr-core/config-writer.ts");
    assert.throws(
      () => applyMmrConfigUpdate({}, { modeModelPreferences: { mode: "__proto__", preferences: [{ model: "x" }] } }),
      /unsafe mode key/,
    );
  });

  it("refuses an unsafe subagent profile key", async () => {
    const { applyMmrConfigUpdate } = await importSource("extensions/mmr-core/config-writer.ts");
    assert.throws(
      () =>
        applyMmrConfigUpdate({}, {
          subagentModelPreferences: { profile: "constructor", preferences: [{ model: "x" }] },
        }),
      /unsafe subagent profile key/,
    );
  });
});
