import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function textResponse(body, init = {}) {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { "content-type": "text/html", ...(init.headers ?? {}) },
  });
}

/**
 * Default DNS resolver for the custom-reader tests: returns a stable
 * public IPv4 for every hostname. Tests stay offline; per-test overrides
 * model rebinding / private-IP scenarios.
 */
const PUBLIC_DNS_STUB = async () => [{ address: "93.184.216.34", family: 4 }];

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

describe("mmr-web Brave client - search", () => {
  it("requires an API key", async () => {
    const { braveSearch } = await importSource("extensions/mmr-web/brave.ts");
    await assert.rejects(
      () => braveSearch({ query: "ts", maxResults: 5, maxResultBytes: 10000 }, {}),
      /BRAVE_API_KEY/,
    );
  });

  it("rejects an empty query", async () => {
    const { braveSearch } = await importSource("extensions/mmr-web/brave.ts");
    await assert.rejects(
      () => braveSearch({ query: "  ", maxResults: 5, maxResultBytes: 10000 }, { apiKey: "k" }),
      /non-empty query/,
    );
  });

  it("calls the Brave web search endpoint with the subscription token and parses web.results", async () => {
    const { braveSearch } = await importSource("extensions/mmr-web/brave.ts");
    const { fetchImpl, calls } = makeFetchMock([
      () => jsonResponse({
        web: {
          results: [
            { title: "First", url: "https://a.example/1", description: "Hello", age: "2 days ago" },
            { title: "Second", url: "https://a.example/2", description: "World" },
            { title: "Third", url: "https://a.example/3", description: "" },
            { title: "Fourth", url: "https://a.example/4", description: "ignored" },
          ],
        },
      }),
    ]);
    const result = await braveSearch(
      { query: "typescript node", maxResults: 2, maxResultBytes: 100_000 },
      { apiKey: "brv-key", fetchImpl },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.origin + calls[0].url.pathname, "https://api.search.brave.com/res/v1/web/search");
    assert.equal(calls[0].url.searchParams.get("q"), "typescript node");
    assert.equal(calls[0].url.searchParams.get("count"), "2");
    assert.equal(calls[0].init.headers["X-Subscription-Token"], "brv-key");
    // The Brave key must NOT be sent in an Authorization header (subscription
    // token model, not bearer auth).
    assert.equal(calls[0].init.headers.Authorization, undefined);
    assert.equal(result.results.length, 2);
    assert.equal(result.results[0].title, "First");
    assert.equal(result.results[0].age, "2 days ago");
    assert.equal(result.results[1].description, "World");
    assert.equal(result.truncated, false);
  });

  it("passes the optional country code in uppercase", async () => {
    const { braveSearch } = await importSource("extensions/mmr-web/brave.ts");
    const { fetchImpl, calls } = makeFetchMock([
      () => jsonResponse({ web: { results: [] } }),
    ]);
    await braveSearch(
      { query: "x", maxResults: 5, maxResultBytes: 10000, country: "de" },
      { apiKey: "k", fetchImpl },
    );
    assert.equal(calls[0].url.searchParams.get("country"), "DE");
  });

  it("throws on non-200 responses", async () => {
    const { braveSearch } = await importSource("extensions/mmr-web/brave.ts");
    const { fetchImpl } = makeFetchMock([
      () => new Response("forbidden", { status: 403 }),
    ]);
    await assert.rejects(
      () => braveSearch({ query: "x", maxResults: 5, maxResultBytes: 10000 }, { apiKey: "k", fetchImpl }),
      /HTTP 403/,
    );
  });

  it("aborts the fetch when timeoutMs elapses", async () => {
    const { braveSearch } = await importSource("extensions/mmr-web/brave.ts");
    let observedSignal;
    const fetchImpl = (_input, init) => {
      observedSignal = init.signal;
      return new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason ?? new Error("aborted")));
      });
    };
    await assert.rejects(
      () => braveSearch(
        { query: "x", maxResults: 5, maxResultBytes: 10000, timeoutMs: 10 },
        { apiKey: "k", fetchImpl },
      ),
    );
    assert.equal(observedSignal instanceof AbortSignal, true);
    assert.equal(observedSignal.aborted, true);
  });

  it("rejects fast when upstream Content-Length far exceeds the byte budget", async () => {
    const { braveSearch } = await importSource("extensions/mmr-web/brave.ts");
    let response;
    const fetchImpl = async () => {
      response = new Response("x".repeat(10), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": String(10 * 1024 * 1024),
        },
      });
      return response;
    };
    await assert.rejects(
      () => braveSearch(
        { query: "x", maxResults: 5, maxResultBytes: 1000 },
        { apiKey: "k", fetchImpl },
      ),
      /content[- ]length|exceeds/i,
    );
    assert.equal(response.bodyUsed, false);
  });

  it("caps the streamed search body at maxResultBytes without buffering more (chunked / no Content-Length)", async () => {
    const { braveSearch } = await importSource("extensions/mmr-web/brave.ts");
    const CAP = 1000;
    let chunksEmitted = 0;
    const stream = new ReadableStream({
      async pull(controller) {
        chunksEmitted += 1;
        // ~1 KiB of JSON-ish bytes per pull; an unbounded reader would emit
        // far more than CAP bytes in total.
        controller.enqueue(new TextEncoder().encode('{"web":{"results":[' + "x".repeat(1024)));
        if (chunksEmitted > 200) controller.close();
      },
    });
    const fetchImpl = async () => new Response(stream, {
      status: 200,
      // No content-length: forces the streaming code path.
      headers: { "content-type": "application/json" },
    });
    const result = await braveSearch(
      { query: "x", maxResults: 5, maxResultBytes: CAP },
      { apiKey: "k", fetchImpl },
    );
    assert.equal(result.truncated, true, "streamed search body must be marked truncated");
    // totalBytes is the raw input bytes actually consumed; must not exceed CAP.
    assert.ok(
      result.totalBytes <= CAP,
      `read body bytes ${result.totalBytes} must not exceed cap ${CAP}`,
    );
    // Truncated JSON cannot parse, so results is empty without throwing.
    assert.deepEqual(result.results, []);
    // Only a handful of pulls should have happened, not hundreds.
    assert.ok(chunksEmitted <= 5, `expected stream to stop early, observed ${chunksEmitted} chunks`);
  });

  it("bounds the diagnostic preview from non-OK search error responses (no unbounded text())", async () => {
    const { braveSearch } = await importSource("extensions/mmr-web/brave.ts");
    let pullCount = 0;
    const stream = new ReadableStream({
      async pull(controller) {
        pullCount += 1;
        // Each pull emits 4 KiB; an unbounded reader would keep going.
        controller.enqueue(new TextEncoder().encode("x".repeat(4096)));
        if (pullCount > 500) controller.close();
      },
    });
    const fetchImpl = async () => new Response(stream, {
      status: 500,
      statusText: "Server Error",
      headers: { "content-type": "text/html" },
    });
    await assert.rejects(
      () => braveSearch({ query: "x", maxResults: 5, maxResultBytes: 10000 }, { apiKey: "k", fetchImpl }),
      /HTTP 500/,
    );
    // Preview should have read only a few KiB worth of pulls, not hundreds.
    assert.ok(pullCount <= 3, `error preview must be bounded, observed ${pullCount} pulls`);
  });
});

describe("mmr-web custom reader", () => {
  it("rejects invalid or local URLs before any network call", async () => {
    const { braveReader } = await importSource("extensions/mmr-web/brave.ts");
    const { fetchImpl, calls } = makeFetchMock([]);
    for (const url of ["http://localhost/", "http://127.0.0.1/", "file:///etc/passwd", "not a url"]) {
      await assert.rejects(
        () => braveReader({ url, maxResultBytes: 10000 }, { fetchImpl }),
        /rejected URL/,
      );
    }
    assert.equal(calls.length, 0);
  });

  it("fetches the target URL directly and converts HTML to Markdown", async () => {
    const { braveReader } = await importSource("extensions/mmr-web/brave.ts");
    const html = `<!DOCTYPE html><html><head><title>x</title><style>.a{}</style></head>
      <body>
        <nav>Skip</nav>
        <main>
          <h1>Hello</h1>
          <p>This is a <strong>bold</strong> paragraph with a <a href="https://x/">link</a>.</p>
          <ul><li>One</li><li>Two</li></ul>
        </main>
        <footer>copyright</footer>
      </body></html>`;
    const { fetchImpl, calls } = makeFetchMock([() => textResponse(html)]);
    const result = await braveReader(
      { url: "https://example.com/page", maxResultBytes: 100_000 },
      { fetchImpl, lookup: PUBLIC_DNS_STUB },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.toString(), "https://example.com/page");
    // The custom reader uses a browser-like User-Agent (many sites gate non-browser UAs).
    assert.match(calls[0].init.headers["User-Agent"], /Mozilla|Chrome/);
    // No API key is required for the custom reader.
    assert.equal(calls[0].init.headers["X-Subscription-Token"], undefined);

    const text = result.content;
    assert.match(text, /# Hello/);
    assert.match(text, /\*\*bold\*\*/);
    assert.match(text, /\[link\]\(https:\/\/x\/\)/);
    assert.match(text, /- One/);
    assert.match(text, /- Two/);
    assert.doesNotMatch(text, /Skip/);
    assert.doesNotMatch(text, /copyright/);
    assert.doesNotMatch(text, /<script|<style|\.a\{}/);
    assert.equal(result.url, "https://example.com/page");
  });

  it("decodes HTML entities and named references", async () => {
    const { braveReader } = await importSource("extensions/mmr-web/brave.ts");
    const html = `<html><body><main><p>5 &lt; 10 &amp; q&rsquo;d &#x2014; ok</p></main></body></html>`;
    const { fetchImpl } = makeFetchMock([() => textResponse(html)]);
    const result = await braveReader({ url: "https://example.com/", maxResultBytes: 10000 }, { fetchImpl, lookup: PUBLIC_DNS_STUB });
    assert.match(result.content, /5 < 10 & q\u2019d \u2014 ok/);
  });

  it("aborts the fetch when timeoutMs elapses", async () => {
    const { braveReader } = await importSource("extensions/mmr-web/brave.ts");
    let observedSignal;
    const fetchImpl = (_input, init) => {
      observedSignal = init.signal;
      return new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason ?? new Error("aborted")));
      });
    };
    await assert.rejects(
      () => braveReader(
        { url: "https://example.com/", maxResultBytes: 10000, timeoutMs: 10 },
        { fetchImpl, lookup: PUBLIC_DNS_STUB },
      ),
    );
    assert.equal(observedSignal.aborted, true);
  });

  it("rejects fast when reader Content-Length far exceeds the byte budget", async () => {
    const { braveReader } = await importSource("extensions/mmr-web/brave.ts");
    let response;
    const fetchImpl = async () => {
      response = new Response("x", {
        status: 200,
        headers: {
          "content-type": "text/html",
          "content-length": String(10 * 1024 * 1024),
        },
      });
      return response;
    };
    await assert.rejects(
      () => braveReader(
        { url: "https://example.com/", maxResultBytes: 1000 },
        { fetchImpl, lookup: PUBLIC_DNS_STUB },
      ),
      /content[- ]length|exceeds/i,
    );
    assert.equal(response.bodyUsed, false);
  });

  it("rejects a redirect that targets a private/loopback address (SSRF defense across hops)", async () => {
    const { braveReader } = await importSource("extensions/mmr-web/brave.ts");
    const { fetchImpl, calls } = makeFetchMock([
      () => new Response("", {
        status: 302,
        headers: { location: "http://127.0.0.1/admin" },
      }),
    ]);
    await assert.rejects(
      () => braveReader({ url: "https://example.com/start", maxResultBytes: 10000 }, { fetchImpl, lookup: PUBLIC_DNS_STUB }),
      /redirect.*rejected|rejected URL/i,
    );
    // Critically: only the first hop is issued; the local target is never fetched.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.toString(), "https://example.com/start");
  });

  it("rejects a redirect that targets a link-local metadata host (SSRF defense)", async () => {
    const { braveReader } = await importSource("extensions/mmr-web/brave.ts");
    const { fetchImpl, calls } = makeFetchMock([
      () => new Response("", {
        status: 301,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      }),
    ]);
    await assert.rejects(
      () => braveReader({ url: "https://example.com/r", maxResultBytes: 10000 }, { fetchImpl, lookup: PUBLIC_DNS_STUB }),
      /redirect.*rejected|rejected URL/i,
    );
    assert.equal(calls.length, 1);
  });

  it("rejects a redirect to a file:// or non-http(s) scheme", async () => {
    const { braveReader } = await importSource("extensions/mmr-web/brave.ts");
    const { fetchImpl, calls } = makeFetchMock([
      () => new Response("", { status: 302, headers: { location: "file:///etc/passwd" } }),
    ]);
    await assert.rejects(
      () => braveReader({ url: "https://example.com/r", maxResultBytes: 10000 }, { fetchImpl, lookup: PUBLIC_DNS_STUB }),
      /redirect.*rejected|rejected URL/i,
    );
    assert.equal(calls.length, 1);
  });

  it("follows a redirect to a valid public URL and validates each hop", async () => {
    const { braveReader } = await importSource("extensions/mmr-web/brave.ts");
    const { fetchImpl, calls } = makeFetchMock([
      () => new Response("", { status: 302, headers: { location: "https://other.example/landing" } }),
      () => new Response(
        "<html><body><main><h1>Landed</h1></main></body></html>",
        { status: 200, headers: { "content-type": "text/html" } },
      ),
    ]);
    const result = await braveReader(
      { url: "https://example.com/start", maxResultBytes: 10000 },
      { fetchImpl, lookup: PUBLIC_DNS_STUB },
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url.toString(), "https://example.com/start");
    assert.equal(calls[1].url.toString(), "https://other.example/landing");
    assert.match(result.content, /# Landed/);
    // details.url should reflect the final landing page so callers see the
    // resolved URL rather than the original request.
    assert.equal(result.url, "https://other.example/landing");
  });

  it("resolves a relative Location header against the previous URL before validating it", async () => {
    const { braveReader } = await importSource("extensions/mmr-web/brave.ts");
    const { fetchImpl, calls } = makeFetchMock([
      () => new Response("", { status: 302, headers: { location: "/landed" } }),
      () => new Response(
        "<html><body><main><p>Hi</p></main></body></html>",
        { status: 200, headers: { "content-type": "text/html" } },
      ),
    ]);
    const result = await braveReader(
      { url: "https://example.com/start", maxResultBytes: 10000 },
      { fetchImpl, lookup: PUBLIC_DNS_STUB },
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url.toString(), "https://example.com/landed");
    assert.equal(result.url, "https://example.com/landed");
  });

  it("rejects a relative redirect that resolves to a denied host", async () => {
    const { braveReader } = await importSource("extensions/mmr-web/brave.ts");
    // The Location is scheme-relative and points at a private IP. WHATWG
    // resolves it to http://127.0.0.1/ which must be rejected.
    const { fetchImpl, calls } = makeFetchMock([
      () => new Response("", { status: 302, headers: { location: "//127.0.0.1/" } }),
    ]);
    await assert.rejects(
      () => braveReader({ url: "http://example.com/r", maxResultBytes: 10000 }, { fetchImpl, lookup: PUBLIC_DNS_STUB }),
      /redirect.*rejected|rejected URL/i,
    );
    assert.equal(calls.length, 1);
  });

  it("enforces a maximum redirect count to prevent open-redirect chains", async () => {
    const { braveReader } = await importSource("extensions/mmr-web/brave.ts");
    // Many sequential redirects, all public, but more hops than the limit.
    const plan = Array.from({ length: 20 }, (_, i) => () => new Response("", {
      status: 302,
      headers: { location: `https://example.com/step${i + 1}` },
    }));
    const { fetchImpl, calls } = makeFetchMock(plan);
    await assert.rejects(
      () => braveReader({ url: "https://example.com/start", maxResultBytes: 10000 }, { fetchImpl, lookup: PUBLIC_DNS_STUB }),
      /too many redirects|redirect.*limit/i,
    );
    // Should NOT have run the entire 20-hop plan.
    assert.ok(calls.length <= 10, `expected redirect limit to cap hops, observed ${calls.length}`);
  });

  it("rejects a hostname that resolves to a private IP (DNS-rebinding / 127.0.0.1.nip.io defense)", async () => {
    const { braveReader } = await importSource("extensions/mmr-web/brave.ts");
    const { fetchImpl, calls } = makeFetchMock([]);
    const lookup = async (host) => {
      assert.equal(host, "local-rebind.example");
      return [{ address: "127.0.0.1", family: 4 }];
    };
    await assert.rejects(
      () => braveReader(
        { url: "https://local-rebind.example/", maxResultBytes: 10000 },
        { fetchImpl, lookup },
      ),
      /resolves to a private|reserved/i,
    );
    // No fetch is issued when DNS resolution lands on a denied target.
    assert.equal(calls.length, 0);
  });

  it("rejects when ANY resolved address is private even if others are public", async () => {
    const { braveReader } = await importSource("extensions/mmr-web/brave.ts");
    const { fetchImpl, calls } = makeFetchMock([]);
    // Multi-A record: one public address plus a private one. We must refuse
    // the request rather than gamble on which Node picks at connect time.
    const lookup = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ];
    await assert.rejects(
      () => braveReader(
        { url: "https://multi-a.example/", maxResultBytes: 10000 },
        { fetchImpl, lookup },
      ),
      /resolves to a private|reserved/i,
    );
    assert.equal(calls.length, 0);
  });

  it("rejects an IPv6 AAAA record in a private range (e.g. ::1, fc00::/7)", async () => {
    const { braveReader } = await importSource("extensions/mmr-web/brave.ts");
    const { fetchImpl, calls } = makeFetchMock([]);
    const lookup = async () => [{ address: "::1", family: 6 }];
    await assert.rejects(
      () => braveReader(
        { url: "https://ipv6-loopback.example/", maxResultBytes: 10000 },
        { fetchImpl, lookup },
      ),
      /resolves to a private|reserved/i,
    );
    assert.equal(calls.length, 0);
  });

  it("re-resolves the hostname on every redirect hop (no trust transfer across hops)", async () => {
    const { braveReader } = await importSource("extensions/mmr-web/brave.ts");
    const { fetchImpl, calls } = makeFetchMock([
      () => new Response("", { status: 302, headers: { location: "https://hop2.example/" } }),
    ]);
    const lookups = [];
    const lookup = async (host) => {
      lookups.push(host);
      if (host === "hop1.example") return [{ address: "93.184.216.34", family: 4 }];
      // The second hop's hostname resolves to a private IP; must be rejected
      // even though the first hop was a perfectly public target.
      if (host === "hop2.example") return [{ address: "10.0.0.5", family: 4 }];
      throw new Error(`unexpected lookup for ${host}`);
    };
    await assert.rejects(
      () => braveReader(
        { url: "https://hop1.example/", maxResultBytes: 10000 },
        { fetchImpl, lookup },
      ),
      /redirect.*rejected.*resolves to a private|resolves to a private/i,
    );
    // Only the first hop's HTTP request fired; the second was blocked at DNS validation.
    assert.equal(calls.length, 1);
    assert.deepEqual(lookups, ["hop1.example", "hop2.example"]);
  });

  it("skips DNS lookup for URL-literal IPs (already covered by validateExternalHttpUrl)", async () => {
    const { braveReader } = await importSource("extensions/mmr-web/brave.ts");
    const { fetchImpl } = makeFetchMock([
      () => new Response("<html><body><main>ok</main></body></html>", { status: 200, headers: { "content-type": "text/html" } }),
    ]);
    let lookups = 0;
    const lookup = async () => {
      lookups += 1;
      return [];
    };
    // 93.184.216.34 is a public IPv4 (example.org); URL parser exposes it as a literal,
    // so we should not need a DNS lookup at all.
    await braveReader(
      { url: "https://93.184.216.34/", maxResultBytes: 10000 },
      { fetchImpl, lookup },
    );
    assert.equal(lookups, 0, "DNS lookup must not run for URL-literal IPs");
  });

  it("applies timeoutMs to a hung DNS lookup so a slow resolver cannot exceed the tool timeout", async () => {
    const { braveReader } = await importSource("extensions/mmr-web/brave.ts");
    // Lookup never resolves; without lookup-side timeout integration, the
    // caller would hang past timeoutMs because Node's fetch abort signal
    // only covers the HTTP phase.
    const lookupCalls = [];
    const lookup = (host) => new Promise(() => {
      lookupCalls.push(host);
      /* intentionally never resolves */
    });
    const fetchImpl = () => {
      throw new Error("fetch must not run when DNS lookup is still pending");
    };
    const start = Date.now();
    await assert.rejects(
      () => braveReader(
        { url: "https://example.com/", maxResultBytes: 1000, timeoutMs: 25 },
        { fetchImpl, lookup },
      ),
      /abort|timeout/i,
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 750, `DNS-stage timeout must fire promptly; took ${elapsed}ms`);
    assert.equal(lookupCalls.length, 1, "lookup should have been invoked exactly once");
  });

  it("honors a caller-provided AbortSignal during the DNS lookup phase", async () => {
    const { braveReader } = await importSource("extensions/mmr-web/brave.ts");
    const controller = new AbortController();
    const lookup = () => new Promise(() => { /* never resolves */ });
    const fetchImpl = () => { throw new Error("fetch must not run"); };
    setTimeout(() => controller.abort(new Error("caller cancelled DNS")), 10);
    await assert.rejects(
      () => braveReader(
        { url: "https://example.com/", maxResultBytes: 1000, signal: controller.signal },
        { fetchImpl, lookup },
      ),
      /caller cancelled DNS/,
    );
  });

  it("truncates very large pages to the byte budget", async () => {
    const { braveReader } = await importSource("extensions/mmr-web/brave.ts");
    const body = `<html><body><main><p>${"x".repeat(5000)}</p></main></body></html>`;
    const { fetchImpl } = makeFetchMock([() => textResponse(body)]);
    const result = await braveReader({ url: "https://example.com/", maxResultBytes: 200 }, { fetchImpl, lookup: PUBLIC_DNS_STUB });
    assert.equal(result.truncated, true);
    assert.ok(result.bytes <= 400, `output should respect the byte budget (~200 + marker), got ${result.bytes}`);
  });

  it("refuses responses with Content-Disposition: attachment (no file downloads)", async () => {
    const { braveReader } = await importSource("extensions/mmr-web/brave.ts");
    const { fetchImpl } = makeFetchMock([
      () => new Response("binary garbage", {
        status: 200,
        headers: {
          "content-type": "text/html",
          "content-disposition": "attachment; filename=\"evil.html\"",
        },
      }),
    ]);
    await assert.rejects(
      () => braveReader({ url: "https://example.com/", maxResultBytes: 10000 }, { fetchImpl, lookup: PUBLIC_DNS_STUB }),
      /Content-Disposition: attachment|does not download files/i,
    );
  });

  it("refuses non-text content types (application/octet-stream, PDF, image, archive)", async () => {
    const { braveReader } = await importSource("extensions/mmr-web/brave.ts");
    const cases = [
      { type: "application/octet-stream" },
      { type: "application/pdf" },
      { type: "image/png" },
      { type: "application/zip" },
      { type: "video/mp4" },
    ];
    for (const { type } of cases) {
      const { fetchImpl } = makeFetchMock([
        () => new Response("bytes", { status: 200, headers: { "content-type": type } }),
      ]);
      await assert.rejects(
        () => braveReader({ url: "https://example.com/", maxResultBytes: 10000 }, { fetchImpl, lookup: PUBLIC_DNS_STUB }),
        new RegExp(`Content-Type "${type.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`),
        `expected ${type} to be refused`,
      );
    }
  });

  it("accepts allowed text-shaped content types (html, xhtml, plain, xml) with parameters", async () => {
    const { braveReader } = await importSource("extensions/mmr-web/brave.ts");
    const cases = [
      "text/html; charset=utf-8",
      "application/xhtml+xml",
      "text/plain; charset=us-ascii",
      "application/xml",
      "text/xml",
    ];
    for (const type of cases) {
      const { fetchImpl } = makeFetchMock([
        () => new Response("<html><body><main><p>ok</p></main></body></html>", {
          status: 200,
          headers: { "content-type": type },
        }),
      ]);
      const result = await braveReader(
        { url: "https://example.com/", maxResultBytes: 10000 },
        { fetchImpl, lookup: PUBLIC_DNS_STUB },
      );
      assert.match(result.content, /ok/, `expected ${type} body to decode`);
    }
  });

  it("tolerates a missing Content-Type header (best-effort decode)", async () => {
    const { braveReader } = await importSource("extensions/mmr-web/brave.ts");
    // Build a Response without a content-type header by stripping defaults.
    const fetchImpl = async () => new Response("<html><body><main>hi</main></body></html>", {
      status: 200,
      headers: {},
    });
    const result = await braveReader(
      { url: "https://example.com/", maxResultBytes: 10000 },
      { fetchImpl, lookup: PUBLIC_DNS_STUB },
    );
    assert.match(result.content, /hi/);
  });

  it("caps streamed body bytes at maxResultBytes without buffering more (chunked / no Content-Length)", async () => {
    const { braveReader } = await importSource("extensions/mmr-web/brave.ts");
    const CAP = 1000;
    let chunksEmitted = 0;
    const stream = new ReadableStream({
      async pull(controller) {
        chunksEmitted += 1;
        // Each chunk is ~1 KiB of HTML-ish bytes; if the reader did not cap
        // we would emit far more than CAP bytes total.
        const chunk = new TextEncoder().encode("<p>" + "x".repeat(1024) + "</p>");
        controller.enqueue(chunk);
        if (chunksEmitted > 200) controller.close();
      },
      cancel() {
        // Cancellation must stop us emitting more chunks.
      },
    });
    const fetchImpl = async () => new Response(stream, {
      status: 200,
      // No content-length: forces the streaming code path.
      headers: { "content-type": "text/html" },
    });
    const result = await braveReader(
      { url: "https://example.com/", maxResultBytes: CAP },
      { fetchImpl, lookup: PUBLIC_DNS_STUB },
    );
    assert.equal(result.truncated, true, "streamed body must be marked truncated");
    // totalBytes is the raw input bytes we actually consumed; must not exceed CAP.
    assert.ok(
      result.totalBytes <= CAP,
      `read body bytes ${result.totalBytes} must not exceed cap ${CAP}`,
    );
    // Only a handful of pulls should have happened, not hundreds.
    assert.ok(chunksEmitted <= 5, `expected stream to stop early, observed ${chunksEmitted} chunks`);
  });

  it("bounds the diagnostic preview from non-OK error responses (no unbounded text())", async () => {
    const { braveReader } = await importSource("extensions/mmr-web/brave.ts");
    let pullCount = 0;
    const stream = new ReadableStream({
      async pull(controller) {
        pullCount += 1;
        // Each pull emits 4 KiB; an unbounded reader would keep going.
        controller.enqueue(new TextEncoder().encode("x".repeat(4096)));
        if (pullCount > 500) controller.close();
      },
    });
    const fetchImpl = async () => new Response(stream, {
      status: 500,
      statusText: "Server Error",
      headers: { "content-type": "text/html" },
    });
    await assert.rejects(
      () => braveReader({ url: "https://example.com/", maxResultBytes: 10000 }, { fetchImpl, lookup: PUBLIC_DNS_STUB }),
      /HTTP 500/,
    );
    // Preview should have read only a few KiB worth of pulls, not hundreds.
    assert.ok(pullCount <= 3, `error preview must be bounded, observed ${pullCount} pulls`);
  });

  it("DNS lookup is raced against the per-call timeout signal", async () => {
    const { braveReader } = await importSource("extensions/mmr-web/brave.ts");
    // Lookup that never resolves; must be killed by the timeout, not hang.
    const lookup = () => new Promise(() => {});
    const { fetchImpl, calls } = makeFetchMock([]);
    const start = Date.now();
    await assert.rejects(
      () => braveReader(
        { url: "https://slow-dns.example/", maxResultBytes: 10000, timeoutMs: 30 },
        { fetchImpl, lookup },
      ),
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 5000, `DNS race must respect timeout, took ${elapsed}ms`);
    assert.equal(calls.length, 0, "no fetch should fire when DNS is aborted");
  });

  it("redacts BRAVE_API_KEY from upstream search error body before throwing", async () => {
    const { braveSearch } = await importSource("extensions/mmr-web/brave.ts");
    const apiKey = "redacted-demo-key-abcdef0123";
    const fetchImpl = async () => new Response(
      `Unauthorized. X-Subscription-Token=${apiKey}`,
      { status: 401, statusText: "Unauthorized", headers: { "content-type": "text/plain" } },
    );
    let threw;
    try {
      await braveSearch({ query: "x", maxResults: 5, maxResultBytes: 10000 }, { apiKey, fetchImpl });
    } catch (error) {
      threw = error;
    }
    assert.ok(threw, "expected braveSearch to throw");
    assert.match(threw.message, /HTTP 401/);
    assert.match(threw.message, /\[redacted\]/);
    assert.equal(threw.message.includes(apiKey), false, "raw API key must not appear in error message");
  });

  it("redacts BRAVE_API_KEY from custom-reader error body before throwing", async () => {
    const { braveReader } = await importSource("extensions/mmr-web/brave.ts");
    // The custom reader does not send a Brave API key (it fetches the origin
    // directly), but its BraveClientOptions still carries apiKey so the search
    // and reader share configuration; verify the reader path still redacts if
    // a key happens to be present and gets echoed somehow.
    const apiKey = "redacted-demo-key-abcdef0123";
    const fetchImpl = async () => new Response(
      `forbidden by upstream proxy with header ${apiKey}`,
      { status: 502, statusText: "Bad Gateway", headers: { "content-type": "text/plain" } },
    );
    let threw;
    try {
      await braveReader(
        { url: "https://example.com/", maxResultBytes: 10000 },
        { apiKey, fetchImpl, lookup: PUBLIC_DNS_STUB },
      );
    } catch (error) {
      threw = error;
    }
    assert.ok(threw, "expected braveReader to throw");
    assert.match(threw.message, /HTTP 502/);
    assert.equal(threw.message.includes(apiKey), false, "raw API key must not appear in error message");
  });
});
