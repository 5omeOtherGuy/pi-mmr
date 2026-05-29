#!/usr/bin/env node
/**
 * Append a structured PR-body changelog block into CHANGELOG.md under
 * `## Unreleased`. Pure Node, no dependencies. CLI reads the PR body from
 * stdin; helpers are exported for deterministic tests.
 *
 * Marker syntax in the PR body:
 *
 *   <!-- pi-mmr changelog:start -->
 *   ### Fixed
 *
 *   - `mmr-core`: bullet text.
 *   <!-- pi-mmr changelog:end -->
 *
 * Validation rules:
 *   - At least one bullet inside the block.
 *   - Headings must be in CANONICAL_HEADINGS.
 *   - The whole PR body is scanned for public-unsafe wording.
 *
 * Append rules:
 *   - New bullets are appended in CANONICAL_HEADINGS order.
 *   - Duplicates (matched by sha256("<heading>\n<bulletContent>")) are skipped.
 *   - A heading that already exists under `## Unreleased` gets new bullets
 *     appended at the end of its block; a new heading is inserted at its
 *     canonical position relative to other Unreleased headings.
 *   - `## Unreleased` must exist; otherwise the CLI fails.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CANONICAL_HEADINGS = ["Added", "Changed", "Fixed", "Removed", "Security", "Documentation"];

const BLOCK_START = "<!-- pi-mmr changelog:start -->";
const BLOCK_END = "<!-- pi-mmr changelog:end -->";

// Mirror of scripts/check-changelog.mjs publicUnsafePatterns. Kept local
// so this script has no internal imports and can be invoked from CI without
// resolving the rest of the repo.
const join = (...parts) => parts.join("");
const sourceAnalysisTerm = `${join("rev", "erse")}[- ]${join("engine", "er")}(?:ed|ing)?`;
const bundleAnalysisTerm = `${join("deco", "mpil")}(?:e|ed|ation|ing)`;
const artifactTerm = join("extra", "cted");

const PUBLIC_UNSAFE_PATTERNS = [
  new RegExp(sourceAnalysisTerm, "i"),
  new RegExp(bundleAnalysisTerm, "i"),
  new RegExp(`${artifactTerm}\\s+(?:bundle|source|artifact)`, "i"),
  new RegExp(`runtime\\s+${join("tra", "ce")}`, "i"),
  new RegExp(`prompt\\s+${join("extra", "ction")}`, "i"),
  new RegExp(`private\\s+(?:dump|evidence|${join("ref", "erence")})`, "i"),
  new RegExp(`${join("cop", "ied")}\\s+from\\s+the\\s+original\\s+system\\s+prompt`, "i"),
  new RegExp(`matches\\s+${join("up", "stream")}\\s+${join("inter", "nals")}`, "i"),
  new RegExp(`ported\\s+from\\s+${artifactTerm}\\s+source`, "i"),
  new RegExp(`${join("veri", "fied")}\\s+against\\s+a\\s+private\\s+dump`, "i"),
  new RegExp(`${join("par", "ity")}\\s+with\\s+the\\s+internal\\s+tool\\s+list`, "i"),
];

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function normalizeLines(text) {
  return text.replaceAll("\r\n", "\n").split("\n");
}

/**
 * Replace every fenced code block (``` or ~~~ delimited) with blank lines of
 * the same line count, so the rest of the parser can keep using byte offsets
 * without having to re-anchor against the original text. This is what lets a
 * contributor document the marker syntax inside a code fence in their PR
 * description without the workflow accidentally extracting the example.
 */
export function stripFencedCodeBlocks(text) {
  if (typeof text !== "string") return text;
  const lines = normalizeLines(text);
  let fence;
  const out = new Array(lines.length);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (fence === undefined) {
      const open = trimmed.match(/^(```+|~~~+)/);
      if (open) {
        fence = open[1];
        out[i] = "";
        continue;
      }
      out[i] = line;
      continue;
    }
    // inside a fence: blank the line; close when we see a matching fence run
    out[i] = "";
    const close = trimmed.match(/^(```+|~~~+)\s*$/);
    if (close && close[1].startsWith(fence[0]) && close[1].length >= fence.length) {
      fence = undefined;
    }
  }
  return out.join("\n");
}

/**
 * Return the trimmed text between the start/end markers, or undefined when
 * either marker is missing or they are in the wrong order. Fenced code blocks
 * in the PR body are stripped first so documented examples of the marker
 * syntax (inside ``` or ~~~ fences) are not mistakenly treated as a real
 * changelog block.
 */
export function extractBlock(prBody) {
  if (typeof prBody !== "string") return undefined;
  const stripped = stripFencedCodeBlocks(prBody);
  const startIdx = stripped.indexOf(BLOCK_START);
  if (startIdx < 0) return undefined;
  const afterStart = startIdx + BLOCK_START.length;
  const endIdx = stripped.indexOf(BLOCK_END, afterStart);
  if (endIdx < 0) return undefined;
  return stripped.slice(afterStart, endIdx).trim();
}

/**
 * Parse a block body into a heading -> bullets map. Each bullet is a trimmed
 * multi-line string starting with `- `; the trim matches the fingerprint
 * algorithm in computeUnreleasedFingerprints so equality is byte-stable.
 */
export function parseBlock(text) {
  const buckets = new Map();
  if (typeof text !== "string") return buckets;
  const lines = normalizeLines(text);
  let heading;
  let currentLines;

  const flush = () => {
    if (!currentLines || heading === undefined) {
      currentLines = undefined;
      return;
    }
    while (currentLines.length > 0 && currentLines[currentLines.length - 1].trim() === "") {
      currentLines.pop();
    }
    const blockContent = currentLines.join("\n").trim();
    if (blockContent) {
      const existing = buckets.get(heading);
      if (existing) {
        existing.push(blockContent);
      } else {
        buckets.set(heading, [blockContent]);
      }
    }
    currentLines = undefined;
  };

  for (const line of lines) {
    const headingMatch = line.match(/^###\s+(.+?)\s*$/);
    if (headingMatch) {
      flush();
      heading = headingMatch[1];
      continue;
    }
    if (line.startsWith("- ")) {
      flush();
      currentLines = [line];
      continue;
    }
    if (currentLines) {
      currentLines.push(line);
    }
  }
  flush();
  return buckets;
}

/**
 * Validate parsed buckets and the surrounding PR body. Returns an array of
 * human-readable error strings (empty when the input is acceptable).
 */
export function validateBuckets(buckets, prBody) {
  const errors = [];
  if (!(buckets instanceof Map) || buckets.size === 0) {
    errors.push("changelog block has no headings + bullets.");
  } else {
    let totalBullets = 0;
    for (const bullets of buckets.values()) totalBullets += bullets.length;
    if (totalBullets === 0) {
      errors.push("changelog block has no headings + bullets.");
    }
    for (const heading of buckets.keys()) {
      if (!CANONICAL_HEADINGS.includes(heading)) {
        errors.push(
          `unsupported changelog heading '### ${heading}'. Allowed headings: ${CANONICAL_HEADINGS.map((h) => `### ${h}`).join(", ")}.`,
        );
      }
    }
  }
  if (typeof prBody === "string") {
    // Strip fenced code blocks so a contributor can document examples of
    // unsafe wording (e.g. in a "what NOT to write" block) without tripping
    // the scan; CHANGELOG.md content itself is still scanned by
    // scripts/check-changelog.mjs.
    const stripped = stripFencedCodeBlocks(prBody);
    for (const pattern of PUBLIC_UNSAFE_PATTERNS) {
      const match = stripped.match(pattern);
      if (match) {
        errors.push(`PR body contains public-unsafe wording: ${JSON.stringify(match[0])}.`);
      }
    }
  }
  return errors;
}

function extractUnreleasedContent(changelogText) {
  const lines = normalizeLines(changelogText);
  let startIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^##\s+Unreleased\b/i.test(lines[i])) {
      startIdx = i;
      break;
    }
  }
  if (startIdx < 0) return undefined;
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith("## ")) {
      endIdx = i;
      break;
    }
  }
  return { lines, startIdx, endIdx };
}

/**
 * Compute sha256("<heading>\n<bulletContent>") for every bullet currently
 * under `## Unreleased` in `changelogText`. Mirrors
 * `extractUnreleasedChangeBlocks` in src/extensions/mmr-core/changelog.ts
 * byte-for-byte: default heading "Changes", trim trailing blank lines from
 * each block before hashing.
 */
export function computeUnreleasedFingerprints(changelogText) {
  const result = new Set();
  const extracted = extractUnreleasedContent(changelogText);
  if (!extracted) return result;
  const { lines, startIdx, endIdx } = extracted;
  // Build the same `content` parseMmrChangelog would pass to
  // extractUnreleasedChangeBlocks: the heading line + body lines, joined and
  // trimmed. Then iterate `content.split("\n").slice(1)` exactly as upstream
  // does.
  const sectionLines = lines.slice(startIdx, endIdx);
  const content = sectionLines.join("\n").trim();
  const blockLines = content.split("\n").slice(1);

  let heading = "Changes";
  let currentLines;
  let currentHeading = heading;

  const flush = () => {
    if (!currentLines) return;
    while (currentLines.length > 0 && currentLines[currentLines.length - 1].trim() === "") {
      currentLines.pop();
    }
    const blockContent = currentLines.join("\n").trim();
    if (blockContent) {
      result.add(sha256(`${currentHeading}\n${blockContent}`));
    }
    currentLines = undefined;
  };

  for (const line of blockLines) {
    const headingMatch = line.match(/^###\s+(.+?)\s*$/);
    if (headingMatch) {
      flush();
      heading = headingMatch[1];
      continue;
    }
    if (line.startsWith("## ")) {
      flush();
      break;
    }
    if (line.startsWith("- ")) {
      flush();
      currentHeading = heading;
      currentLines = [line];
      continue;
    }
    if (currentLines) {
      currentLines.push(line);
    }
  }
  flush();
  return result;
}

// Internal model used by appendBulletsToChangelog. The model preserves
// per-heading bullet formatting (dense vs. blank-line-separated) by tracking
// each bullet's raw line range and whether the block uses blank-line
// separation between bullets.
function parseUnreleasedSections(lines, startIdx, endIdx) {
  // sections[]: { headingLine, bodyStart, bodyEnd (exclusive within Unreleased) }
  const sections = [];
  let current;
  for (let i = startIdx + 1; i < endIdx; i += 1) {
    if (/^###\s+(.+?)\s*$/.test(lines[i])) {
      if (current) {
        current.bodyEnd = i;
        sections.push(current);
      }
      const heading = lines[i].match(/^###\s+(.+?)\s*$/)[1];
      current = { heading, headingLine: i, bodyStart: i + 1, bodyEnd: endIdx };
    }
  }
  if (current) {
    current.bodyEnd = endIdx;
    sections.push(current);
  }
  return sections;
}

function blockUsesBlankSeparated(lines, bodyStart, bodyEnd) {
  // True when at least one consecutive pair of bullets is separated by one or
  // more blank lines within the heading's body range.
  let sawBulletBefore = false;
  let blankSinceLastBullet = false;
  for (let i = bodyStart; i < bodyEnd; i += 1) {
    const line = lines[i];
    if (line.startsWith("- ")) {
      if (sawBulletBefore && blankSinceLastBullet) return true;
      sawBulletBefore = true;
      blankSinceLastBullet = false;
    } else if (line.trim() === "") {
      if (sawBulletBefore) blankSinceLastBullet = true;
    }
  }
  return false;
}

function findInsertionIndexForExistingHeading(lines, bodyStart, bodyEnd) {
  // The end of the heading's last bullet content: walk forward until the
  // first trailing blank-line run before bodyEnd. Insertion index is the
  // position of that first trailing blank line (so we splice the new bullet
  // before the blank lines and keep the blank line that separated this
  // heading from the next one).
  let lastNonBlank = bodyStart - 1;
  for (let i = bodyStart; i < bodyEnd; i += 1) {
    if (lines[i].trim() !== "") lastNonBlank = i;
  }
  return lastNonBlank + 1;
}

function buildBulletLines(bullet, blankSeparated, isFirstAppendedInBlock, hasPriorBulletInBlock) {
  // Insert the bullet (which may already be multi-line). When blank-separated
  // and there's a prior bullet in the block, prepend a blank line.
  const bulletLines = bullet.split("\n");
  if (blankSeparated && hasPriorBulletInBlock) {
    return ["", ...bulletLines];
  }
  // Otherwise (dense block, or no prior bullet) the bullet is appended with no
  // extra separating blank line.
  void isFirstAppendedInBlock;
  return bulletLines;
}

function buildNewHeadingLines(heading, bullets) {
  // New heading inserted into Unreleased. Use the canonical dense format:
  //   ### Heading
  //   <blank>
  //   - bullet1
  //   - bullet2
  //   <blank>
  // The trailing blank is what separates this heading from whatever follows.
  const out = [`### ${heading}`, ""];
  for (const bullet of bullets) {
    out.push(...bullet.split("\n"));
  }
  out.push("");
  return out;
}

function findCanonicalInsertionIndex(sections, heading, endIdx, lines) {
  // Position where a new canonical heading should be inserted: before the
  // first existing canonical heading that comes AFTER this one in canonical
  // order. If none, insert at the end of Unreleased (before trailing blank
  // lines so we don't accumulate them).
  const myOrder = CANONICAL_HEADINGS.indexOf(heading);
  for (const section of sections) {
    const otherOrder = CANONICAL_HEADINGS.indexOf(section.heading);
    if (otherOrder >= 0 && otherOrder > myOrder) {
      return section.headingLine;
    }
  }
  // Insert before trailing blank lines at the end of Unreleased.
  let insertAt = endIdx;
  while (insertAt > 0 && lines[insertAt - 1].trim() === "") insertAt -= 1;
  return insertAt;
}

/**
 * Append bullets into CHANGELOG.md under `## Unreleased`. Returns the new
 * text and how many bullets were actually inserted (after fingerprint
 * deduplication).
 *
 * Throws when `## Unreleased` is missing.
 */
export function appendBulletsToChangelog(changelogText, buckets) {
  const lines = normalizeLines(changelogText);
  const extracted = extractUnreleasedContent(changelogText);
  if (!extracted) {
    throw new Error("CHANGELOG.md is missing the '## Unreleased' section; refusing to write.");
  }
  const fingerprints = computeUnreleasedFingerprints(changelogText);

  // Build deduplicated per-heading bullet lists in canonical order, ignoring
  // unknown headings (validation should have already rejected them).
  const queue = [];
  let added = 0;
  for (const heading of CANONICAL_HEADINGS) {
    const incoming = buckets instanceof Map ? buckets.get(heading) ?? [] : [];
    const kept = [];
    for (const bullet of incoming) {
      const fp = sha256(`${heading}\n${bullet}`);
      if (fingerprints.has(fp)) continue;
      fingerprints.add(fp);
      kept.push(bullet);
    }
    if (kept.length > 0) {
      queue.push({ heading, bullets: kept });
      added += kept.length;
    }
  }
  if (added === 0) {
    return { text: changelogText, added: 0 };
  }

  // Apply edits from high line index to low so earlier edits don't shift
  // later positions. Determine each edit's position from the CURRENT lines
  // and Unreleased bounds.
  let { startIdx, endIdx } = extracted;
  let workingLines = lines.slice();

  // First pass: compute edit set against the original layout. Re-parse after
  // each splice so positions stay correct.
  for (const { heading, bullets } of queue) {
    const sections = parseUnreleasedSections(workingLines, startIdx, endIdx);
    const existing = sections.find((s) => s.heading === heading);
    if (existing) {
      const blankSeparated = blockUsesBlankSeparated(workingLines, existing.bodyStart, existing.bodyEnd);
      const insertAt = findInsertionIndexForExistingHeading(workingLines, existing.bodyStart, existing.bodyEnd);
      const linesToInsert = [];
      for (let i = 0; i < bullets.length; i += 1) {
        linesToInsert.push(...buildBulletLines(bullets[i], blankSeparated, i === 0, true));
      }
      workingLines.splice(insertAt, 0, ...linesToInsert);
      endIdx += linesToInsert.length;
    } else {
      const insertAt = findCanonicalInsertionIndex(sections, heading, endIdx, workingLines);
      const headingBlock = buildNewHeadingLines(heading, bullets);
      // If we're inserting at the end of Unreleased and the line before
      // insertAt is not blank, prepend a blank line so the new heading is
      // separated from the previous content.
      const needsLeadingBlank = insertAt > 0 && workingLines[insertAt - 1].trim() !== "";
      const blockToInsert = needsLeadingBlank ? ["", ...headingBlock] : headingBlock;
      workingLines.splice(insertAt, 0, ...blockToInsert);
      endIdx += blockToInsert.length;
    }
  }

  // Preserve trailing newline behavior of the input.
  const hadTrailingNewline = changelogText.endsWith("\n");
  let out = workingLines.join("\n");
  if (hadTrailingNewline && !out.endsWith("\n")) out += "\n";
  return { text: out, added };
}

async function readStdin() {
  return await new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buf += chunk;
    });
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
  });
}

async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const changelogPath = path.join(repoRoot, "CHANGELOG.md");

  const prBody = await readStdin();
  const block = extractBlock(prBody);
  if (!block) {
    console.log("sync-changelog-from-pr: no <!-- pi-mmr changelog --> block found; skipping.");
    return;
  }

  const buckets = parseBlock(block);
  const errors = validateBuckets(buckets, prBody);
  if (errors.length > 0) {
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }

  const original = readFileSync(changelogPath, "utf8");
  let next;
  try {
    next = appendBulletsToChangelog(original, buckets);
  } catch (error) {
    console.error(`- ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  if (next.added === 0) {
    console.log("sync-changelog-from-pr: no update needed (all bullets already present under ## Unreleased).");
    return;
  }

  writeFileSync(changelogPath, next.text, "utf8");
  console.log(`Appended ${next.added} bullet(s) to CHANGELOG.md under ## Unreleased.`);
}

const invokedAsCli = (() => {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedAsCli) {
  main().catch((error) => {
    console.error(`- ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
