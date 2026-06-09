// Public-safety lint coverage. Exercises the lint helper itself and runs it
// on a narrow set of committed surfaces: the renderer output, the
// effective-surface fixtures, and the PRIVATE_REFERENCE marker handling.
//
// The sensitive test inputs (maintainer username, private research repo name)
// are assembled from fragments so this test's own source never carries a
// contiguous, publishable copy of those tokens.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  auditPrivateReferenceRegistry,
  lintPublicSafetyText,
  stripPrivateReferenceRegions,
} from "./helpers/public-safety-lint.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

const joinFrag = (sep, ...parts) => parts.join(sep);
const RESEARCH_REPO_NAME = joinFrag("-", "multi", "model", "routing", "pi");
const LOCAL_HOME_PATH = `/home/${joinFrag("", "some", "other", "guy")}`;

describe("Phase B public-safety lint: helper behavior", () => {
  it("flags reverse-engineering claims", () => {
    const findings = lintPublicSafetyText("This is reverse-engineered from the binary.");
    assert.ok(findings.some((f) => f.rule === "reverse-engineering"));
  });

  it("flags decompilation claims", () => {
    const findings = lintPublicSafetyText("Notes from the decompiled bundle.");
    assert.ok(findings.some((f) => f.rule === "decompilation"));
  });

  it("flags extracted-bundle / extracted-prompt claims", () => {
    const findings = lintPublicSafetyText("Copied from the extracted bundle.");
    assert.ok(findings.some((f) => f.rule === "extraction-claim"));
  });

  it("flags the private research repo name", () => {
    const findings = lintPublicSafetyText(`See ~/projects/${RESEARCH_REPO_NAME}/...`);
    assert.ok(findings.some((f) => f.rule === "private-research-repo"));
  });

  it("flags absolute home paths", () => {
    const findings = lintPublicSafetyText(`Path ${LOCAL_HOME_PATH}/projects/foo`);
    assert.ok(findings.some((f) => f.rule === "absolute-home-path"));
  });

  it("flags docs/private/ path references", () => {
    const findings = lintPublicSafetyText("See docs/private/some-spec.md §6.");
    assert.ok(
      findings.some((f) => f.rule === "docs-private-path"),
      `expected docs-private-path finding; got ${JSON.stringify(findings)}`,
    );
  });

  it("flags secret-looking placeholders", () => {
    const findings = lintPublicSafetyText("AKIAIOSFODNN7EXAMPLE");
    assert.ok(findings.some((f) => f.rule === "aws-access-key"));
  });

  it("does not flag bare public product or tool names in ordinary prose", () => {
    // Naming a public product or tool in normal prose must not trip the
    // provenance-claim rules; only the claim shapes themselves are flagged.
    const findings = lintPublicSafetyText("Ripgrep is a fast search tool we rely on.");
    assert.equal(findings.length, 0);
  });

  it("skips text inside TypeScript PRIVATE_REFERENCE markers", () => {
    const text = [
      "Normal line.",
      "// PRIVATE_REFERENCE",
      "reverse-engineered from the binary",
      "// END PRIVATE_REFERENCE",
      "Another normal line.",
    ].join("\n");
    const findings = lintPublicSafetyText(text);
    assert.equal(findings.length, 0);
  });

  it("skips text inside Markdown PRIVATE_REFERENCE markers", () => {
    const text = [
      "Normal line.",
      "<!-- PRIVATE_REFERENCE -->",
      "Notes from the decompiled bundle.",
      "<!-- END PRIVATE_REFERENCE -->",
      "Another normal line.",
    ].join("\n");
    const findings = lintPublicSafetyText(text);
    assert.equal(findings.length, 0);
  });

  it("still flags forbidden tokens that sit outside markers in the same file", () => {
    const text = [
      "// PRIVATE_REFERENCE",
      "reverse-engineered",
      "// END PRIVATE_REFERENCE",
      "And here is a separate decompilation claim.",
    ].join("\n");
    const findings = lintPublicSafetyText(text);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].rule, "decompilation");
  });

  it("counts stripped regions", () => {
    const text = [
      "// PRIVATE_REFERENCE",
      "x",
      "// END PRIVATE_REFERENCE",
      "<!-- PRIVATE_REFERENCE -->",
      "y",
      "<!-- END PRIVATE_REFERENCE -->",
    ].join("\n");
    const { regionCount } = stripPrivateReferenceRegions(text);
    assert.equal(regionCount, 2);
  });
});

describe("Phase B public-safety lint: applied to Phase B surfaces", () => {
  it("Phase B effective-surface fixtures contain no forbidden tokens", () => {
    const dir = path.join(repoRoot, "tests/fixtures/mmr-effective-surface");
    const files = readdirSync(dir).filter((name) => name.endsWith(".md"));
    assert.ok(files.length > 0, "expected Phase B effective-surface fixtures to exist");
    const allFindings = [];
    for (const file of files) {
      const text = readFileSync(path.join(dir, file), "utf8");
      const findings = lintPublicSafetyText(text, { surface: `tests/fixtures/mmr-effective-surface/${file}` });
      allFindings.push(...findings);
    }
    assert.deepEqual(
      allFindings,
      [],
      `lint findings in effective-surface fixtures: ${JSON.stringify(allFindings, null, 2)}`,
    );
  });

  it("the renderer module contains no forbidden tokens", () => {
    const text = readFileSync(
      path.join(repoRoot, "src/extensions/mmr-core/prompt-debug-renderer.ts"),
      "utf8",
    );
    const findings = lintPublicSafetyText(text, { surface: "prompt-debug-renderer.ts" });
    assert.deepEqual(findings, []);
  });

  it("mmr-subagents source and tests do not reference docs/private/* spec paths", () => {
    // Public-safety guard for the gitignored private research folder.
    // Source files and deterministic tests must explain their rationale in
    // pi-mmr-owned language; behavioral pins belong in the public surface
    // (types, JSDoc, tests) without anchoring to a private path.
    const surfaces = [
      "src/extensions/mmr-subagents/finder.ts",
      "src/extensions/mmr-subagents/oracle.ts",
      "src/extensions/mmr-subagents/task.ts",
      "src/extensions/mmr-subagents/runner.ts",
      "src/extensions/mmr-subagents/worker-trail.ts",
      "src/extensions/mmr-core/subagent-resolver.ts",
      "src/extensions/mmr-core/subagent-profiles.ts",
      "tests/mmr-subagents-finder.test.mjs",
      "tests/mmr-subagents-oracle.test.mjs",
      "tests/mmr-subagents-task.test.mjs",
      "tests/mmr-subagents-runner.test.mjs",
      "tests/mmr-subagents-extension.test.mjs",
      "tests/mmr-subagents-progress-rendering.test.mjs",
    ];
    const allFindings = [];
    for (const file of surfaces) {
      const text = readFileSync(path.join(repoRoot, file), "utf8");
      const findings = lintPublicSafetyText(text, { surface: file });
      // Only assert on the docs-private-path rule here; other rules
      // are exercised by their own scoped tests above.
      allFindings.push(...findings.filter((f) => f.rule === "docs-private-path"));
    }
    assert.deepEqual(
      allFindings,
      [],
      `mmr-subagents docs/private leak findings: ${JSON.stringify(allFindings, null, 2)}`,
    );
  });

  it("Phase C-edited source files contain no forbidden tokens outside PRIVATE_REFERENCE regions", () => {
    const files = [
      "src/extensions/mmr-web/tools.ts",
      "src/extensions/mmr-patch/index.ts",
      "src/extensions/mmr-tasks/index.ts",
      "src/extensions/mmr-core/builtin-tool-guidance.ts",
    ];
    const allFindings = [];
    for (const file of files) {
      const text = readFileSync(path.join(repoRoot, file), "utf8");
      const findings = lintPublicSafetyText(text, { surface: file });
      allFindings.push(...findings);
    }
    assert.deepEqual(
      allFindings,
      [],
      `Phase C lint findings: ${JSON.stringify(allFindings, null, 2)}`,
    );
  });
});

describe("Phase B public-safety lint: PRIVATE_REFERENCE registry audit", () => {
  it("every PRIVATE_REFERENCE region is registered in PRIVATE_REWRITE.md", () => {
    const { hits, discrepancies } = auditPrivateReferenceRegistry();
    assert.deepEqual(
      discrepancies,
      [],
      [
        `PRIVATE_REFERENCE registry is out of sync.`,
        `Hits found via git grep: ${JSON.stringify(hits, null, 2)}`,
        `Discrepancies: ${discrepancies.join("\n  - ")}`,
      ].join("\n"),
    );
  });
});
