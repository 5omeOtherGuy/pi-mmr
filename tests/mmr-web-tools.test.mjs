import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

function settings(partial = {}) {
  return {
    enabled: false,
    backend: "auto",
    searchBackend: undefined,
    readerBackend: undefined,
    braveApiKey: undefined,
    searxngUrl: undefined,
    searchTimeoutMs: 30000,
    readTimeoutMs: 30000,
    maxResultBytes: 200000,
    ...partial,
  };
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function textResponse(body, init = {}) {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { "content-type": "text/plain", ...(init.headers ?? {}) },
  });
}

function htmlResponse(body, init = {}) {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { "content-type": "text/html", ...(init.headers ?? {}) },
  });
}

// Default DNS resolver for custom-reader tests; keeps the suite offline.
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

describe("mmr-web tool definitions", () => {
  it("createWebSearchTool returns a definition matching the public shape", async () => {
    const { createWebSearchTool } = await importSource("extensions/mmr-web/tools.ts");
    const tool = createWebSearchTool({ getSettings: () => settings() });
    assert.equal(tool.name, "web_search");
    assert.equal(typeof tool.promptSnippet, "string");
    assert.match(tool.promptSnippet, /Search the public web/);
    assert.ok(tool.promptGuidelines?.some((guideline) => guideline.includes("web_search")));
    assert.equal(tool.parameters.type, "object");
    assert.deepEqual(tool.parameters.required, ["objective"]);
    assert.equal(tool.parameters.properties.objective.type, "string");
    assert.equal(tool.parameters.properties.search_queries.type, "array");
    assert.equal(tool.parameters.properties.max_results.type, "number");
    assert.doesNotMatch(tool.description, /Jina/);
    assert.match(tool.description, /Brave Search/);
  });

  it("createReadWebPageTool exposes url required, optional objective and forceRefetch", async () => {
    const { createReadWebPageTool } = await importSource("extensions/mmr-web/tools.ts");
    const tool = createReadWebPageTool({ getSettings: () => settings() });
    assert.equal(tool.name, "read_web_page");
    assert.equal(typeof tool.promptSnippet, "string");
    assert.match(tool.promptSnippet, /Fetch a public http\(s\) page/);
    assert.ok(tool.promptGuidelines?.some((guideline) => guideline.includes("read_web_page")));
    assert.deepEqual(tool.parameters.required, ["url"]);
    assert.equal(tool.parameters.properties.objective.type, "string");
    assert.equal(tool.parameters.properties.forceRefetch.type, "boolean");
    assert.doesNotMatch(tool.description, /Jina/);
  });

  it("web_search execute uses search_queries[0] over objective, clamps max_results, and calls Brave", async () => {
    const { createWebSearchTool } = await importSource("extensions/mmr-web/tools.ts");
    const { fetchImpl, calls } = makeFetchMock([
      () => jsonResponse({
        web: {
          results: [
            { title: "A", url: "https://x/a", description: "alpha", age: "1 day ago" },
            { title: "B", url: "https://x/b", description: "beta" },
            { title: "C", url: "https://x/c", description: "gamma" },
          ],
        },
      }),
    ]);
    const tool = createWebSearchTool({
      getSettings: () => settings({ enabled: true, braveApiKey: "brv" }),
      getBraveOptions: () => ({ apiKey: "brv", fetchImpl }),
    });

    const result = await tool.execute("call-1", {
      objective: "find typescript news",
      search_queries: ["", "  ", "specific query"],
      max_results: 99,
    }, undefined, undefined, /* ctx */ {});

    assert.equal(calls[0].url.host, "api.search.brave.com");
    assert.equal(calls[0].url.searchParams.get("q"), "specific query");
    assert.equal(calls[0].init.headers["X-Subscription-Token"], "brv");
    assert.equal(result.details.backend, "brave");
    assert.equal(result.details.query, "specific query");
    assert.equal(result.details.maxResults, 10, "max_results is clamped to MAX_MAX_RESULTS");
    assert.equal(result.details.resultCount, 3);
    assert.equal(result.details.apiKeyPresent, true);
    assert.match(result.content[0].text, /Web search results for: specific query/);
    assert.match(result.content[0].text, /## 1\. A/);
    assert.match(result.content[0].text, /Age: 1 day ago/);
  });

  it("web_search falls back to objective when search_queries are missing/empty", async () => {
    const { createWebSearchTool } = await importSource("extensions/mmr-web/tools.ts");
    const { fetchImpl, calls } = makeFetchMock([
      () => jsonResponse({ web: { results: [{ title: "T", url: "https://x/", description: "d" }] } }),
    ]);
    const tool = createWebSearchTool({
      getSettings: () => settings({ enabled: true, braveApiKey: "brv" }),
      getBraveOptions: () => ({ apiKey: "brv", fetchImpl }),
    });
    const result = await tool.execute("call", { objective: "fallback objective" }, undefined, undefined, {});
    assert.equal(calls[0].url.searchParams.get("q"), "fallback objective");
    assert.equal(result.details.query, "fallback objective");
    assert.equal(result.details.maxResults, 5);
  });

  it("web_search rejects malformed inputs without calling fetch", async () => {
    const { createWebSearchTool } = await importSource("extensions/mmr-web/tools.ts");
    const { fetchImpl, calls } = makeFetchMock([]);
    const tool = createWebSearchTool({
      getSettings: () => settings({ enabled: true, braveApiKey: "brv" }),
      getBraveOptions: () => ({ apiKey: "brv", fetchImpl }),
    });
    await assert.rejects(() => tool.execute("c", { objective: "" }, undefined, undefined, {}), /objective is required/);
    await assert.rejects(() => tool.execute("c", null, undefined, undefined, {}), /expects an object/);
    assert.equal(calls.length, 0);
  });

  it("web_search applies searchTimeoutMs to the Brave fetch", async () => {
    const { createWebSearchTool } = await importSource("extensions/mmr-web/tools.ts");
    let observedSignal;
    const fetchImpl = (_input, init) => {
      observedSignal = init.signal;
      if (!(observedSignal instanceof AbortSignal)) return Promise.reject(new Error("missing abort signal"));
      return new Promise((_, reject) => {
        observedSignal.addEventListener("abort", () => reject(observedSignal.reason ?? new Error("aborted")));
      });
    };
    const tool = createWebSearchTool({
      getSettings: () => settings({ enabled: true, braveApiKey: "brv", searchTimeoutMs: 10 }),
      getBraveOptions: () => ({ apiKey: "brv", fetchImpl }),
    });

    await assert.rejects(
      () => tool.execute("c", { objective: "timeout check" }, undefined, undefined, {}),
      /abort|timeout/i,
    );
    assert.equal(observedSignal.aborted, true);
  });

  it("web_search throws a clear BRAVE_API_KEY setup error when explicitly using the Brave backend without a key", async () => {
    const { createWebSearchTool } = await importSource("extensions/mmr-web/tools.ts");
    const { fetchImpl, calls } = makeFetchMock([]);
    const tool = createWebSearchTool({
      // Explicit searchBackend=brave; auto would fall back to DuckDuckGo now.
      getSettings: () => settings({ enabled: true, searchBackend: "brave" }),
      getBraveOptions: () => ({ fetchImpl }),
    });
    await assert.rejects(
      () => tool.execute("c", { objective: "needs key" }, undefined, undefined, {}),
      /BRAVE_API_KEY.*Set the BRAVE_API_KEY environment variable/i,
    );
    assert.equal(calls.length, 0);
  });

  it("web_search throws a clear error when network is disabled", async () => {
    const { createWebSearchTool } = await importSource("extensions/mmr-web/tools.ts");
    const tool = createWebSearchTool({
      getSettings: () => settings({ enabled: false }),
      getBraveOptions: () => ({}),
    });
    await assert.rejects(
      () => tool.execute("c", { objective: "x" }, undefined, undefined, {}),
      /web_search is unavailable.*disabled/,
    );
  });

  it("read_web_page rejects local URLs before fetching", async () => {
    const { createReadWebPageTool } = await importSource("extensions/mmr-web/tools.ts");
    const { fetchImpl, calls } = makeFetchMock([]);
    const tool = createReadWebPageTool({
      getSettings: () => settings({ enabled: true }),
      getBraveOptions: () => ({ fetchImpl, lookup: PUBLIC_DNS_STUB }),
    });

    await assert.rejects(
      () => tool.execute("c", { url: "http://localhost:3000/" }, undefined, undefined, {}),
      /rejected URL/,
    );
    assert.equal(calls.length, 0);
  });

  it("read_web_page applies readTimeoutMs to the custom reader fetch", async () => {
    const { createReadWebPageTool } = await importSource("extensions/mmr-web/tools.ts");
    let observedSignal;
    const fetchImpl = (_input, init) => {
      observedSignal = init.signal;
      if (!(observedSignal instanceof AbortSignal)) return Promise.reject(new Error("missing abort signal"));
      return new Promise((_, reject) => {
        observedSignal.addEventListener("abort", () => reject(observedSignal.reason ?? new Error("aborted")));
      });
    };
    const tool = createReadWebPageTool({
      getSettings: () => settings({ enabled: true, readTimeoutMs: 10 }),
      getBraveOptions: () => ({ fetchImpl, lookup: PUBLIC_DNS_STUB }),
    });

    await assert.rejects(
      () => tool.execute("c", { url: "https://example.com/" }, undefined, undefined, {}),
      /abort|timeout/i,
    );
    assert.equal(observedSignal.aborted, true);
  });

  it("read_web_page returns full Markdown/plain text when objective is missing", async () => {
    const { createReadWebPageTool } = await importSource("extensions/mmr-web/tools.ts");
    const body = `# Hello\n\nFull body text about birds.\n\n## Cooking\n\nUnrelated text.`;
    const { fetchImpl } = makeFetchMock([() => textResponse(body)]);
    const tool = createReadWebPageTool({
      getSettings: () => settings({ enabled: true }),
      getBraveOptions: () => ({ fetchImpl, lookup: PUBLIC_DNS_STUB }),
    });
    const result = await tool.execute("c", { url: "https://example.com/" }, undefined, undefined, {});
    assert.equal(result.content[0].text, body);
    assert.equal(result.details.backend, "custom");
    assert.equal(result.details.objectiveApplied, false);
    assert.equal(result.details.excerpted, false);
    assert.equal(result.details.excerptCount, 0);
    assert.equal(result.details.objective, undefined);
    assert.equal(result.details.fallbackReason, undefined);
  });

  it("read_web_page converts HTML through the custom reader", async () => {
    const { createReadWebPageTool } = await importSource("extensions/mmr-web/tools.ts");
    const html = `<html><body><main><h1>Doc</h1><p>Hello <strong>world</strong>.</p></main></body></html>`;
    const { fetchImpl, calls } = makeFetchMock([() => htmlResponse(html)]);
    const tool = createReadWebPageTool({
      getSettings: () => settings({ enabled: true }),
      getBraveOptions: () => ({ fetchImpl, lookup: PUBLIC_DNS_STUB }),
    });
    const result = await tool.execute("c", { url: "https://example.com/page" }, undefined, undefined, {});
    assert.equal(result.details.backend, "custom");
    assert.equal(calls[0].url.toString(), "https://example.com/page");
    assert.match(result.content[0].text, /# Doc/);
    assert.match(result.content[0].text, /\*\*world\*\*/);
  });

  it("read_web_page treats a blank objective as missing and records fallbackReason", async () => {
    const { createReadWebPageTool } = await importSource("extensions/mmr-web/tools.ts");
    const body = `# Hello\n\nFull body text.`;
    const { fetchImpl } = makeFetchMock([() => textResponse(body)]);
    const tool = createReadWebPageTool({
      getSettings: () => settings({ enabled: true }),
      getBraveOptions: () => ({ fetchImpl, lookup: PUBLIC_DNS_STUB }),
    });
    const result = await tool.execute("c", { url: "https://example.com/", objective: "   " }, undefined, undefined, {});
    assert.equal(result.content[0].text, body);
    assert.equal(result.details.objectiveApplied, false);
    assert.equal(result.details.excerpted, false);
    assert.equal(result.details.fallbackReason, "blank_objective");
  });

  it("read_web_page returns excerpts when the objective matches passages", async () => {
    const { createReadWebPageTool } = await importSource("extensions/mmr-web/tools.ts");
    const body = `# Birds\n\n## Sparrows\n\nThe house sparrow is common worldwide and lives near humans.\n\n## Cooking\n\nPasta sauce uses tomatoes and onions.`;
    const { fetchImpl } = makeFetchMock([() => textResponse(body)]);
    const tool = createReadWebPageTool({
      getSettings: () => settings({ enabled: true }),
      getBraveOptions: () => ({ fetchImpl, lookup: PUBLIC_DNS_STUB }),
    });
    const result = await tool.execute("c", { url: "https://example.com/", objective: "tell me about the house sparrow" }, undefined, undefined, {});
    assert.equal(result.details.objectiveApplied, true);
    assert.equal(result.details.excerpted, true);
    assert.ok(result.details.excerptCount >= 1);
    assert.equal(result.details.objective, "tell me about the house sparrow");
    assert.match(result.content[0].text, /house sparrow/i);
    assert.doesNotMatch(result.content[0].text, /pasta sauce/i);
  });

  it("read_web_page joins multiple excerpts with the --- separator", async () => {
    const { createReadWebPageTool } = await importSource("extensions/mmr-web/tools.ts");
    const body = `# Doc\n\n## A\n\nWidget overview here.\n\n## B\n\nMore widget details and behavior.\n\n## C\n\nUnrelated discussion of dolphins.`;
    const { fetchImpl } = makeFetchMock([() => textResponse(body)]);
    const tool = createReadWebPageTool({
      getSettings: () => settings({ enabled: true }),
      getBraveOptions: () => ({ fetchImpl, lookup: PUBLIC_DNS_STUB }),
    });
    const result = await tool.execute("c", { url: "https://example.com/", objective: "widget" }, undefined, undefined, {});
    assert.equal(result.details.excerpted, true);
    assert.ok(result.details.excerptCount >= 2);
    assert.match(result.content[0].text, /\n\n---\n\n/);
  });

  it("read_web_page falls back to full content when no passage is relevant", async () => {
    const { createReadWebPageTool } = await importSource("extensions/mmr-web/tools.ts");
    const body = `# Birds\n\nSparrows and eagles are interesting.`;
    const { fetchImpl } = makeFetchMock([() => textResponse(body)]);
    const tool = createReadWebPageTool({
      getSettings: () => settings({ enabled: true }),
      getBraveOptions: () => ({ fetchImpl, lookup: PUBLIC_DNS_STUB }),
    });
    const result = await tool.execute("c", { url: "https://example.com/", objective: "quantum chromodynamics renormalization" }, undefined, undefined, {});
    assert.equal(result.details.objectiveApplied, true);
    assert.equal(result.details.excerpted, false);
    assert.equal(result.details.fallbackReason, "no_relevant_excerpts");
    assert.equal(result.content[0].text, body);
  });

  it("read_web_page accepts forceRefetch but direct-fetches without provider cache headers", async () => {
    const { createReadWebPageTool } = await importSource("extensions/mmr-web/tools.ts");
    const { fetchImpl, calls } = makeFetchMock([() => textResponse("# Page\n\nbody")]);
    const tool = createReadWebPageTool({
      getSettings: () => settings({ enabled: true }),
      getBraveOptions: () => ({ fetchImpl, lookup: PUBLIC_DNS_STUB }),
    });
    const result = await tool.execute("c", { url: "https://example.com/", forceRefetch: true }, undefined, undefined, {});
    const headers = calls[0].init?.headers ?? {};
    assert.equal(headers["X-No-Cache"], undefined);
    assert.equal(result.details.forceRefetch, true);
    // The model-visible description must not promise cache-busting the reader
    // cannot provide.
    const { READ_WEB_PAGE_DESCRIPTION } = await importSource("extensions/mmr-web/tools.ts");
    assert.doesNotMatch(READ_WEB_PAGE_DESCRIPTION, /cached version|days old/i);
  });

  it("read_web_page caps excerpted output at FINAL_CONTENT_CAP_BYTES with a truncation marker", async () => {
    const { createReadWebPageTool } = await importSource("extensions/mmr-web/tools.ts");
    const { FINAL_CONTENT_CAP_BYTES, TRUNCATION_MARKER, MAX_EXCERPTS } = await importSource(
      "extensions/mmr-web/excerpts.ts",
    );
    const sectionBody =
      "widget details paragraph repeats widget details ".repeat(600);
    const sections = Array.from({ length: MAX_EXCERPTS + 5 }, (_, i) =>
      `## Widget Details ${i}\n\n${sectionBody}`,
    ).join("\n\n");
    const { fetchImpl } = makeFetchMock([() => textResponse(sections)]);
    const tool = createReadWebPageTool({
      getSettings: () => settings({ enabled: true, maxResultBytes: FINAL_CONTENT_CAP_BYTES * 2 }),
      getBraveOptions: () => ({ fetchImpl, lookup: PUBLIC_DNS_STUB }),
    });
    const result = await tool.execute(
      "c",
      { url: "https://example.com/", objective: "widget details" },
      undefined,
      undefined,
      {},
    );
    assert.equal(result.details.excerpted, true);
    const text = result.content[0].text;
    const bytes = Buffer.byteLength(text, "utf8");
    assert.ok(
      bytes <= FINAL_CONTENT_CAP_BYTES + Buffer.byteLength(TRUNCATION_MARKER, "utf8"),
      `final output (${bytes} bytes) should be capped at FINAL_CONTENT_CAP_BYTES + marker`,
    );
    assert.ok(text.endsWith(TRUNCATION_MARKER), "truncation marker should be appended");
  });

  it("read_web_page caps full-Markdown fallback output at FINAL_CONTENT_CAP_BYTES with a truncation marker", async () => {
    const { createReadWebPageTool } = await importSource("extensions/mmr-web/tools.ts");
    const { FINAL_CONTENT_CAP_BYTES, TRUNCATION_MARKER } = await importSource(
      "extensions/mmr-web/excerpts.ts",
    );
    const body = "x".repeat(FINAL_CONTENT_CAP_BYTES + 50_000);
    const { fetchImpl } = makeFetchMock([() => textResponse(body)]);
    const tool = createReadWebPageTool({
      getSettings: () => settings({ enabled: true, maxResultBytes: FINAL_CONTENT_CAP_BYTES * 2 }),
      getBraveOptions: () => ({ fetchImpl, lookup: PUBLIC_DNS_STUB }),
    });
    const result = await tool.execute("c", { url: "https://example.com/" }, undefined, undefined, {});
    assert.equal(result.details.objectiveApplied, false);
    const text = result.content[0].text;
    const bytes = Buffer.byteLength(text, "utf8");
    assert.ok(
      bytes <= FINAL_CONTENT_CAP_BYTES + Buffer.byteLength(TRUNCATION_MARKER, "utf8"),
      `final output (${bytes} bytes) should be capped at FINAL_CONTENT_CAP_BYTES + marker`,
    );
    assert.ok(text.endsWith(TRUNCATION_MARKER), "truncation marker should be appended");
  });

  it("read_web_page returns truncation details for large pages", async () => {
    const { createReadWebPageTool } = await importSource("extensions/mmr-web/tools.ts");
    const big = "z".repeat(2000);
    const { fetchImpl } = makeFetchMock([() => textResponse(big)]);
    const tool = createReadWebPageTool({
      getSettings: () => settings({ enabled: true, maxResultBytes: 200 }),
      getBraveOptions: () => ({ fetchImpl, lookup: PUBLIC_DNS_STUB }),
    });
    const result = await tool.execute("c", { url: "https://example.com/", forceRefetch: true }, undefined, undefined, {});
    assert.equal(result.details.truncated, true);
    assert.equal(result.details.totalBytes, 200);
    assert.equal(result.details.url, "https://example.com/");
    assert.equal(result.details.forceRefetch, true);
  });
});

describe("mmr-web tool registration based on settings", () => {
  function makePiStub() {
    const tools = [];
    return {
      tools,
      pi: {
        registerTool: (definition) => tools.push(definition),
      },
    };
  }

  it("registers nothing when network is disabled", async () => {
    const { registerMmrWebTools } = await importSource("extensions/mmr-web/tools.ts");
    const { pi, tools } = makePiStub();
    const result = registerMmrWebTools(pi, {
      getSettings: () => settings({ enabled: false }),
    });
    assert.equal(tools.length, 0);
    assert.deepEqual(result, { searchRegistered: false, readerRegistered: false });
  });

  it("registers both tools when enabled without an API key so web_search can report setup feedback", async () => {
    const { registerMmrWebTools } = await importSource("extensions/mmr-web/tools.ts");
    const { pi, tools } = makePiStub();
    const result = registerMmrWebTools(pi, {
      getSettings: () => settings({ enabled: true }),
    });
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ["read_web_page", "web_search"]);
    assert.deepEqual(result, { searchRegistered: true, readerRegistered: true });
  });

  it("registers both tools when enabled and BRAVE_API_KEY is configured", async () => {
    const { registerMmrWebTools } = await importSource("extensions/mmr-web/tools.ts");
    const { pi, tools } = makePiStub();
    const result = registerMmrWebTools(pi, {
      getSettings: () => settings({ enabled: true, braveApiKey: "brv" }),
      getBraveOptions: () => ({}),
    });
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ["read_web_page", "web_search"]);
    assert.deepEqual(result, { searchRegistered: true, readerRegistered: true });
  });
});

describe("mmr-web tool execution - SearXNG", () => {
  it("web_search routes through SearXNG when searxngUrl is configured", async () => {
    const { createWebSearchTool } = await importSource("extensions/mmr-web/tools.ts");
    const { fetchImpl, calls } = makeFetchMock([
      () => jsonResponse({ results: [
        { title: "A", url: "https://example.com/a", content: "alpha" },
        { title: "B", url: "https://example.com/b", content: "beta" },
      ] }),
    ]);
    const tool = createWebSearchTool({
      getSettings: () => settings({ enabled: true, searxngUrl: "http://127.0.0.1:8080" }),
      getBraveOptions: () => ({ fetchImpl }),
    });
    const result = await tool.execute("c1", { objective: "alpha beta" }, undefined, undefined, {});

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.host, "127.0.0.1:8080");
    assert.equal(calls[0].url.pathname, "/search");
    assert.equal(calls[0].url.searchParams.get("format"), "json");
    assert.equal(result.details.backend, "searxng");
    assert.equal(result.details.query, "alpha beta");
    assert.equal(result.details.resultCount, 2);
    assert.match(result.content[0].text, /## 1\. A/);
  });

  it("web_search reports a setup error when searxng is selected without a URL", async () => {
    const { createWebSearchTool } = await importSource("extensions/mmr-web/tools.ts");
    const tool = createWebSearchTool({
      getSettings: () => settings({ enabled: true, searchBackend: "searxng" }),
    });
    await assert.rejects(
      () => tool.execute("c1", { objective: "x" }, undefined, undefined, {}),
      /MMR_WEB_SEARXNG_URL/,
    );
  });

  it("web_search prefers SearXNG over Brave when both configured (auto mode)", async () => {
    const { createWebSearchTool } = await importSource("extensions/mmr-web/tools.ts");
    const { fetchImpl, calls } = makeFetchMock([
      () => jsonResponse({ results: [{ title: "sxng", url: "https://example.com/s" }] }),
    ]);
    const tool = createWebSearchTool({
      getSettings: () => settings({
        enabled: true,
        braveApiKey: "brv",
        searxngUrl: "http://127.0.0.1:8080",
      }),
      getBraveOptions: () => ({ fetchImpl }),
    });
    const result = await tool.execute("c1", { objective: "x" }, undefined, undefined, {});
    assert.equal(result.details.backend, "searxng");
    assert.equal(calls[0].url.host, "127.0.0.1:8080");
  });
});
