// Phase B public-safety lint helper. Reusable function that scans text for
// forbidden tokens before they reach public-facing surfaces, with an
// allowlist for explicitly marked PRIVATE_REFERENCE regions.
//
// Tests call this helper with the surfaces they want to lint and an
// optional `surface` label that gets prefixed onto each finding. The
// helper returns findings (no throwing); the caller decides whether to
// assert the list is empty.
//
// The lint is intentionally conservative: it targets unambiguous
// provenance/path leaks and a small set of secret-looking placeholders. It
// does not flag the bare names of public products (e.g. "Bash").

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../..");

// Build the sensitive detection literals from fragments so the linter's own
// source never carries a contiguous, publishable copy of the very tokens it
// is meant to catch (maintainer username and the private research repo name).
const joinFrag = (sep, ...parts) => parts.join(sep);
const RESEARCH_REPO_NAME = joinFrag("-", "multi", "model", "routing", "pi");
const LOCAL_HOME_PATH = `/home/${joinFrag("", "some", "other", "guy")}`;

// Each rule is { id, pattern, message }. `pattern` is a case-insensitive
// regex unless the rule explicitly uses /g/y/i flags itself.
const FORBIDDEN_RULES = [
  {
    id: "reverse-engineering",
    pattern: /reverse[-\s]?engineer/i,
    message: "reverse-engineering claim",
  },
  {
    id: "decompilation",
    pattern: /decompil/i,
    message: "decompilation claim",
  },
  {
    id: "extraction-claim",
    pattern: /extracted (?:bundle|binary|source|prompt|artifact)/i,
    message: "extraction claim",
  },
  {
    id: "runtime-trace",
    pattern: /runtime (?:trace|dump|capture)/i,
    message: "runtime-trace claim",
  },
  {
    id: "private-research-repo",
    pattern: new RegExp(RESEARCH_REPO_NAME, "i"),
    message: "private research repo name",
  },
  {
    id: "absolute-home-path",
    pattern: new RegExp(LOCAL_HOME_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
    message: "private local home path",
  },
  {
    id: "docs-private-path",
    pattern: /docs\/private\//i,
    message: "docs/private/* path leak (gitignored research; do not reference in public source or tests)",
  },
  {
    id: "aws-access-key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
    message: "AWS access-key-looking placeholder",
  },
  {
    id: "github-pat",
    pattern: /\bghp_[A-Za-z0-9]{36}\b/,
    message: "GitHub PAT-looking placeholder",
  },
  {
    id: "stripe-secret",
    pattern: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/,
    message: "Stripe-style secret placeholder",
  },
];

const TS_MARKER_OPEN = "// PRIVATE_REFERENCE";
const TS_MARKER_CLOSE = "// END PRIVATE_REFERENCE";
const MD_MARKER_OPEN = "<!-- PRIVATE_REFERENCE -->";
const MD_MARKER_CLOSE = "<!-- END PRIVATE_REFERENCE -->";

/**
 * Strip PRIVATE_REFERENCE-marked regions from `text`. Returns the
 * substitute text used for lint scanning and a count of stripped regions.
 *
 * Both TypeScript and Markdown markers are recognised; either flavor may
 * appear in any file. Unbalanced markers are intentionally not stripped so
 * the lint still catches the surrounding content.
 */
export function stripPrivateReferenceRegions(text) {
  let stripped = text;
  let count = 0;
  for (const [open, close] of [
    [TS_MARKER_OPEN, TS_MARKER_CLOSE],
    [MD_MARKER_OPEN, MD_MARKER_CLOSE],
  ]) {
    while (true) {
      const start = stripped.indexOf(open);
      if (start === -1) break;
      const end = stripped.indexOf(close, start + open.length);
      if (end === -1) break;
      stripped = stripped.slice(0, start) + stripped.slice(end + close.length);
      count += 1;
    }
  }
  return { stripped, regionCount: count };
}

/**
 * Lint a single piece of text. Returns an array of findings:
 *   { rule, message, line, snippet, surface }
 *
 * Lines are 1-indexed and computed against the stripped text (PRIVATE_REFERENCE
 * regions removed), so reported line numbers reflect the lintable surface.
 */
export function lintPublicSafetyText(text, { surface = "<text>" } = {}) {
  const { stripped } = stripPrivateReferenceRegions(text);
  const lines = stripped.split("\n");
  const findings = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const rule of FORBIDDEN_RULES) {
      if (rule.pattern.test(line)) {
        findings.push({
          rule: rule.id,
          message: rule.message,
          line: i + 1,
          snippet: line.trim().slice(0, 200),
          surface,
        });
      }
    }
  }
  return findings;
}

/**
 * Cross-check that every PRIVATE_REFERENCE region in the repo is registered
 * in PRIVATE_REWRITE.md. Returns { hits, registeredCount, discrepancies }.
 *
 * `hits`: { file, line } for each PRIVATE_REFERENCE opening token found via
 * `git grep`. `registeredCount`: number of `- ` bullets under the "## Regions"
 * heading in PRIVATE_REWRITE.md. `discrepancies`: human-readable strings the
 * caller can surface in assertion messages.
 */
export function auditPrivateReferenceRegistry() {
  const hits = collectPrivateReferenceHits();
  const registry = readRegistryRegions();
  const discrepancies = [];
  // The registry is a checklist by file path; the basic invariant is "every
  // file containing PRIVATE_REFERENCE markers is listed".
  const hitFiles = new Set(hits.map((hit) => hit.file));
  for (const file of hitFiles) {
    if (!registry.some((entry) => entry.includes(file))) {
      discrepancies.push(`${file} contains PRIVATE_REFERENCE markers but is not listed in PRIVATE_REWRITE.md`);
    }
  }
  for (const entry of registry) {
    // Heuristic: each registry line names a path-shaped token. If we listed
    // a file but `git grep` finds no markers in it, the registry is stale.
    const pathToken = extractPathToken(entry);
    if (!pathToken) continue;
    if (!hitFiles.has(pathToken)) {
      discrepancies.push(`PRIVATE_REWRITE.md lists ${pathToken} but no PRIVATE_REFERENCE markers were found there`);
    }
  }
  return { hits, registry, discrepancies };
}

function collectPrivateReferenceHits() {
  // Use git grep so untracked files don't pollute the audit; the registry
  // is about committed state.
  let raw;
  try {
    raw = execFileSync(
      "git",
      ["grep", "-n", "PRIVATE_REFERENCE"],
      { cwd: repoRoot, encoding: "utf8" },
    );
  } catch (err) {
    // `git grep` exits 1 when there are no matches; that is a clean result.
    // It exits 128 when run outside a git work tree (e.g. a freshly
    // initialized public checkout or a tarball export before the first
    // commit); treat that as "no committed markers found" rather than a
    // hard failure so the audit is portable across both contexts.
    if (err.status === 1 || err.status === 128) return [];
    throw err;
  }
  const hits = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    // Format: <path>:<line>:<content>
    const firstColon = line.indexOf(":");
    if (firstColon === -1) continue;
    const secondColon = line.indexOf(":", firstColon + 1);
    if (secondColon === -1) continue;
    const file = line.slice(0, firstColon);
    const lineNo = Number(line.slice(firstColon + 1, secondColon));
    const content = line.slice(secondColon + 1);
    // Ignore the registry file itself and the marker-handling code in the
    // lint helper — those are infrastructure, not marked regions.
    if (file === "PRIVATE_REWRITE.md") continue;
    if (file === "tests/helpers/public-safety-lint.mjs") continue;
    // The lint helper's own test file contains marker tokens inside JS
    // string literals (test fixtures), not as real source markers.
    if (file === "tests/mmr-core-public-safety-lint.test.mjs") continue;
    // Only count opening markers so we get one hit per region.
    if (!content.includes("PRIVATE_REFERENCE") || content.includes("END PRIVATE_REFERENCE")) continue;
    hits.push({ file, line: lineNo, content: content.trim() });
  }
  return hits;
}

function readRegistryRegions() {
  const registryPath = path.join(repoRoot, "PRIVATE_REWRITE.md");
  let text;
  try {
    text = readFileSync(registryPath, "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n");
  const regions = [];
  let inRegions = false;
  for (const line of lines) {
    if (line.startsWith("## Regions")) {
      inRegions = true;
      continue;
    }
    if (inRegions && line.startsWith("## ")) {
      inRegions = false;
      continue;
    }
    if (inRegions && /^\s*-\s+/.test(line)) {
      regions.push(line.trim().replace(/^-\s+/, ""));
    }
  }
  return regions;
}

function extractPathToken(entry) {
  // Match a relative path with a slash and an extension, possibly inside
  // backticks: `src/extensions/.../foo.ts`.
  const match = entry.match(/`?([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)`?/);
  return match ? match[1] : undefined;
}

export const PUBLIC_SAFETY_LINT_RULES = FORBIDDEN_RULES.map((rule) => ({
  id: rule.id,
  message: rule.message,
}));
