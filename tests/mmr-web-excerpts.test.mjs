import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const SAMPLE_MARKDOWN = `# Birds of the World

Welcome to the comprehensive guide.

## Sparrows

Sparrows are small passerine birds. The house sparrow is the most common
species worldwide and lives in close association with humans.

Sparrows eat seeds and grains. They form noisy flocks.

## Eagles

Eagles are large birds of prey. The bald eagle is the national bird of the
United States and feeds primarily on fish.

## Cooking

This section is about cooking dinner and has nothing to do with birds.
Pasta sauce can be made from tomatoes, onions, and garlic.
`;

describe("extractObjectiveRelevantExcerpts", () => {
  it("returns excerpted=false when objective is blank", async () => {
    const { extractObjectiveRelevantExcerpts } = await importSource(
      "extensions/mmr-web/excerpts.ts",
    );
    const result = extractObjectiveRelevantExcerpts({
      markdown: SAMPLE_MARKDOWN,
      objective: "   ",
      maxBytes: 10_000,
    });
    assert.equal(result.excerpted, false);
    assert.deepEqual(result.excerpts, []);
  });

  it("returns excerpts relevant to the objective and skips unrelated sections", async () => {
    const { extractObjectiveRelevantExcerpts } = await importSource(
      "extensions/mmr-web/excerpts.ts",
    );
    const result = extractObjectiveRelevantExcerpts({
      markdown: SAMPLE_MARKDOWN,
      objective: "tell me about the house sparrow",
      maxBytes: 10_000,
    });
    assert.equal(result.excerpted, true);
    assert.ok(result.excerpts.length >= 1);
    const joined = result.excerpts.join("\n\n");
    assert.match(joined, /house sparrow/i);
    assert.doesNotMatch(joined, /pasta sauce/i);
  });

  it("includes the heading context with each excerpt", async () => {
    const { extractObjectiveRelevantExcerpts } = await importSource(
      "extensions/mmr-web/excerpts.ts",
    );
    const result = extractObjectiveRelevantExcerpts({
      markdown: SAMPLE_MARKDOWN,
      objective: "bald eagle",
      maxBytes: 10_000,
    });
    assert.equal(result.excerpted, true);
    const joined = result.excerpts.join("\n\n");
    // The "## Eagles" heading should be carried into the excerpt.
    assert.match(joined, /##\s*Eagles/);
    assert.match(joined, /bald eagle/i);
  });

  it("returns excerpted=false when no passage clears the relevance threshold", async () => {
    const { extractObjectiveRelevantExcerpts } = await importSource(
      "extensions/mmr-web/excerpts.ts",
    );
    const result = extractObjectiveRelevantExcerpts({
      markdown: SAMPLE_MARKDOWN,
      objective: "quantum chromodynamics renormalization",
      maxBytes: 10_000,
    });
    assert.equal(result.excerpted, false);
    assert.deepEqual(result.excerpts, []);
  });

  it("preserves original document order in returned excerpts", async () => {
    const { extractObjectiveRelevantExcerpts } = await importSource(
      "extensions/mmr-web/excerpts.ts",
    );
    const markdown = `# Top

## Alpha

Alpha is the first letter.

## Beta

Beta is the second letter.

## Alpha Beta

Together alpha and beta are common.
`;
    const result = extractObjectiveRelevantExcerpts({
      markdown,
      objective: "alpha beta",
      maxBytes: 10_000,
    });
    assert.equal(result.excerpted, true);
    const positions = result.excerpts.map((excerpt) => markdown.indexOf(excerpt.split("\n").pop()));
    for (let i = 1; i < positions.length; i++) {
      assert.ok(positions[i] >= positions[i - 1], "excerpts should be in document order");
    }
  });

  it("honors maxBytes when selecting top excerpts", async () => {
    const { extractObjectiveRelevantExcerpts } = await importSource(
      "extensions/mmr-web/excerpts.ts",
    );
    // Each section's heading repeats the objective tokens so every passage
    // clears the relevance gate; the byte budget is the only remaining
    // constraint exercised here.
    const big = Array.from({ length: 20 }, (_, i) => `## Widget Details ${i}\n\nThis paragraph mentions widget details in section ${i}.`).join("\n\n");
    const result = extractObjectiveRelevantExcerpts({
      markdown: big,
      objective: "widget details",
      maxBytes: 300,
    });
    assert.equal(result.excerpted, true);
    const joined = result.excerpts.join("\n\n---\n\n");
    assert.ok(Buffer.byteLength(joined, "utf8") <= 600, `joined bytes (${Buffer.byteLength(joined, "utf8")}) should respect the budget`);
  });

  it("caps excerpt count at MAX_EXCERPTS even when the byte budget allows more", async () => {
    const { extractObjectiveRelevantExcerpts, MAX_EXCERPTS } = await importSource(
      "extensions/mmr-web/excerpts.ts",
    );
    assert.equal(typeof MAX_EXCERPTS, "number");
    assert.ok(MAX_EXCERPTS >= 1, "MAX_EXCERPTS must be positive");
    // 20 strongly-matching sections; without the cap, all 20 would fit.
    const markdown = Array.from({ length: 20 }, (_, i) =>
      `## Widget Details ${i}\n\nThis paragraph mentions widget details in section ${i}.`,
    ).join("\n\n");
    const result = extractObjectiveRelevantExcerpts({
      markdown,
      objective: "widget details",
      maxBytes: 1_000_000,
    });
    assert.equal(result.excerpted, true);
    assert.ok(
      result.excerpts.length <= MAX_EXCERPTS,
      `got ${result.excerpts.length} excerpts, expected <= MAX_EXCERPTS (${MAX_EXCERPTS})`,
    );
  });

  it("drops passages with only a single weak body-token match (no phrase, no heading)", async () => {
    const { extractObjectiveRelevantExcerpts } = await importSource(
      "extensions/mmr-web/excerpts.ts",
    );
    const markdown = `# Topic\n\n## Background\n\nIntroduction with no relevant content here.\n\n## Other Stuff\n\nThe word labradoodle appears once here in passing.\n\n## Breeding\n\nLabradoodle breeding requires careful planning of both parent lines.`;
    const result = extractObjectiveRelevantExcerpts({
      markdown,
      objective: "labradoodle breeding",
      maxBytes: 10_000,
    });
    assert.equal(result.excerpted, true);
    const joined = result.excerpts.join("\n");
    // The "## Breeding" passage has both tokens plus a heading hit, so it
    // must be selected.
    assert.match(joined, /Breeding/);
    assert.match(joined, /careful planning/);
    // The "## Other Stuff" passage mentions "labradoodle" once and nothing
    // else; under the raised threshold it must be dropped.
    assert.doesNotMatch(joined, /appears once here in passing/);
  });

  it("recognizes quoted exact phrases", async () => {
    const { extractObjectiveRelevantExcerpts } = await importSource(
      "extensions/mmr-web/excerpts.ts",
    );
    const markdown = `# Doc

The phrase house sparrow appears here verbatim.

Random unrelated content about cars.

A passage mentioning house and sparrow separately is less relevant.
`;
    const result = extractObjectiveRelevantExcerpts({
      markdown,
      objective: 'find the "house sparrow" phrase',
      maxBytes: 10_000,
    });
    assert.equal(result.excerpted, true);
    assert.match(result.excerpts[0], /house sparrow/);
  });

  it("does not repeat the heading prefix on consecutive same-trail excerpts", async () => {
    const { extractObjectiveRelevantExcerpts } = await importSource(
      "extensions/mmr-web/excerpts.ts",
    );
    // Three sibling passages directly under the same H2 heading. With the
    // pre-fix behavior each emitted excerpt carried its own "## Breeding\n\n"
    // prefix, causing the heading to appear three times in the joined output.
    // After dedup, only the first of a same-trail run keeps the heading.
    const markdown = `# Doc\n\n## Breeding\n\nFirst paragraph about breeding practices and parent lines.\n\nSecond paragraph about breeding genetics and screening protocols.\n\nThird paragraph about breeding certifications and breeder selection.`;
    const result = extractObjectiveRelevantExcerpts({
      markdown,
      objective: "breeding practices",
      maxBytes: 10_000,
    });
    assert.equal(result.excerpted, true);
    assert.ok(result.excerpts.length >= 2, `expected >=2 excerpts, got ${result.excerpts.length}`);
    const joined = result.excerpts.join("\n\n");
    const headingCount = (joined.match(/^##\s+Breeding\b/gm) ?? []).length;
    assert.equal(headingCount, 1, `heading should appear once across consecutive same-trail excerpts; got ${headingCount}`);
    // First excerpt of a same-heading run keeps the heading prefix for
    // context; subsequent ones emit body text only.
    assert.match(result.excerpts[0], /##\s+Breeding/, "first excerpt of a trail keeps the heading prefix");
    for (let i = 1; i < result.excerpts.length; i++) {
      assert.doesNotMatch(result.excerpts[i], /##\s+Breeding/, `consecutive same-trail excerpt #${i} should not repeat the heading prefix`);
    }
  });

  it("restores the heading prefix when the trail changes between excerpts", async () => {
    const { extractObjectiveRelevantExcerpts } = await importSource(
      "extensions/mmr-web/excerpts.ts",
    );
    // Two passages under "## Breeding", then a passage under "## Health". The
    // first Health excerpt must keep its heading prefix because the trail
    // changed.
    const markdown = `# Doc\n\n## Breeding\n\nBreeding paragraph one mentions breeding practices.\n\nBreeding paragraph two mentions breeding genetics.\n\n## Health\n\nHealth paragraph mentions breeding-related health screening.`;
    const result = extractObjectiveRelevantExcerpts({
      markdown,
      objective: "breeding practices health",
      maxBytes: 10_000,
    });
    assert.equal(result.excerpted, true);
    const joined = result.excerpts.join("\n\n");
    assert.equal((joined.match(/^##\s+Breeding\b/gm) ?? []).length, 1, "Breeding heading should appear exactly once");
    assert.equal((joined.match(/^##\s+Health\b/gm) ?? []).length, 1, "Health heading should appear exactly once (trail change restores prefix)");
  });

  it("demotes passages under References-style headings below body content", async () => {
    const { extractObjectiveRelevantExcerpts } = await importSource(
      "extensions/mmr-web/excerpts.ts",
    );
    // Both passages mention the objective tokens; the References-section
    // passage should be demoted so the body content wins under the
    // top-K / threshold gates.
    const markdown = `# Topic\n\n## Background\n\nLabradoodle breeding requires careful planning of parent lines and health screening before breeding.\n\n## References\n\nSmith, J. (2019). Labradoodle breeding practices. Journal of Dogs. Retrieved 2 January 2020.\n\nJones, K. (2020). Breeding genetics in labradoodle lines. ISBN 978-0-00-000000-0. Archived from the original.`;
    const result = extractObjectiveRelevantExcerpts({
      markdown,
      objective: "labradoodle breeding",
      maxBytes: 10_000,
    });
    assert.equal(result.excerpted, true);
    const joined = result.excerpts.join("\n\n");
    assert.match(joined, /careful planning of parent lines/, "body content under ## Background must be selected");
    assert.doesNotMatch(joined, /ISBN 978-0-00-000000-0/, "citation under ## References must be demoted out of the selection");
    assert.doesNotMatch(joined, /Journal of Dogs/, "citation under ## References must be demoted out of the selection");
  });

  it("demotes citation-dense passages even without an explicit References heading", async () => {
    const { extractObjectiveRelevantExcerpts } = await importSource(
      "extensions/mmr-web/excerpts.ts",
    );
    // Two passages under non-References headings; the first is normal body
    // prose, the second is a citation block (bracketed numerics, Retrieved
    // date, Archived from, ISBN). The citation passage must be demoted.
    const markdown = `# Topic\n\n## Overview\n\nLabradoodle breeding requires careful planning of parent lines and health screening before breeding.\n\n## Notes\n\n1. ^ Jump up to: a b c Smith, J. (26 September 2019). "Labradoodle breeding practices" [1]. Journal of Dogs [2]. Retrieved 27 September 2019. Archived from the original on 13 December 2019. ISBN 978-0-00-000000-0 [3].\n\n2. ^ Jones, K. "Breeding genetics" [4]. Retrieved 2 January 2020 [5]. Archived from the original [6].`;
    const result = extractObjectiveRelevantExcerpts({
      markdown,
      objective: "labradoodle breeding",
      maxBytes: 10_000,
    });
    assert.equal(result.excerpted, true);
    const joined = result.excerpts.join("\n\n");
    assert.match(joined, /careful planning of parent lines/, "body passage must be selected");
    assert.doesNotMatch(joined, /Jump up to/, "citation-dense passage must be demoted out of the selection");
    assert.doesNotMatch(joined, /Retrieved 27 September 2019/, "citation-dense passage must be demoted out of the selection");
  });

  it("caps final content on a valid UTF-8 boundary when a multibyte character crosses the cap", async () => {
    const { applyFinalContentCap, FINAL_CONTENT_CAP_BYTES, TRUNCATION_MARKER } = await importSource(
      "extensions/mmr-web/excerpts.ts",
    );
    const text = `${"a".repeat(FINAL_CONTENT_CAP_BYTES - 1)}\u20actail`;
    const result = applyFinalContentCap(text);
    assert.equal(result.truncated, true);
    assert.ok(result.text.endsWith(TRUNCATION_MARKER));
    assert.doesNotMatch(result.text, /\uFFFD/, "truncation must not leave a replacement character");
    const beforeMarker = result.text.slice(0, -TRUNCATION_MARKER.length);
    assert.ok(
      Buffer.byteLength(beforeMarker, "utf8") <= FINAL_CONTENT_CAP_BYTES,
      "content before the marker should not exceed the hard cap",
    );
  });

  it("keeps fenced code blocks intact", async () => {
    const { extractObjectiveRelevantExcerpts } = await importSource(
      "extensions/mmr-web/excerpts.ts",
    );
    const markdown = `# API Reference

## fetchUser

Use this function to fetch users.

\`\`\`ts
function fetchUser(id: string): Promise<User> {
  return api.get(\`/users/\${id}\`);
}
\`\`\`

Other unrelated text about cooking.
`;
    const result = extractObjectiveRelevantExcerpts({
      markdown,
      objective: "fetchUser implementation",
      maxBytes: 10_000,
    });
    assert.equal(result.excerpted, true);
    const joined = result.excerpts.join("\n\n");
    assert.match(joined, /```ts[\s\S]*```/);
  });
});
