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
    calls.push({ url: new URL(String(input)) });
    return handler();
  };
  return { fetchImpl, calls };
}

describe("normalizeDomainInput — canonical bare-host parsing", () => {
  const cases = [
    ["https://www.Example.com/path", "example.com"],
    ["HTTP://Example.com", "example.com"],
    ["example.com", "example.com"],
    ["  example.com  ", "example.com"],
    ["sub.example.com/path?x=1#y", "sub.example.com"],
    ["example.com:8080", "example.com"],
    ["user:pw@example.com", "example.com"],
    ["*.example.com", "example.com"],
    [".example.com", "example.com"],
    ["example.com.", "example.com"],
    ["EXAMPLE.COM", "example.com"],
    ["ma\u00f1ana.com", "xn--maana-pta.com"],
    ["m\u00fcnchen.de", "xn--mnchen-3ya.de"],
  ];
  for (const [input, expected] of cases) {
    it(`normalizes ${JSON.stringify(input)} -> ${expected}`, async () => {
      const { normalizeDomainInput } = await importSource("extensions/mmr-web/tools.ts");
      assert.equal(normalizeDomainInput(input), expected);
    });
  }

  const invalid = ["", "   ", "not a host", "2001:db8::1", "example.com:abc", "***"];
  for (const input of invalid) {
    it(`treats ${JSON.stringify(input)} as invalid (empty result)`, async () => {
      const { normalizeDomainInput } = await importSource("extensions/mmr-web/tools.ts");
      assert.equal(normalizeDomainInput(input), "");
    });
  }
});

describe("web_search domain list — reject, do not silently drop", () => {
  it("rejects an invalid domain entry instead of dropping it (no silent no-op)", async () => {
    const { createWebSearchTool } = await importSource("extensions/mmr-web/tools.ts");
    const { fetchImpl, calls } = makeFetchMock(() => braveJson([]));
    const tool = createWebSearchTool({
      getSettings: () => settings(),
      getBraveOptions: () => ({ apiKey: "brv", fetchImpl }),
    });
    await assert.rejects(
      () => tool.execute("c", { objective: "x", include_domains: ["   "] }, undefined, undefined, {}),
      /invalid domain/i,
    );
    assert.equal(calls.length, 0);
  });

  it("rejects more than the documented cap of unique domains without fetching", async () => {
    const { createWebSearchTool, MAX_DOMAIN_FILTERS } = await importSource("extensions/mmr-web/tools.ts");
    const { fetchImpl, calls } = makeFetchMock(() => braveJson([]));
    const tool = createWebSearchTool({
      getSettings: () => settings(),
      getBraveOptions: () => ({ apiKey: "brv", fetchImpl }),
    });
    const tooMany = Array.from({ length: MAX_DOMAIN_FILTERS + 1 }, (_, i) => `d${i}.example.com`);
    await assert.rejects(
      () => tool.execute("c", { objective: "x", include_domains: tooMany }, undefined, undefined, {}),
      /at most/i,
    );
    assert.equal(calls.length, 0);
  });

  it("collapses duplicates so a list within the cap after dedupe is accepted", async () => {
    const { createWebSearchTool, MAX_DOMAIN_FILTERS } = await importSource("extensions/mmr-web/tools.ts");
    const { fetchImpl } = makeFetchMock(() => braveJson([{ title: "A", url: "https://x/a" }]));
    const tool = createWebSearchTool({
      getSettings: () => settings(),
      getBraveOptions: () => ({ apiKey: "brv", fetchImpl }),
    });
    const dupes = Array.from({ length: MAX_DOMAIN_FILTERS + 5 }, () => "https://www.example.com");
    const result = await tool.execute("c", { objective: "x", exclude_domains: dupes }, undefined, undefined, {});
    assert.ok(result.details.filters.some((f) => f.filter === "exclude_domains"));
  });

  it("detects conflict after canonicalization (.example.com vs example.com)", async () => {
    const { createWebSearchTool } = await importSource("extensions/mmr-web/tools.ts");
    const { fetchImpl, calls } = makeFetchMock(() => braveJson([]));
    const tool = createWebSearchTool({
      getSettings: () => settings(),
      getBraveOptions: () => ({ apiKey: "brv", fetchImpl }),
    });
    await assert.rejects(
      () =>
        tool.execute(
          "c",
          { objective: "x", include_domains: [".example.com"], exclude_domains: ["example.com"] },
          undefined,
          undefined,
          {},
        ),
      /both include_domains and exclude_domains|conflict/i,
    );
    assert.equal(calls.length, 0);
  });

  it("matches a punycoded result host against a Unicode include_domains filter", async () => {
    const { createWebSearchTool } = await importSource("extensions/mmr-web/tools.ts");
    const { fetchImpl } = makeFetchMock(() =>
      braveJson([
        { title: "A", url: "https://xn--maana-pta.com/a", description: "alpha" },
        { title: "B", url: "https://other.com/b", description: "beta" },
      ]),
    );
    const tool = createWebSearchTool({
      getSettings: () => settings(),
      getBraveOptions: () => ({ apiKey: "brv", fetchImpl }),
    });
    const result = await tool.execute(
      "c",
      { objective: "x", include_domains: ["ma\u00f1ana.com"] },
      undefined,
      undefined,
      {},
    );
    assert.equal(result.details.resultCount, 1);
    assert.match(result.content[0].text, /^https:\/\/xn--maana-pta\.com\/a$/m);
  });
});
