import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const CAPTURE_ENV = "MMR_DEBUG_CAPTURE_SYSTEM_PROMPT_FILE";
const SUBAGENT_STATE = {
  profile: "finder",
  provider: "google",
  model: "gemini-3.5-flash",
  promptRoute: "standalone",
  activeTools: ["grep"],
  activatedAt: "2026-05-26T00:00:00.000Z",
};

let originalEnv;
const tmpFiles = [];

function tmpPath() {
  const p = path.join(os.tmpdir(), `mmr-capture-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
  tmpFiles.push(p);
  return p;
}

async function loadRuntime() {
  return importSource("extensions/mmr-core/runtime.ts");
}

function fireRequest(handlers, ctx, payload) {
  return handlers.get("before_provider_request")({ type: "before_provider_request", payload }, ctx);
}

beforeEach(async () => {
  originalEnv = process.env[CAPTURE_ENV];
  delete process.env[CAPTURE_ENV];
  const runtime = await loadRuntime();
  runtime.setMmrModeState(undefined);
  runtime.setMmrSubagentState(undefined);
  runtime.clearMmrManagedModelOverride();
});

afterEach(async () => {
  if (originalEnv === undefined) delete process.env[CAPTURE_ENV];
  else process.env[CAPTURE_ENV] = originalEnv;
  const runtime = await loadRuntime();
  runtime.setMmrSubagentState(undefined);
  for (const file of tmpFiles.splice(0)) {
    try {
      fs.unlinkSync(file);
    } catch {
      // best-effort cleanup
    }
  }
});

describe("mmr-core subagent system-prompt capture", () => {
  it("captures an `instructions`-shaped payload to the env-pointed file", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await loadRuntime();
    runtime.setMmrSubagentState(SUBAGENT_STATE);
    const file = tmpPath();
    process.env[CAPTURE_ENV] = file;
    const { ctx } = createMockExtensionContext({ models: [], hasUI: false });
    const { pi, handlers } = createMockPi();
    extension(pi);

    await fireRequest(handlers, ctx, { instructions: "system from instructions" });
    assert.equal(fs.readFileSync(file, "utf8"), "system from instructions");
  });

  it("captures a `system`-shaped payload to the env-pointed file", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await loadRuntime();
    runtime.setMmrSubagentState(SUBAGENT_STATE);
    const file = tmpPath();
    process.env[CAPTURE_ENV] = file;
    const { ctx } = createMockExtensionContext({ models: [], hasUI: false });
    const { pi, handlers } = createMockPi();
    extension(pi);

    await fireRequest(handlers, ctx, { system: "system from system field" });
    assert.equal(fs.readFileSync(file, "utf8"), "system from system field");
  });

  it("captures an `input[]`-array payload as the JSON-stringified array", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await loadRuntime();
    runtime.setMmrSubagentState(SUBAGENT_STATE);
    const file = tmpPath();
    process.env[CAPTURE_ENV] = file;
    const { ctx } = createMockExtensionContext({ models: [], hasUI: false });
    const { pi, handlers } = createMockPi();
    extension(pi);

    const input = [{ role: "system", content: "boot" }];
    await fireRequest(handlers, ctx, { input });
    assert.equal(fs.readFileSync(file, "utf8"), JSON.stringify(input, null, 2));
  });

  it("writes no file when the env var is unset", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await loadRuntime();
    runtime.setMmrSubagentState(SUBAGENT_STATE);
    const file = tmpPath();
    // env var intentionally left unset
    const { ctx } = createMockExtensionContext({ models: [], hasUI: false });
    const { pi, handlers } = createMockPi();
    extension(pi);

    await fireRequest(handlers, ctx, { instructions: "should not be written" });
    assert.equal(fs.existsSync(file), false);
  });

  it("writes no file for a non-subagent (normal) session even when the env var is set", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await loadRuntime();
    runtime.setMmrSubagentState(undefined);
    const file = tmpPath();
    process.env[CAPTURE_ENV] = file;
    const { ctx } = createMockExtensionContext({ models: [], hasUI: false });
    const { pi, handlers } = createMockPi();
    extension(pi);

    await fireRequest(handlers, ctx, { instructions: "normal session prompt" });
    assert.equal(fs.existsSync(file), false);
  });

  it("does not throw when the capture path is unwritable", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await loadRuntime();
    runtime.setMmrSubagentState(SUBAGENT_STATE);
    // Point at a path under a non-existent directory so writeFileSync fails.
    const file = path.join(os.tmpdir(), `mmr-capture-missing-${process.pid}`, "nested", "out.txt");
    process.env[CAPTURE_ENV] = file;
    const { ctx } = createMockExtensionContext({ models: [], hasUI: false });
    const { pi, handlers } = createMockPi();
    extension(pi);

    assert.doesNotThrow(() => fireRequest(handlers, ctx, { instructions: "unwritable" }));
    assert.equal(fs.existsSync(file), false);
  });
});
