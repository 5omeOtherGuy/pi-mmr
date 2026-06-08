// Phase C metadata invariants. Drives the metadata updates for
// mmr-web's web_search and read_web_page tools, plus apply_patch
// redaction/failure guidance. Tests are written first; metadata edits
// follow to make them pass.

import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import {
  cleanupLoadedSource,
  importSource,
} from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

describe("Phase C: mmr-web web_search metadata", () => {
  let mod;

  beforeEach(async () => {
    mod = await importSource("extensions/mmr-web/tools.ts");
  });

  it("description tells the model when to use web_search (up-to-date or precise documentation)", () => {
    const text = mod.WEB_SEARCH_DESCRIPTION;
    assert.match(
      text,
      /up-to-date|precise documentation/i,
      "description should explain when to reach for web_search",
    );
  });

  it("description directs the model to read_web_page for fetching a specific URL", () => {
    const text = mod.WEB_SEARCH_DESCRIPTION;
    assert.match(text, /read_web_page/, "description should reference read_web_page as a sibling tool");
  });

  it("description names Brave Search as the only search provider and keeps security guidance", () => {
    const text = mod.WEB_SEARCH_DESCRIPTION;
    assert.match(text, /Brave Search/i, "description should name the active search provider");
    assert.doesNotMatch(text, /Jina/i, "description must not advertise the removed Jina provider");
    assert.match(
      text,
      /secrets|API key|private data/i,
      "description should keep the security/redaction guidance",
    );
  });

  it("objective parameter description mentions source or freshness guidance", () => {
    const objective = mod.WEB_SEARCH_PARAMETERS_SCHEMA.properties.objective;
    assert.match(
      objective.description,
      /source|freshness/i,
      "objective parameter description should hint at source/freshness guidance",
    );
  });

  it("search_queries parameter description names the first-non-empty-query semantics", () => {
    const queries = mod.WEB_SEARCH_PARAMETERS_SCHEMA.properties.search_queries;
    assert.match(
      queries.description,
      /first non-empty/i,
      "search_queries parameter description should mention the first-non-empty-query rule",
    );
  });

  it("every web_search prompt guideline names the tool", () => {
    const guidelines = mod.WEB_SEARCH_PROMPT_GUIDELINES;
    assert.ok(guidelines.length > 0);
    for (const bullet of guidelines) {
      assert.match(
        bullet,
        /web_search/,
        `guideline should name web_search: "${bullet}"`,
      );
    }
  });
});

describe("Phase C: mmr-web read_web_page metadata", () => {
  let mod;

  beforeEach(async () => {
    mod = await importSource("extensions/mmr-web/tools.ts");
  });

  it("description tells the model that url-only returns Markdown", () => {
    const text = mod.READ_WEB_PAGE_DESCRIPTION;
    assert.match(text, /Markdown/i);
    assert.match(
      text,
      /only the url|when only the url|url-only|just the url/i,
      "description should clarify the url-only behavior",
    );
  });

  it("description tells the model that objective returns relevant excerpts", () => {
    const text = mod.READ_WEB_PAGE_DESCRIPTION;
    assert.match(text, /objective/i);
    assert.match(text, /excerpt/i);
  });

  it("description describes forceRefetch truthfully (accepted for compatibility, reader always fetches live)", () => {
    const text = mod.READ_WEB_PAGE_DESCRIPTION;
    assert.match(text, /forceRefetch/);
    assert.match(text, /compatibility/i);
    assert.match(text, /live fetch/i);
    // Must not promise cache-busting: the reader has no cache layer.
    assert.doesNotMatch(
      text,
      /cached version|bypass.*cache|days old/i,
      "description must not promise cache-busting behavior the reader cannot provide",
    );
  });

  it("description keeps the local/private URL restriction and names the custom reader", () => {
    const text = mod.READ_WEB_PAGE_DESCRIPTION;
    assert.match(text, /localhost|private/i);
    assert.match(text, /custom|in-process/i);
    assert.doesNotMatch(text, /Jina/i, "description must not advertise the removed Jina reader");
  });

  it("every read_web_page prompt guideline names the tool and avoids over-broad curl instructions", () => {
    const guidelines = mod.READ_WEB_PAGE_PROMPT_GUIDELINES;
    assert.ok(guidelines.length > 0);
    for (const bullet of guidelines) {
      assert.match(
        bullet,
        /read_web_page/,
        `guideline should name read_web_page: "${bullet}"`,
      );
      assert.equal(
        /\buse\s+curl\b/i.test(bullet),
        false,
        `guideline should not direct the model to bare curl: "${bullet}"`,
      );
    }
  });
});

describe("Phase C: mmr-toolbox apply_patch redaction/failure guidance", () => {
  let mod;

  beforeEach(async () => {
    mod = await importSource("extensions/mmr-toolbox/index.ts");
  });

  it("prompt guidelines include a redaction/failure note", () => {
    const guidelines = mod.APPLY_PATCH_PROMPT_GUIDELINES;
    const joined = guidelines.join("\n");
    assert.match(
      joined,
      /redact|secret|fail|error|reject/i,
      "apply_patch prompt guidelines should advise on redaction or failure handling",
    );
  });

  it("every apply_patch prompt guideline names the tool", () => {
    const guidelines = mod.APPLY_PATCH_PROMPT_GUIDELINES;
    for (const bullet of guidelines) {
      assert.match(
        bullet,
        /apply_patch/,
        `guideline should name apply_patch: "${bullet}"`,
      );
    }
  });
});
