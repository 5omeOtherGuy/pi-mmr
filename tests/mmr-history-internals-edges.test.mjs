import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

function sessionInfo(overrides = {}) {
  return {
    path: overrides.path ?? `/tmp/session-${overrides.id ?? "S-1"}.jsonl`,
    id: overrides.id ?? "S-1",
    cwd: overrides.cwd ?? "/repo",
    name: overrides.name,
    parentSessionPath: undefined,
    created: overrides.created ?? new Date("2026-05-20T00:00:00Z"),
    modified: overrides.modified ?? new Date("2026-05-21T00:00:00Z"),
    messageCount: overrides.messageCount ?? 2,
    firstMessage: overrides.firstMessage ?? "first message body",
    allMessagesText: overrides.allMessagesText ?? "all messages body",
  };
}

after(cleanupLoadedSource);

describe("mmr-history session-catalog edge paths", () => {
  it("applies before: filter (drops sessions newer than the bound)", async () => {
    const { searchSessionsWithDiagnostics } = await importSource("extensions/mmr-history/session-catalog.ts");
    const sessions = [
      sessionInfo({ id: "S-old", modified: new Date("2026-05-15T00:00:00Z"), allMessagesText: "history search" }),
      sessionInfo({ id: "S-new", modified: new Date("2026-05-25T00:00:00Z"), allMessagesText: "history search" }),
    ];

    const { matches, queryDiagnostics } = await searchSessionsWithDiagnostics(
      { listSessions: async () => sessions },
      "history before:2026-05-20",
      { limit: 10 },
    );

    assert.deepEqual(matches.map((m) => m.sessionId), ["S-old"]);
    const entry = queryDiagnostics.find((d) => d.filter.startsWith("before:"));
    assert.equal(entry?.status, "applied");
  });

  it("surfaces an invalid after: date as an `invalid` diagnostic without constraining results", async () => {
    const { searchSessionsWithDiagnostics } = await importSource("extensions/mmr-history/session-catalog.ts");
    const sessions = [
      sessionInfo({ id: "S-old", modified: new Date("2026-05-15T00:00:00Z"), allMessagesText: "history search" }),
      sessionInfo({ id: "S-new", modified: new Date("2026-05-25T00:00:00Z"), allMessagesText: "history search" }),
    ];

    const { matches, queryDiagnostics } = await searchSessionsWithDiagnostics(
      { listSessions: async () => sessions },
      "history after:not-a-date",
      { limit: 10 },
    );

    // The invalid date does not constrain the result set: both sessions match.
    assert.deepEqual(matches.map((m) => m.sessionId).sort(), ["S-new", "S-old"]);
    const entry = queryDiagnostics.find((d) => d.filter === "after:not-a-date");
    assert.equal(entry?.status, "invalid", "an unparseable date yields an `invalid` diagnostic");
    assert.ok(
      !queryDiagnostics.some((d) => d.filter === "after:not-a-date" && d.status === "applied"),
      "an invalid date filter must not also appear as applied",
    );
  });

  it("applies id: filter as a case-insensitive substring", async () => {
    const { searchSessionsWithDiagnostics } = await importSource("extensions/mmr-history/session-catalog.ts");
    const sessions = [
      sessionInfo({ id: "ABC-keep", allMessagesText: "x" }),
      sessionInfo({ id: "XYZ-drop", allMessagesText: "x" }),
    ];

    const { matches, queryDiagnostics } = await searchSessionsWithDiagnostics(
      { listSessions: async () => sessions },
      "id:abc",
      { limit: 10 },
    );

    assert.deepEqual(matches.map((m) => m.sessionId), ["ABC-keep"]);
    assert.ok(queryDiagnostics.some((d) => d.filter === "id:abc" && d.status === "applied"));
  });

  it("caps results at the requested limit", async () => {
    const { searchSessions } = await importSource("extensions/mmr-history/session-catalog.ts");
    const sessions = Array.from({ length: 5 }, (_, i) =>
      sessionInfo({
        id: `S-${i}`,
        modified: new Date(`2026-05-${10 + i}T00:00:00Z`),
        allMessagesText: "history search",
      }),
    );

    const matches = await searchSessions({ listSessions: async () => sessions }, "history", { limit: 2 });

    assert.equal(matches.length, 2);
    assert.deepEqual(matches.map((m) => m.sessionId), ["S-4", "S-3"]);
  });

  it("resolveSessionById trims, strips a leading @, and returns undefined for empty input", async () => {
    const { resolveSessionById } = await importSource("extensions/mmr-history/session-catalog.ts");
    const sessions = [sessionInfo({ id: "abc123" })];
    const deps = { listSessions: async () => sessions };

    assert.equal(await resolveSessionById(deps, ""), undefined);
    assert.equal(await resolveSessionById(deps, "   "), undefined);
    assert.equal(await resolveSessionById(deps, "@"), undefined);

    const viaAt = await resolveSessionById(deps, "@abc123");
    assert.ok(viaAt);
    assert.equal(viaAt.info.id, "abc123");
    assert.equal(viaAt.ambiguous, false);
  });

  it("resolveSessionById returns undefined when no session matches the prefix", async () => {
    const { resolveSessionById } = await importSource("extensions/mmr-history/session-catalog.ts");
    const sessions = [sessionInfo({ id: "abc123" })];
    const resolved = await resolveSessionById({ listSessions: async () => sessions }, "zzz");
    assert.equal(resolved, undefined);
  });

  it("resolveSessionById flags ambiguous prefixes and returns all candidate ids", async () => {
    const { resolveSessionById } = await importSource("extensions/mmr-history/session-catalog.ts");
    const sessions = [
      sessionInfo({ id: "abc111" }),
      sessionInfo({ id: "abc222" }),
      sessionInfo({ id: "other" }),
    ];

    const resolved = await resolveSessionById({ listSessions: async () => sessions }, "abc");
    assert.ok(resolved);
    assert.equal(resolved.ambiguous, true);
    assert.deepEqual(resolved.candidateIds.sort(), ["abc111", "abc222"]);
  });

  it("resolveSessionById prefers the shared sessionIndex when provided", async () => {
    const { resolveSessionById } = await importSource("extensions/mmr-history/session-catalog.ts");
    let depsCalls = 0;
    let indexCalls = 0;
    const sessions = [sessionInfo({ id: "abc123" })];
    const deps = {
      listSessions: async () => {
        depsCalls += 1;
        return sessions;
      },
    };
    const sessionIndex = {
      async list() {
        indexCalls += 1;
        return sessions;
      },
      async getTouchedFiles() {
        return new Set();
      },
    };

    const resolved = await resolveSessionById(deps, "abc123", sessionIndex);
    assert.ok(resolved);
    assert.equal(indexCalls, 1);
    assert.equal(depsCalls, 0);
  });
});

describe("mmr-history session-index edge paths and TTL cache", () => {
  function fakeManager(entries) {
    return { getEntries: () => entries };
  }

  it("collectToolCallPaths returns [] for an unknown tool name", async () => {
    const { collectToolCallPaths } = await importSource("extensions/mmr-history/session-index.ts");
    assert.deepEqual(collectToolCallPaths("unknown_tool", { path: "src/x.ts" }), []);
  });

  it("collectToolCallPaths reads write.file_path when write.path is absent", async () => {
    const { collectToolCallPaths } = await importSource("extensions/mmr-history/session-index.ts");
    assert.deepEqual(collectToolCallPaths("write", { file_path: "src/new.ts" }), ["src/new.ts"]);
  });

  it("collectToolCallPaths returns [] for non-object args", async () => {
    const { collectToolCallPaths } = await importSource("extensions/mmr-history/session-index.ts");
    assert.deepEqual(collectToolCallPaths("read", undefined), []);
    assert.deepEqual(collectToolCallPaths("read", null), []);
    assert.deepEqual(collectToolCallPaths("read", "not-an-object"), []);
  });

  it("apply_patch path extraction picks up every patch-header path, including both sides of '->' renames", async () => {
    const { collectToolCallPaths } = await importSource("extensions/mmr-history/session-index.ts");
    const patchText = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "@@",
      "*** Add File: src/b.ts",
      "*** Delete File: src/c.ts",
      "*** Move File: src/d.ts -> src/d-renamed.ts",
      "*** End Patch",
    ].join("\n");
    const paths = collectToolCallPaths("apply_patch", { patchText });
    assert.deepEqual(
      paths.sort(),
      ["src/a.ts", "src/b.ts", "src/c.ts", "src/d-renamed.ts", "src/d.ts"],
    );
  });

  it("apply_patch path extraction accepts the legacy `patch` argument shape", async () => {
    const { collectToolCallPaths } = await importSource("extensions/mmr-history/session-index.ts");
    const paths = collectToolCallPaths("apply_patch", { patch: "*** Update File: src/legacy.ts\n@@" });
    assert.deepEqual(paths, ["src/legacy.ts"]);
  });

  it("extractTouchedFilesFromEntries skips non-assistant messages and string content", async () => {
    const { extractTouchedFilesFromEntries } = await importSource("extensions/mmr-history/session-index.ts");
    const entries = [
      // User message with a path-shaped tool call is ignored: only
      // assistant-authored structured calls are inspected.
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "toolCall", name: "edit", arguments: { path: "src/from-user.ts" } }],
        },
      },
      // Assistant message with string content is ignored: structured
      // tool calls only.
      { type: "message", message: { role: "assistant", content: "please edit src/from-string.ts" } },
      // Non-message entries are ignored.
      { type: "compaction", summary: "compacted src/from-summary.ts" },
      // Real assistant tool call survives.
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", name: "edit", arguments: { path: "src/Real.ts" } }],
        },
      },
    ];
    const touched = extractTouchedFilesFromEntries(entries, "/repo");
    assert.deepEqual(Array.from(touched).sort(), ["src/real.ts"]);
  });

  it("normalizeTouchedPath handles backslashes and a path equal to the cwd", async () => {
    const { normalizeTouchedPath } = await importSource("extensions/mmr-history/session-index.ts");
    assert.equal(normalizeTouchedPath("src\\auth.ts", "/repo"), "src/auth.ts");
    // A path that *is* the cwd itself is not a touched file.
    assert.equal(normalizeTouchedPath("/repo", "/repo"), undefined);
    // Trailing slash on the cwd argument must not change the contract.
    assert.equal(normalizeTouchedPath("/repo/src/auth.ts", "/repo/"), "src/auth.ts");
  });

  it("SessionIndex.list reuses the cached result when the fingerprint is unchanged", async () => {
    const { createSessionIndex } = await importSource("extensions/mmr-history/session-index.ts");
    let listCalls = 0;
    const sessions = [sessionInfo({ id: "S-1" })];
    const deps = {
      listSessions: async () => {
        listCalls += 1;
        return sessions;
      },
      openSession: () => fakeManager([]),
    };
    let nowMs = 1_000;
    const index = createSessionIndex(deps, { listTtlMs: 50, now: () => nowMs });

    await index.list();
    await index.list();
    assert.equal(listCalls, 1, "second call within TTL should hit the cache");

    nowMs += 100; // expire
    await index.list();
    assert.equal(listCalls, 2, "TTL expiry should trigger a refresh");
  });

  it("SessionIndex.getTouchedFiles memoizes per-session by id|modified|messageCount", async () => {
    const { createSessionIndex } = await importSource("extensions/mmr-history/session-index.ts");
    const info = sessionInfo({ id: "S-1" });
    let openCalls = 0;
    const deps = {
      listSessions: async () => [info],
      openSession: () => {
        openCalls += 1;
        return fakeManager([
          {
            type: "message",
            message: {
              role: "assistant",
              content: [{ type: "toolCall", name: "edit", arguments: { path: "src/x.ts" } }],
            },
          },
        ]);
      },
    };
    const index = createSessionIndex(deps);

    const first = await index.getTouchedFiles(info);
    const second = await index.getTouchedFiles(info);
    assert.deepEqual(Array.from(first).sort(), ["src/x.ts"]);
    assert.equal(second, first, "same session key must reuse the cached set");
    assert.equal(openCalls, 1, "openSession must not be called a second time for an unchanged session");
  });

  it("SessionIndex discards per-session touched cache when the global fingerprint changes", async () => {
    const { createSessionIndex } = await importSource("extensions/mmr-history/session-index.ts");
    const infoV1 = sessionInfo({ id: "S-1", modified: new Date("2026-05-21T00:00:00Z"), messageCount: 2 });
    const infoV2 = { ...infoV1, modified: new Date("2026-05-22T00:00:00Z"), messageCount: 3 };
    let listCalls = 0;
    let openCalls = 0;
    const deps = {
      listSessions: async () => {
        listCalls += 1;
        return [listCalls === 1 ? infoV1 : infoV2];
      },
      openSession: () => {
        openCalls += 1;
        return fakeManager([]);
      },
    };
    let nowMs = 1_000;
    const index = createSessionIndex(deps, { listTtlMs: 10, now: () => nowMs });

    // First populate touched cache for v1.
    await index.list();
    await index.getTouchedFiles(infoV1);
    assert.equal(openCalls, 1);

    // Expire TTL so a fresh list call happens with a changed fingerprint.
    nowMs += 100;
    await index.list();
    // v1 key must no longer be cached after fingerprint change.
    await index.getTouchedFiles(infoV2);
    assert.equal(openCalls, 2, "fingerprint change must invalidate per-session touched cache");
  });
});

describe("mmr-history read-session edge paths", () => {
  it("truncates excerpts to fit maxBytes and reports truncated:true", async () => {
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const { readSessionForGoal } = await importSource("extensions/mmr-history/read-session.ts");
    const manager = SessionManager.inMemory("/repo");
    // Three large assistant messages, each well past the limit.
    const big = "alpha ".repeat(200);
    manager.appendMessage({ role: "user", content: `alpha trigger ${big}` });
    manager.appendMessage({ role: "assistant", content: `first ${big}` });
    manager.appendMessage({ role: "assistant", content: `second ${big}` });

    const info = sessionInfo({
      id: manager.getSessionId(),
      messageCount: 3,
      firstMessage: "alpha first",
      allMessagesText: "alpha discussion",
    });

    const result = readSessionForGoal(info, manager, "alpha", 500);

    assert.equal(result.truncated, true);
    assert.ok(result.excerptCount >= 1);
    // Once truncated, the byte budget must have been honoured: the
    // count of excerpts collected is strictly fewer than the count
    // of candidate excerpts (3 messages + entries + a session
    // excerpt).
    assert.ok(result.excerptCount < manager.getEntries().length + 4);
  });

  it("goal tokens shorter than 3 chars and common stop-words are dropped from matchedTerms", async () => {
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const { readSessionForGoal } = await importSource("extensions/mmr-history/read-session.ts");
    const manager = SessionManager.inMemory("/repo");
    manager.appendMessage({ role: "user", content: "alpha discussion about the planner" });

    const info = sessionInfo({ id: manager.getSessionId(), messageCount: 1 });
    // "the" is in the stop list; "a" is shorter than the 3-char floor.
    const result = readSessionForGoal(info, manager, "the a alpha", 10_000);

    assert.ok(result.matchedTerms.includes("alpha"));
    assert.ok(!result.matchedTerms.includes("the"), "stop-word must not survive into matchedTerms");
    assert.ok(!result.matchedTerms.includes("a"), "short token must not survive into matchedTerms");
  });

  it("goal tokens that carry sensitive substrings are redacted in matchedTerms", async () => {
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const { readSessionForGoal } = await importSource("extensions/mmr-history/read-session.ts");
    const manager = SessionManager.inMemory("/repo");
    manager.appendMessage({ role: "user", content: "We mentioned [home]/alice/secret.ts" });

    const info = sessionInfo({ id: manager.getSessionId(), messageCount: 1 });
    const result = readSessionForGoal(info, manager, "/home/alice/secret.ts", 10_000);

    // No goal-derived matched term may carry the raw username.
    for (const term of result.matchedTerms) {
      assert.ok(!term.includes("alice"), `matchedTerms must redact sensitive substrings: ${term}`);
    }
  });

  it("formatSessionReadResult prints the standard header lines and the empty-excerpts footer", async () => {
    const { formatSessionReadResult } = await importSource("extensions/mmr-history/read-session.ts");
    const empty = {
      sessionId: "S-empty",
      name: "Empty session",
      messageCount: 0,
      excerptCount: 0,
      truncated: false,
      matchedTerms: [],
      excerpts: [],
    };
    const text = formatSessionReadResult(empty, "explain plan");
    assert.match(text, /^# Session S-empty/);
    assert.match(text, /Goal: explain plan/);
    assert.match(text, /Name: Empty session/);
    assert.match(text, /Messages: 0/);
    assert.match(text, /Excerpts: 0/);
    assert.match(text, /No readable session content matched the requested goal\.$/);
  });
});

describe("mmr-history tools edge paths and input validation", () => {
  function sessions(...info) {
    return info;
  }
  function baseDeps(overrides = {}) {
    return {
      getSettings: () => ({ enabled: true, maxResults: 10, maxExcerptBytes: 10_000 }),
      listSessions: async () => [],
      openSession: () => {
        throw new Error("unused");
      },
      ...overrides,
    };
  }

  it("renders the invalid-date diagnostic group in find_session output", async () => {
    const { createFindSessionTool } = await importSource("extensions/mmr-history/tools.ts");
    const tool = createFindSessionTool(baseDeps({
      listSessions: async () => [
        sessionInfo({ id: "S-1", modified: new Date("2026-05-21T00:00:00Z"), allMessagesText: "history search" }),
      ],
    }));
    const result = await tool.execute("call", { query: "history after:not-a-date" }, undefined, undefined, { cwd: "/repo" });
    const text = result.content.map((c) => c.text).join("\n");
    assert.match(text, /Invalid date filters ignored: after:not-a-date/);
    assert.ok(
      result.details.queryDiagnostics.some((d) => d.filter === "after:not-a-date" && d.status === "invalid"),
      "details.queryDiagnostics carries the invalid-date entry",
    );
  });

  it("find_session throws when the privacy gate is disabled", async () => {
    const { createFindSessionTool } = await importSource("extensions/mmr-history/tools.ts");
    const tool = createFindSessionTool(baseDeps({ getSettings: () => ({ enabled: false, maxResults: 10, maxExcerptBytes: 10_000 }) }));
    await assert.rejects(
      () => tool.execute("call", { query: "anything" }, undefined, undefined, { cwd: "/repo" }),
      /MMR_HISTORY_ENABLE=true/,
    );
  });

  it("find_session rejects an empty or whitespace-only query", async () => {
    const { createFindSessionTool } = await importSource("extensions/mmr-history/tools.ts");
    const tool = createFindSessionTool(baseDeps());
    await assert.rejects(
      () => tool.execute("call", { query: "" }, undefined, undefined, { cwd: "/repo" }),
      /non-empty query/,
    );
    await assert.rejects(
      () => tool.execute("call", { query: "   " }, undefined, undefined, { cwd: "/repo" }),
      /non-empty query/,
    );
  });

  it("find_session caps limit at settings.maxResults and clamps low bounds", async () => {
    const { createFindSessionTool } = await importSource("extensions/mmr-history/tools.ts");
    // Build more sessions than the configured cap so an oversized
    // limit cannot quietly succeed by happening to fit.
    const many = Array.from({ length: 8 }, (_, i) =>
      sessionInfo({
        id: `S-${i}`,
        modified: new Date(`2026-05-${10 + i}T00:00:00Z`),
        allMessagesText: "hits",
      }),
    );
    const deps = baseDeps({
      getSettings: () => ({ enabled: true, maxResults: 3, maxExcerptBytes: 10_000 }),
      listSessions: async () => many,
    });
    const tool = createFindSessionTool(deps);

    const capped = await tool.execute("call", { query: "hits", limit: 999 }, undefined, undefined, { cwd: "/repo" });
    assert.equal(capped.details.matches.length, 3, "limit must be capped at settings.maxResults");

    const floored = await tool.execute("call", { query: "hits", limit: 0 }, undefined, undefined, { cwd: "/repo" });
    assert.equal(floored.details.matches.length, 1, "limit must be clamped to at least 1");

    const nonFinite = await tool.execute("call", { query: "hits", limit: Number.NaN }, undefined, undefined, { cwd: "/repo" });
    assert.equal(nonFinite.details.matches.length, 3, "non-finite limit must fall back to settings.maxResults");
  });

  it("find_session ignores non-object params (no crash, query missing -> rejection)", async () => {
    const { createFindSessionTool } = await importSource("extensions/mmr-history/tools.ts");
    const tool = createFindSessionTool(baseDeps());
    await assert.rejects(
      () => tool.execute("call", null, undefined, undefined, { cwd: "/repo" }),
      /non-empty query/,
    );
    await assert.rejects(
      () => tool.execute("call", "not-an-object", undefined, undefined, { cwd: "/repo" }),
      /non-empty query/,
    );
  });

  it("read_session throws when the privacy gate is disabled", async () => {
    const { createReadSessionTool } = await importSource("extensions/mmr-history/tools.ts");
    const tool = createReadSessionTool(baseDeps({ getSettings: () => ({ enabled: false, maxResults: 10, maxExcerptBytes: 10_000 }) }));
    await assert.rejects(
      () => tool.execute("call", { sessionId: "abc", goal: "x" }, undefined, undefined, { cwd: "/repo" }),
      /MMR_HISTORY_ENABLE=true/,
    );
  });

  it("read_session requires a sessionId and a non-empty goal", async () => {
    const { createReadSessionTool } = await importSource("extensions/mmr-history/tools.ts");
    const tool = createReadSessionTool(baseDeps());

    await assert.rejects(
      () => tool.execute("call", { goal: "g" }, undefined, undefined, { cwd: "/repo" }),
      /requires a sessionId/,
    );
    await assert.rejects(
      () => tool.execute("call", { sessionId: "abc" }, undefined, undefined, { cwd: "/repo" }),
      /non-empty goal/,
    );
    await assert.rejects(
      () => tool.execute("call", { sessionId: "abc", goal: "   " }, undefined, undefined, { cwd: "/repo" }),
      /non-empty goal/,
    );
  });

  it("read_session reports a clear error when no session matches the id/prefix", async () => {
    const { createReadSessionTool } = await importSource("extensions/mmr-history/tools.ts");
    const tool = createReadSessionTool(baseDeps({ listSessions: async () => sessions(sessionInfo({ id: "abc123" })) }));
    await assert.rejects(
      () => tool.execute("call", { sessionId: "zzz", goal: "anything" }, undefined, undefined, { cwd: "/repo" }),
      /No local Pi session matched 'zzz'\. Use find_session first\./,
    );
  });

  it("read_session emits a deprecation warning when the 'analysis' input key is present", async () => {
    const { createReadSessionTool } = await importSource("extensions/mmr-history/tools.ts");
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const manager = SessionManager.inMemory("/repo");
    manager.appendMessage({ role: "user", content: "alpha discussion" });
    const info = sessionInfo({ id: manager.getSessionId(), messageCount: 1 });
    const deps = {
      getSettings: () => ({ enabled: true, maxResults: 10, maxExcerptBytes: 10_000 }),
      listSessions: async () => [info],
      openSession: () => manager,
      // No analysisRunner is wired in, so the worker call falls back
      // to deterministic lexical extraction. That path still surfaces
      // the `warnings` array on the result details.
    };
    const tool = createReadSessionTool(deps);

    const result = await tool.execute(
      "call",
      { sessionId: info.id, goal: "alpha", analysis: "deterministic" },
      undefined,
      undefined,
      { cwd: "/repo" },
    );

    assert.ok(Array.isArray(result.details.warnings));
    assert.ok(
      result.details.warnings.some((w) => /'analysis' is no longer accepted/.test(w)),
      `expected an 'analysis' deprecation warning; got ${JSON.stringify(result.details.warnings)}`,
    );
  });
});
