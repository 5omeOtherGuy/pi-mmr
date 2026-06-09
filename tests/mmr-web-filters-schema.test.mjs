import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

function settings(partial = {}) {
  return {
    enabled: true,
    backend: "auto",
    searchBackend: undefined,
    readerBackend: undefined,
    braveApiKey: "brv",
    searxngUrl: undefined,
    searchTimeoutMs: 30000,
    readTimeoutMs: 30000,
    maxResultBytes: 200000,
    ...partial,
  };
}

function braveJson(results) {
  return new Response(JSON.stringify({ web: { results } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function makeFetchMock(handler) {
  const calls = [];
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    calls.push({ url });
    return handler({ url });
  };
  return { fetchImpl, calls };
}

describe("web_search schema — filter fields", () => {
  it("declares optional include_domains/exclude_domains arrays and a recency enum", async () => {
    const { createWebSearchTool } = await importSource("extensions/mmr-web/tools.ts");
    const tool = createWebSearchTool({ getSettings: () => settings() });
    const props = tool.parameters.properties;
    assert.equal(props.include_domains.type, "array");
    assert.equal(props.exclude_domains.type, "array");
    // recency is a union of string literals (day/week/month/year)
    const recency = props.recency;
    const variants = recency.anyOf ?? recency.enum ?? [];
    const values = recency.enum
      ? recency.enum
      : variants.map((v) => v.const).filter((v) => typeof v === "string");
    assert.deepEqual([...values].sort(), ["day", "month", "week", "year"]);
    // country is an optional 2-letter string
    assert.equal(props.country.type, "string");
    assert.equal(props.country.pattern, "^[A-Za-z]{2}$");
    // all new fields remain optional
    assert.deepEqual(tool.parameters.required, ["objective"]);
  });
});

describe("web_search execute — filter passthrough and reporting", () => {
  it("normalizes domains (scheme/www/case/path stripped) and passes them to the backend; reports details.filters", async () => {
    const { createWebSearchTool } = await importSource("extensions/mmr-web/tools.ts");
    const { fetchImpl, calls } = makeFetchMock(() =>
      braveJson([
        { title: "A", url: "https://docs.example.com/a", description: "alpha" },
        { title: "B", url: "https://other.com/b", description: "beta" },
      ]),
    );
    const tool = createWebSearchTool({
      getSettings: () => settings(),
      getBraveOptions: () => ({ apiKey: "brv", fetchImpl }),
    });
    const result = await tool.execute(
      "c1",
      {
        objective: "find docs",
        include_domains: ["HTTPS://WWW.Example.com/some/path", "  example.com  "],
        recency: "week",
      },
      undefined,
      undefined,
      {},
    );
    // recency mapped to Brave freshness natively
    assert.equal(calls[0].url.searchParams.get("freshness"), "pw");
    // include domain post-filtered to example.com only
    assert.deepEqual(result.details.resultCount, 1);
    assert.match(result.content[0].text, /^https:\/\/docs\.example\.com\/a$/m);
    assert.doesNotMatch(result.content[0].text, /^https:\/\/other\.com\/b$/m);
    // details.filters reports honored enforcement
    const include = result.details.filters.find((f) => f.filter === "include_domains");
    assert.deepEqual({ s: include.support, h: include.honored }, { s: "post_filter", h: "full" });
    const recency = result.details.filters.find((f) => f.filter === "recency");
    assert.deepEqual({ s: recency.support, h: recency.honored }, { s: "native", h: "full" });
  });

  it("passes a country code to the Brave backend and reports it native/full in details.filters", async () => {
    const { createWebSearchTool } = await importSource("extensions/mmr-web/tools.ts");
    const { fetchImpl, calls } = makeFetchMock(() => braveJson([{ title: "A", url: "https://x/a" }]));
    const tool = createWebSearchTool({
      getSettings: () => settings(),
      getBraveOptions: () => ({ apiKey: "brv", fetchImpl }),
    });
    const result = await tool.execute("cc", { objective: "x", country: "DE" }, undefined, undefined, {});
    // normalized to lowercase by the tool, then uppercased by the Brave backend
    assert.equal(calls[0].url.searchParams.get("country"), "DE");
    const country = result.details.filters.find((f) => f.filter === "country");
    assert.deepEqual({ s: country.support, h: country.honored }, { s: "native", h: "full" });
  });

  it("rejects an invalid country code before any network call", async () => {
    const { createWebSearchTool } = await importSource("extensions/mmr-web/tools.ts");
    const { fetchImpl, calls } = makeFetchMock(() => braveJson([]));
    const tool = createWebSearchTool({
      getSettings: () => settings(),
      getBraveOptions: () => ({ apiKey: "brv", fetchImpl }),
    });
    await assert.rejects(
      () => tool.execute("cx", { objective: "x", country: "deu" }, undefined, undefined, {}),
      /invalid parameters|country/i,
    );
    assert.equal(calls.length, 0);
  });

  it("reports details.filters as an empty array when no filters are requested", async () => {
    const { createWebSearchTool } = await importSource("extensions/mmr-web/tools.ts");
    const { fetchImpl } = makeFetchMock(() => braveJson([{ title: "A", url: "https://x/a" }]));
    const tool = createWebSearchTool({
      getSettings: () => settings(),
      getBraveOptions: () => ({ apiKey: "brv", fetchImpl }),
    });
    const result = await tool.execute("c2", { objective: "x" }, undefined, undefined, {});
    assert.deepEqual(result.details.filters, []);
  });

  it("rejects a domain present in both include and exclude (conflict) without calling fetch", async () => {
    const { createWebSearchTool } = await importSource("extensions/mmr-web/tools.ts");
    const { fetchImpl, calls } = makeFetchMock(() => braveJson([]));
    const tool = createWebSearchTool({
      getSettings: () => settings(),
      getBraveOptions: () => ({ apiKey: "brv", fetchImpl }),
    });
    await assert.rejects(
      () =>
        tool.execute(
          "c3",
          { objective: "x", include_domains: ["example.com"], exclude_domains: ["www.example.com"] },
          undefined,
          undefined,
          {},
        ),
      /both include_domains and exclude_domains|conflict/i,
    );
    assert.equal(calls.length, 0);
  });

  it("rejects an invalid recency value before any network call", async () => {
    const { createWebSearchTool } = await importSource("extensions/mmr-web/tools.ts");
    const fetchImpl = async () => {
      throw new Error("fetch must not be called for invalid params");
    };
    const tool = createWebSearchTool({
      getSettings: () => settings(),
      getBraveOptions: () => ({ apiKey: "brv", fetchImpl }),
    });
    await assert.rejects(
      () => tool.execute("c4", { objective: "x", recency: "decade" }, undefined, undefined, {}),
      /invalid parameters|recency/i,
    );
  });
});
