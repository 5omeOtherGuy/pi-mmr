import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const QUERY_MODULE = "extensions/mmr-history/query.ts";
const NOW = new Date("2026-06-07T00:00:00Z");

describe("mmr-history parseSessionQuery date filters", () => {
  it("records an unparseable after: value in invalidFilters and does not apply it", async () => {
    const { parseSessionQuery } = await importSource(QUERY_MODULE);
    const parsed = parseSessionQuery("after:not-a-date hello", NOW);

    assert.equal(parsed.after, undefined, "an invalid after: must not constrain results");
    assert.deepEqual(parsed.invalidFilters, ["after:not-a-date"]);
    assert.ok(!parsed.appliedFilterTokens.includes("after:not-a-date"), "an invalid token is not applied");
    assert.deepEqual(parsed.terms, ["hello"]);
  });

  it("records an unparseable before: value in invalidFilters and does not apply it", async () => {
    const { parseSessionQuery } = await importSource(QUERY_MODULE);
    const parsed = parseSessionQuery("before:2020-13-99", NOW);

    assert.equal(parsed.before, undefined);
    assert.deepEqual(parsed.invalidFilters, ["before:2020-13-99"]);
    assert.ok(!parsed.appliedFilterTokens.includes("before:2020-13-99"));
  });

  it("still applies a valid relative after: filter and lands it in appliedFilterTokens", async () => {
    const { parseSessionQuery } = await importSource(QUERY_MODULE);
    const parsed = parseSessionQuery("after:7d", NOW);

    assert.ok(parsed.after instanceof Date, "a valid relative date applies");
    assert.equal(parsed.after.getTime(), NOW.getTime() - 7 * 24 * 60 * 60 * 1000);
    assert.deepEqual(parsed.invalidFilters, []);
    assert.ok(parsed.appliedFilterTokens.includes("after:7d"));
  });

  it("still applies a valid absolute after: filter", async () => {
    const { parseSessionQuery } = await importSource(QUERY_MODULE);
    const parsed = parseSessionQuery("after:2026-01-01", NOW);

    assert.ok(parsed.after instanceof Date);
    assert.deepEqual(parsed.invalidFilters, []);
    assert.ok(parsed.appliedFilterTokens.includes("after:2026-01-01"));
  });
});
