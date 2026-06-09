import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const BASE_ARGS = { maxResults: 5, maxResultBytes: 200000 };

function captureFetch(handler) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return handler({ url, init });
  };
  return { fetchImpl, calls };
}

function braveBody(urls) {
  return JSON.stringify({
    web: { results: urls.map((u, i) => ({ title: `t${i}`, url: u, description: `d${i}` })) },
  });
}

function searxngBody(urls) {
  return JSON.stringify({
    results: urls.map((u, i) => ({ title: `t${i}`, url: u, content: `d${i}` })),
  });
}

function ddgRow(url, title) {
  return `<div class="result results_links results_links_deep web-result">
    <h2 class="result__title"><a class="result__a" href="${url}">${title}</a></h2>
    <a class="result__snippet" href="${url}">snippet</a>
  </div></div>`;
}

describe("brave backend — filters", () => {
  it("maps recency to a native freshness param and reports recency native/full", async () => {
    const { braveSearch } = await importSource("extensions/mmr-web/search/brave.ts");
    const { fetchImpl, calls } = captureFetch(() =>
      new Response(braveBody(["https://a.com/1"]), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const res = await braveSearch(
      { ...BASE_ARGS, query: "x", recency: "week" },
      { apiKey: "k", fetchImpl },
    );
    assert.equal(calls[0].url.searchParams.get("freshness"), "pw");
    const recency = res.appliedFilters.find((f) => f.filter === "recency");
    assert.deepEqual({ support: recency.support, honored: recency.honored }, { support: "native", honored: "full" });
  });

  it("post-filters domains on result hostnames and reports include_domains post_filter/full", async () => {
    const { braveSearch } = await importSource("extensions/mmr-web/search/brave.ts");
    const { fetchImpl } = captureFetch(() =>
      new Response(braveBody(["https://docs.example.com/1", "https://other.com/2"]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await braveSearch(
      { ...BASE_ARGS, query: "x", includeDomains: ["example.com"] },
      { apiKey: "k", fetchImpl },
    );
    assert.deepEqual(res.results.map((r) => r.url), ["https://docs.example.com/1"]);
    const include = res.appliedFilters.find((f) => f.filter === "include_domains");
    assert.deepEqual({ support: include.support, honored: include.honored }, { support: "post_filter", honored: "full" });
  });

  it("reports no appliedFilters when none requested", async () => {
    const { braveSearch } = await importSource("extensions/mmr-web/search/brave.ts");
    const { fetchImpl, calls } = captureFetch(() =>
      new Response(braveBody(["https://a.com/1"]), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const res = await braveSearch({ ...BASE_ARGS, query: "x" }, { apiKey: "k", fetchImpl });
    assert.deepEqual(res.appliedFilters, []);
    assert.equal(calls[0].url.searchParams.has("freshness"), false);
  });
});

describe("searxng backend — filters", () => {
  it("maps recency to a native time_range param and reports recency native/full", async () => {
    const { searxngSearch } = await importSource("extensions/mmr-web/search/searxng.ts");
    const { fetchImpl, calls } = captureFetch(() =>
      new Response(searxngBody(["https://a.com/1"]), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const res = await searxngSearch(
      { ...BASE_ARGS, query: "x", recency: "month" },
      { url: "http://127.0.0.1:8080", fetchImpl },
    );
    assert.equal(calls[0].url.searchParams.get("time_range"), "month");
    const recency = res.appliedFilters.find((f) => f.filter === "recency");
    assert.deepEqual({ support: recency.support, honored: recency.honored }, { support: "native", honored: "full" });
  });

  it("does not send a country param (SearXNG ignores it) and reports it unsupported/none", async () => {
    const { searxngSearch } = await importSource("extensions/mmr-web/search/searxng.ts");
    const { fetchImpl, calls } = captureFetch(() =>
      new Response(searxngBody(["https://a.com/1"]), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const res = await searxngSearch(
      { ...BASE_ARGS, query: "x", country: "de" },
      { url: "http://127.0.0.1:8080", fetchImpl },
    );
    assert.equal(calls[0].url.searchParams.has("country"), false);
    const country = res.appliedFilters.find((f) => f.filter === "country");
    assert.deepEqual(
      { support: country.support, honored: country.honored },
      { support: "unsupported", honored: "none" },
    );
    assert.equal(
      country.reason,
      "SearXNG's search API has no country parameter; this backend does not currently expose SearXNG locale/language targeting, so country is unsupported.",
    );
  });

  it("post-filters domains and reports exclude_domains post_filter/full", async () => {
    const { searxngSearch } = await importSource("extensions/mmr-web/search/searxng.ts");
    const { fetchImpl } = captureFetch(() =>
      new Response(searxngBody(["https://keep.com/1", "https://drop.example.com/2"]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await searxngSearch(
      { ...BASE_ARGS, query: "x", excludeDomains: ["example.com"] },
      { url: "http://127.0.0.1:8080", fetchImpl },
    );
    assert.deepEqual(res.results.map((r) => r.url), ["https://keep.com/1"]);
    const exclude = res.appliedFilters.find((f) => f.filter === "exclude_domains");
    assert.deepEqual({ support: exclude.support, honored: exclude.honored }, { support: "post_filter", honored: "full" });
  });
});

describe("duckduckgo backend — filters", () => {
  it("post-filters domains but reports recency as unsupported/none with a reason", async () => {
    const { duckduckgoSearch, __resetDuckDuckGoStateForTests } = await importSource(
      "extensions/mmr-web/search/duckduckgo.ts",
    );
    __resetDuckDuckGoStateForTests();
    const html = `<html><body>${ddgRow("https://keep.com/1", "Keep")}${ddgRow("https://drop.example.com/2", "Drop")}</body></html>`;
    const { fetchImpl } = captureFetch(() =>
      new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
    );
    const res = await duckduckgoSearch(
      { ...BASE_ARGS, query: "x", excludeDomains: ["example.com"], recency: "day" },
      { fetchImpl },
    );
    assert.deepEqual(res.results.map((r) => r.url), ["https://keep.com/1"]);
    const exclude = res.appliedFilters.find((f) => f.filter === "exclude_domains");
    assert.equal(exclude.support, "post_filter");
    const recency = res.appliedFilters.find((f) => f.filter === "recency");
    assert.deepEqual({ support: recency.support, honored: recency.honored }, { support: "unsupported", honored: "none" });
    assert.equal(typeof recency.reason, "string");
    assert.ok(recency.reason.length > 0);
  });
});
