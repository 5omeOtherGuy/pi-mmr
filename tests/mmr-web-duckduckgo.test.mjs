import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

function htmlResponse(body, init = {}) {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { "content-type": "text/html", ...(init.headers ?? {}) },
  });
}

function makeFetchMock(plan) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = typeof input === "string" || input instanceof URL ? new URL(String(input)) : new URL(input.url);
    calls.push({ url, init });
    const handler = plan.shift();
    if (!handler) throw new Error(`unexpected fetch call to ${url.toString()}`);
    return handler({ url, init });
  };
  return { fetchImpl, calls };
}

/**
 * Minimal DDG HTML response with two result rows, matching the structure
 * the public html.duckduckgo.com/html/ endpoint emits.
 */
function ddgResultsPage({ title1, url1, snippet1, title2, url2, snippet2 }) {
  const wrap = (u) =>
    `//duckduckgo.com/l/?uddg=${encodeURIComponent(u)}&amp;rut=abc`;
  return `<!DOCTYPE html><html><body>
<div class="result results_links results_links_deep web-result">
  <div class="result__body">
    <h2 class="result__title"><a class="result__a" href="${wrap(url1)}">${title1}</a></h2>
    <a class="result__snippet" href="${wrap(url1)}">${snippet1}</a>
  </div>
</div>
<div class="result results_links results_links_deep web-result">
  <div class="result__body">
    <h2 class="result__title"><a class="result__a" href="${wrap(url2)}">${title2}</a></h2>
    <a class="result__snippet" href="${wrap(url2)}">${snippet2}</a>
  </div>
</div>
</body></html>`;
}

function freshState() {
  return { cache: new Map(), blockedUntil: 0 };
}

describe("mmr-web DuckDuckGo client - search", () => {
  it("rejects an empty query", async () => {
    const { duckduckgoSearch } = await importSource("extensions/mmr-web/search/duckduckgo.ts");
    await assert.rejects(
      () => duckduckgoSearch({ query: "  ", maxResults: 5, maxResultBytes: 10000 }, { state: freshState() }),
      /non-empty query/,
    );
  });

  it("decodes uddg= redirect URLs back to the canonical target", async () => {
    const { decodeDuckDuckGoRedirect } = await importSource("extensions/mmr-web/search/duckduckgo.ts");
    assert.equal(
      decodeDuckDuckGoRedirect("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage%3Fq%3D1&rut=abc"),
      "https://example.com/page?q=1",
    );
    assert.equal(
      decodeDuckDuckGoRedirect("https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwiki%2Eexample%2Eorg%2FX"),
      "https://wiki.example.org/X",
    );
    // Non-DDG URLs are passed through unchanged.
    assert.equal(decodeDuckDuckGoRedirect("https://example.com/x"), "https://example.com/x");
  });

  it("does not double-decode percent-encoded bytes inside uddg target URLs", async () => {
    const { decodeDuckDuckGoRedirect } = await importSource("extensions/mmr-web/search/duckduckgo.ts");
    const target = "https://example.com/download/%25E2%259C%2593?q=%2520";
    const wrapped = `//duckduckgo.com/l/?uddg=${encodeURIComponent(target)}&rut=abc`;
    assert.equal(decodeDuckDuckGoRedirect(wrapped), target);
  });

  it("parses result rows from the HTML response", async () => {
    const { duckduckgoSearch } = await importSource("extensions/mmr-web/search/duckduckgo.ts");
    const html = ddgResultsPage({
      title1: "TypeScript", url1: "https://example.com/ts", snippet1: "Typed JavaScript",
      title2: "TS docs",    url2: "https://example.org/docs", snippet2: "Reference docs",
    });
    const { fetchImpl, calls } = makeFetchMock([() => htmlResponse(html)]);
    const result = await duckduckgoSearch(
      { query: "typescript", maxResults: 5, maxResultBytes: 100_000 },
      { fetchImpl, state: freshState() },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.host, "html.duckduckgo.com");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(result.results.length, 2);
    assert.deepEqual(result.results.map((r) => r.url), [
      "https://example.com/ts",
      "https://example.org/docs",
    ]);
    assert.equal(result.results[0].title, "TypeScript");
    assert.equal(result.results[0].description, "Typed JavaScript");
  });

  it("decodes hex and decimal numeric HTML entities in titles and snippets", async () => {
    const { duckduckgoSearch } = await importSource("extensions/mmr-web/search/duckduckgo.ts");
    const html = ddgResultsPage({
      // &#x2014; = em dash, &#x27; = apostrophe, &#8212; = em dash (decimal)
      title1: "Rust &#x2014; Memory Safety", url1: "https://example.com/rust",
      snippet1: "Ferris&#x27;s guide &#8212; ownership",
      title2: "Plain", url2: "https://example.org/p", snippet2: "no entities",
    });
    const { fetchImpl } = makeFetchMock([() => htmlResponse(html)]);
    const result = await duckduckgoSearch(
      { query: "rust", maxResults: 5, maxResultBytes: 100_000 },
      { fetchImpl, state: freshState() },
    );
    assert.equal(result.results[0].title, "Rust \u2014 Memory Safety");
    assert.equal(result.results[0].description, "Ferris's guide \u2014 ownership");
    // No raw numeric entity escapes should survive in model-visible text.
    assert.doesNotMatch(result.results[0].title, /&#/);
    assert.doesNotMatch(result.results[0].description, /&#/);
  });

  it("reports a requested country filter as unsupported/none with a reason", async () => {
    const { duckduckgoSearch } = await importSource("extensions/mmr-web/search/duckduckgo.ts");
    const html = ddgResultsPage({
      title1: "A", url1: "https://example.com/a", snippet1: "alpha",
      title2: "B", url2: "https://example.org/b", snippet2: "beta",
    });
    const { fetchImpl } = makeFetchMock([() => htmlResponse(html)]);
    const result = await duckduckgoSearch(
      { query: "x", maxResults: 5, maxResultBytes: 100_000, country: "de" },
      { fetchImpl, state: freshState() },
    );
    const country = result.appliedFilters.find((f) => f.filter === "country");
    assert.deepEqual(
      { support: country.support, honored: country.honored },
      { support: "unsupported", honored: "none" },
    );
    assert.equal(typeof country.reason, "string");
    assert.ok(country.reason.length > 0);
  });

  it("filters out result URLs that fail the public-web SSRF policy", async () => {
    const { duckduckgoSearch } = await importSource("extensions/mmr-web/search/duckduckgo.ts");
    const html = ddgResultsPage({
      title1: "ok",   url1: "https://example.com/ok", snippet1: "public",
      title2: "loop", url2: "http://127.0.0.1/internal", snippet2: "private",
    });
    const { fetchImpl } = makeFetchMock([() => htmlResponse(html)]);
    const result = await duckduckgoSearch(
      { query: "x", maxResults: 5, maxResultBytes: 100_000 },
      { fetchImpl, state: freshState() },
    );
    assert.deepEqual(result.results.map((r) => r.url), ["https://example.com/ok"]);
  });

  it("clamps to maxResults", async () => {
    const { duckduckgoSearch } = await importSource("extensions/mmr-web/search/duckduckgo.ts");
    const rows = Array.from({ length: 6 }, (_, i) => `<div class="result results_links results_links_deep web-result">
  <div class="result__body">
    <h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(`https://example.com/${i}`)}">t${i}</a></h2>
    <a class="result__snippet" href="#">s${i}</a>
  </div>
</div>`).join("\n");
    const html = `<!DOCTYPE html><html><body>${rows}</body></html>`;
    const { fetchImpl } = makeFetchMock([() => htmlResponse(html)]);
    const result = await duckduckgoSearch(
      { query: "x", maxResults: 3, maxResultBytes: 100_000 },
      { fetchImpl, state: freshState() },
    );
    assert.equal(result.results.length, 3);
    assert.equal(result.results[2].url, "https://example.com/2");
  });

  it("detects a bot-challenge page and opens the backoff window", async () => {
    const { duckduckgoSearch } = await importSource("extensions/mmr-web/search/duckduckgo.ts");
    const state = freshState();
    let now = 1_000_000;
    const html = `<!DOCTYPE html><html><body><p>Please verify you are a human.</p></body></html>`;
    const { fetchImpl } = makeFetchMock([() => htmlResponse(html)]);
    await assert.rejects(
      () => duckduckgoSearch(
        { query: "x", maxResults: 5, maxResultBytes: 100_000 },
        { fetchImpl, state, now: () => now },
      ),
      /rate-limited or blocked/i,
    );
    // Backoff window is set; second call fails fast WITHOUT issuing a fetch.
    await assert.rejects(
      () => duckduckgoSearch(
        { query: "y", maxResults: 5, maxResultBytes: 100_000 },
        { fetchImpl, state, now: () => now },
      ),
      /Backoff active/i,
    );
  });

  it("opens the backoff window on HTTP 429", async () => {
    const { duckduckgoSearch } = await importSource("extensions/mmr-web/search/duckduckgo.ts");
    const state = freshState();
    const { fetchImpl } = makeFetchMock([
      () => new Response("rate limited", { status: 429, headers: { "content-type": "text/plain" } }),
    ]);
    await assert.rejects(
      () => duckduckgoSearch(
        { query: "x", maxResults: 5, maxResultBytes: 100_000 },
        { fetchImpl, state, now: () => 1000 },
      ),
      /HTTP 429/,
    );
    assert.ok(state.blockedUntil > 1000, "backoff window must be open after 429");
  });

  it("returns cached results within the TTL without a second fetch", async () => {
    const { duckduckgoSearch } = await importSource("extensions/mmr-web/search/duckduckgo.ts");
    const html = ddgResultsPage({
      title1: "A", url1: "https://example.com/a", snippet1: "alpha",
      title2: "B", url2: "https://example.com/b", snippet2: "beta",
    });
    const state = freshState();
    const { fetchImpl, calls } = makeFetchMock([() => htmlResponse(html)]);
    const first = await duckduckgoSearch(
      { query: "abc", maxResults: 5, maxResultBytes: 100_000 },
      { fetchImpl, state, now: () => 1000 },
    );
    const second = await duckduckgoSearch(
      { query: "abc", maxResults: 5, maxResultBytes: 100_000 },
      { fetchImpl, state, now: () => 1000 + 60_000 }, // still within 2-min TTL
    );
    assert.equal(calls.length, 1, "second call must hit the cache");
    assert.deepEqual(first.results.map((r) => r.url), second.results.map((r) => r.url));
  });

  it("re-fetches after the cache TTL expires", async () => {
    const { duckduckgoSearch } = await importSource("extensions/mmr-web/search/duckduckgo.ts");
    const html = ddgResultsPage({
      title1: "A", url1: "https://example.com/a", snippet1: "alpha",
      title2: "B", url2: "https://example.com/b", snippet2: "beta",
    });
    const state = freshState();
    const { fetchImpl, calls } = makeFetchMock([
      () => htmlResponse(html),
      () => htmlResponse(html),
    ]);
    await duckduckgoSearch(
      { query: "abc", maxResults: 5, maxResultBytes: 100_000 },
      { fetchImpl, state, now: () => 1000 },
    );
    await duckduckgoSearch(
      { query: "abc", maxResults: 5, maxResultBytes: 100_000 },
      { fetchImpl, state, now: () => 1000 + 3 * 60_000 }, // beyond 2-min TTL
    );
    assert.equal(calls.length, 2);
  });

  it("createDuckDuckGoSearchBackend returns a SearchBackend with id=duckduckgo", async () => {
    const { createDuckDuckGoSearchBackend } = await importSource("extensions/mmr-web/search/duckduckgo.ts");
    const backend = createDuckDuckGoSearchBackend({ state: freshState() });
    assert.equal(backend.id, "duckduckgo");
  });
});
