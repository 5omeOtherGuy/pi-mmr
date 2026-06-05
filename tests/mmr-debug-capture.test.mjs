import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const SRC = "extensions/mmr-debug/capture.ts";
const INDEX = "extensions/mmr-debug/index.ts";

/** Minimal fake ExtensionAPI that records registered event handlers. */
function fakePi() {
  const handlers = new Map();
  return {
    on(event, handler) {
      handlers.set(event, handler);
    },
    emit(event, payload, ctx) {
      const handler = handlers.get(event);
      return handler ? handler(payload, ctx) : undefined;
    },
    has(event) {
      return handlers.has(event);
    },
  };
}

const fakeCtx = {
  model: { provider: "anthropic", id: "claude-test" },
  sessionManager: { getSessionId: () => "sess-1" },
};

function readJsonl(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

describe("mmr-debug capture: extractSystemPrompt", () => {
  it("reads the OpenAI Codex/Responses `instructions` string", async () => {
    const { extractSystemPrompt } = await importSource(SRC);
    const result = extractSystemPrompt({ instructions: "You are Pi.", input: [] });
    assert.deepEqual(result, { source: "instructions", text: "You are Pi." });
  });

  it("reads the Anthropic `system` string", async () => {
    const { extractSystemPrompt } = await importSource(SRC);
    const result = extractSystemPrompt({ system: "Anthropic head", messages: [] });
    assert.deepEqual(result, { source: "system", text: "Anthropic head" });
  });

  it("flattens an Anthropic `system` text-block array", async () => {
    const { extractSystemPrompt } = await importSource(SRC);
    const result = extractSystemPrompt({
      system: [
        { type: "text", text: "part one. " },
        { type: "text", text: "part two." },
      ],
    });
    assert.deepEqual(result, { source: "system", text: "part one. part two." });
  });

  it("reconstructs the system text from OpenAI Responses `input[]` role messages", async () => {
    const { extractSystemPrompt } = await importSource(SRC);
    const result = extractSystemPrompt({
      input: [
        { role: "system", content: [{ type: "input_text", text: "system rules" }] },
        { role: "developer", content: "developer note" },
        { role: "user", content: [{ type: "input_text", text: "ignore me" }] },
      ],
    });
    assert.deepEqual(result, { source: "input", text: "system rules\n\ndeveloper note" });
  });

  it("prefers `instructions` over `input[]` when both are present", async () => {
    const { extractSystemPrompt } = await importSource(SRC);
    const result = extractSystemPrompt({
      instructions: "wins",
      input: [{ role: "system", content: "loses" }],
    });
    assert.equal(result?.source, "instructions");
    assert.equal(result?.text, "wins");
  });

  it("returns undefined when no recognizable system text is present", async () => {
    const { extractSystemPrompt } = await importSource(SRC);
    assert.equal(extractSystemPrompt({ messages: [] }), undefined);
    assert.equal(extractSystemPrompt({ input: [{ role: "user", content: "hi" }] }), undefined);
    assert.equal(extractSystemPrompt(null), undefined);
    assert.equal(extractSystemPrompt("nope"), undefined);
  });
});

describe("mmr-debug capture: extractToolNames", () => {
  it("reads Anthropic-shaped tool names", async () => {
    const { extractToolNames } = await importSource(SRC);
    const names = extractToolNames({ tools: [{ name: "read" }, { name: "bash" }] });
    assert.deepEqual(names, ["read", "bash"]);
  });

  it("reads OpenAI function-tool names and preserves order", async () => {
    const { extractToolNames } = await importSource(SRC);
    const names = extractToolNames({
      tools: [{ function: { name: "web_search" } }, { name: "edit" }],
    });
    assert.deepEqual(names, ["web_search", "edit"]);
  });

  it("returns an empty array when there are no tools", async () => {
    const { extractToolNames } = await importSource(SRC);
    assert.deepEqual(extractToolNames({}), []);
    assert.deepEqual(extractToolNames({ tools: "nope" }), []);
    assert.deepEqual(extractToolNames(null), []);
  });
});

describe("mmr-debug capture: extractMessageSummary", () => {
  it("flattens assistant text blocks and keeps the stop reason", async () => {
    const { extractMessageSummary } = await importSource(SRC);
    const summary = extractMessageSummary({
      role: "assistant",
      stopReason: "end_turn",
      content: [
        { type: "text", text: "Hello " },
        { type: "tool_use", name: "bash", input: {} },
        { type: "text", text: "world" },
      ],
    });
    assert.deepEqual(summary, { role: "assistant", text: "Hello world", stopReason: "end_turn" });
  });

  it("handles a bare string content with no stop reason", async () => {
    const { extractMessageSummary } = await importSource(SRC);
    const summary = extractMessageSummary({ role: "user", content: "just text" });
    assert.deepEqual(summary, { role: "user", text: "just text" });
  });

  it("returns undefined for non-record messages", async () => {
    const { extractMessageSummary } = await importSource(SRC);
    assert.equal(extractMessageSummary(undefined), undefined);
    assert.equal(extractMessageSummary([]), undefined);
  });
});

describe("mmr-debug capture: stringifyContent", () => {
  it("passes through strings and ignores non-text blocks", async () => {
    const { stringifyContent } = await importSource(SRC);
    assert.equal(stringifyContent("plain"), "plain");
    assert.equal(
      stringifyContent([{ type: "image", source: {} }, { type: "text", text: "kept" }]),
      "kept",
    );
    assert.equal(stringifyContent(42), "");
  });
});

describe("mmr-debug extension wiring", () => {
  it("is inert (registers no hooks) when the capture env var is unset", async () => {
    const prev = process.env.MMR_DEBUG_CAPTURE_FILE;
    delete process.env.MMR_DEBUG_CAPTURE_FILE;
    try {
      const { default: extension } = await importSource(INDEX);
      const pi = fakePi();
      extension(pi);
      assert.equal(pi.has("before_provider_request"), false);
      assert.equal(pi.has("after_provider_response"), false);
      assert.equal(pi.has("message_end"), false);
    } finally {
      if (prev === undefined) delete process.env.MMR_DEBUG_CAPTURE_FILE;
      else process.env.MMR_DEBUG_CAPTURE_FILE = prev;
    }
  });

  it("appends request/response/message JSONL records and never mutates the payload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mmr-debug-"));
    const file = join(dir, "nested", "capture.jsonl");
    const prev = process.env.MMR_DEBUG_CAPTURE_FILE;
    const prevFull = process.env.MMR_DEBUG_CAPTURE_FULL;
    process.env.MMR_DEBUG_CAPTURE_FILE = file;
    delete process.env.MMR_DEBUG_CAPTURE_FULL;
    try {
      const { default: extension } = await importSource(INDEX);
      const pi = fakePi();
      extension(pi);

      pi.emit("turn_start", { type: "turn_start", turnIndex: 3, timestamp: 0 });
      const payload = { system: "Clean head", tools: [{ name: "read" }] };
      const reqResult = pi.emit("before_provider_request", { type: "before_provider_request", payload }, fakeCtx);
      // Read-only: handler must not return a replacement payload.
      assert.equal(reqResult, undefined);
      assert.deepEqual(payload, { system: "Clean head", tools: [{ name: "read" }] });

      pi.emit("after_provider_response", { type: "after_provider_response", status: 200, headers: { "x-rl": "9" } }, fakeCtx);
      pi.emit(
        "message_end",
        { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "end_turn" } },
        fakeCtx,
      );
      // A non-assistant message is ignored.
      pi.emit("message_end", { type: "message_end", message: { role: "user", content: "ignored" } }, fakeCtx);

      const records = readJsonl(file);
      assert.equal(records.length, 3);

      const [req, res, msg] = records;
      assert.equal(req.kind, "request");
      assert.equal(req.turn, 3);
      assert.equal(req.systemPromptSource, "system");
      assert.equal(req.systemPrompt, "Clean head");
      assert.deepEqual(req.tools, ["read"]);
      assert.deepEqual(req.model, { provider: "anthropic", id: "claude-test" });
      assert.equal(req.sessionId, "sess-1");
      assert.equal(req.payload, undefined, "raw payload omitted unless MMR_DEBUG_CAPTURE_FULL is set");

      assert.equal(res.kind, "response");
      assert.equal(res.status, 200);
      assert.deepEqual(res.headers, { "x-rl": "9" });

      assert.equal(msg.kind, "message");
      assert.equal(msg.role, "assistant");
      assert.equal(msg.text, "hi");
      assert.equal(msg.stopReason, "end_turn");

      // seq is monotonic across records.
      assert.deepEqual(records.map((r) => r.seq), [0, 1, 2]);
    } finally {
      if (prev === undefined) delete process.env.MMR_DEBUG_CAPTURE_FILE;
      else process.env.MMR_DEBUG_CAPTURE_FILE = prev;
      if (prevFull === undefined) delete process.env.MMR_DEBUG_CAPTURE_FULL;
      else process.env.MMR_DEBUG_CAPTURE_FULL = prevFull;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records the full raw payload when MMR_DEBUG_CAPTURE_FULL is truthy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mmr-debug-"));
    const file = join(dir, "capture.jsonl");
    const prev = process.env.MMR_DEBUG_CAPTURE_FILE;
    const prevFull = process.env.MMR_DEBUG_CAPTURE_FULL;
    process.env.MMR_DEBUG_CAPTURE_FILE = file;
    process.env.MMR_DEBUG_CAPTURE_FULL = "true";
    try {
      const { default: extension } = await importSource(INDEX);
      const pi = fakePi();
      extension(pi);
      const payload = { system: "head", messages: [{ role: "user", content: "secret-ish" }] };
      pi.emit("before_provider_request", { type: "before_provider_request", payload }, fakeCtx);
      const [req] = readJsonl(file);
      assert.deepEqual(req.payload, payload);
    } finally {
      if (prev === undefined) delete process.env.MMR_DEBUG_CAPTURE_FILE;
      else process.env.MMR_DEBUG_CAPTURE_FILE = prev;
      if (prevFull === undefined) delete process.env.MMR_DEBUG_CAPTURE_FULL;
      else process.env.MMR_DEBUG_CAPTURE_FULL = prevFull;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
