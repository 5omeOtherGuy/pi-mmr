import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { evaluateChangelogEntryPolicy, requiresChangelogEntry } from "../scripts/check-changelog.mjs";

describe("requiresChangelogEntry", () => {
  it("is true when a monitored file changed but CHANGELOG.md did not", () => {
    assert.equal(requiresChangelogEntry(["src/extensions/mmr-core/index.ts"]), true);
    assert.equal(requiresChangelogEntry(["scripts/gate.sh", "README.md"]), true);
  });

  it("is false when CHANGELOG.md is among the changed files", () => {
    assert.equal(requiresChangelogEntry(["src/extensions/mmr-core/index.ts", "CHANGELOG.md"]), false);
  });

  it("is false when no monitored files changed", () => {
    assert.equal(requiresChangelogEntry(["some/unmonitored/file.txt"]), false);
    assert.equal(requiresChangelogEntry([]), false);
  });
});

describe("evaluateChangelogEntryPolicy", () => {
  it("returns nothing when CHANGELOG.md was changed", () => {
    const result = evaluateChangelogEntryPolicy({
      monitoredChanges: ["src/extensions/mmr-core/index.ts"],
      changelogChanged: true,
      env: {},
    });
    assert.deepEqual(result, {});
  });

  it("returns nothing when no monitored files changed", () => {
    const result = evaluateChangelogEntryPolicy({
      monitoredChanges: [],
      changelogChanged: false,
      env: {},
    });
    assert.deepEqual(result, {});
  });

  it("is silent when PI_MMR_CHANGELOG_NOT_NEEDED=1", () => {
    const result = evaluateChangelogEntryPolicy({
      monitoredChanges: ["scripts/gate.sh"],
      changelogChanged: false,
      env: { PI_MMR_CHANGELOG_NOT_NEEDED: "1" },
    });
    assert.deepEqual(result, {});
  });

  it("emits a non-fatal notice (no error) by default when an entry is missing", () => {
    const result = evaluateChangelogEntryPolicy({
      monitoredChanges: ["src/extensions/mmr-core/index.ts", "scripts/gate.sh"],
      changelogChanged: false,
      env: {},
    });
    assert.equal(result.error, undefined);
    assert.ok(result.notice, "expected a notice");
    assert.match(result.notice, /PR-body marker block/);
    assert.match(result.notice, /src\/extensions\/mmr-core\/index\.ts/);
  });

  it("escalates to a blocking error under PI_MMR_CHANGELOG_REQUIRE_ENTRY=1", () => {
    const result = evaluateChangelogEntryPolicy({
      monitoredChanges: ["src/extensions/mmr-core/index.ts"],
      changelogChanged: false,
      env: { PI_MMR_CHANGELOG_REQUIRE_ENTRY: "1" },
    });
    assert.ok(result.error, "expected a blocking error");
    assert.equal(result.notice, undefined);
  });

  it("does not block under REQUIRE_ENTRY when the changelog was changed", () => {
    const result = evaluateChangelogEntryPolicy({
      monitoredChanges: ["src/extensions/mmr-core/index.ts"],
      changelogChanged: true,
      env: { PI_MMR_CHANGELOG_REQUIRE_ENTRY: "1" },
    });
    assert.deepEqual(result, {});
  });

  it("truncates the changed-file list to 12 with an ellipsis", () => {
    const monitoredChanges = Array.from({ length: 15 }, (_, i) => `src/file-${i}.ts`);
    const result = evaluateChangelogEntryPolicy({ monitoredChanges, changelogChanged: false, env: {} });
    assert.match(result.notice, /, \.\.\./);
    assert.ok(!result.notice.includes("src/file-12.ts"), "should not list past the 12th file");
  });
});
