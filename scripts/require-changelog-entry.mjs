#!/usr/bin/env node
// CI enforcement for the changelog guarantee. Intended to run in the
// `changelog-sync` workflow AFTER the PR-body sync has committed any
// marker-block bullets. By then CHANGELOG.md is in the PR diff iff an entry
// was provided (via the marker block the bot just committed, or a manual edit),
// so a single signal — "did CHANGELOG.md change?" — closes the gap that the
// local notice-by-default policy intentionally leaves open.
//
// Fails (exit 1) when monitored files changed in this PR but CHANGELOG.md did
// not. The `skip-changelog` label and fork/bot cases are filtered by the
// workflow's job-level `if:`, so this script does not re-check them.
//
// Base ref: env CHANGELOG_BASE_REF (e.g. the PR base SHA), default origin/main.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { requiresChangelogEntry } from "./check-changelog.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function git(args) {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function changedFilesSince(baseRef) {
  let range = "HEAD";
  try {
    const mergeBase = git(["merge-base", baseRef, "HEAD"]);
    if (mergeBase) range = `${mergeBase}...HEAD`;
  } catch {
    // Fall back to a two-dot diff against the base ref directly.
    range = `${baseRef}..HEAD`;
  }
  const out = git(["diff", "--name-only", "--diff-filter=ACMR", range]);
  return out.split("\n").map((line) => line.trim().replaceAll("\\", "/")).filter(Boolean);
}

function main() {
  const baseRef = process.env.CHANGELOG_BASE_REF || "origin/main";
  const changedFiles = changedFilesSince(baseRef);
  if (!requiresChangelogEntry(changedFiles)) {
    console.log("require-changelog-entry: OK (CHANGELOG.md updated, or no monitored files changed).");
    return;
  }
  console.error(
    [
      "require-changelog-entry: monitored files changed but CHANGELOG.md was not updated.",
      "Add a PR-body changelog marker block (docs/changelog-template.md, \"Automated PR-body sync\")",
      "so changelog-sync appends it, edit ## Unreleased directly, or apply the `skip-changelog`",
      "label for a deliberately non-user-visible change.",
    ].join("\n"),
  );
  process.exitCode = 1;
}

main();
