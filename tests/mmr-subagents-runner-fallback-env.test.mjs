import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const RUNNER_MODULE = "extensions/mmr-subagents/runner.ts";
const ENV_MODULE = "extensions/mmr-core/subagent-model-override-env.ts";

function fakeSpawnCapturing(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    return {
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on(event, listener) {
        if (event === "close") queueMicrotask(() => listener(0, null));
        return this;
      },
      kill: () => true,
    };
  };
}

describe("runner forwards session fallback override via env (#9)", () => {
  it("injects the model-preference override env var when an override is present", async () => {
    const { runMmrSubagentWorker } = await importSource(RUNNER_MODULE);
    const { MMR_SUBAGENT_MODEL_PREFERENCES_ENV, parseMmrSubagentModelPreferencesEnv } = await importSource(ENV_MODULE);
    const calls = [];
    const override = [
      { model: "claude-opus-4-6", providers: ["claude-subscription"], thinkingLevel: "high" },
      { model: "gpt-5.5" },
    ];
    await runMmrSubagentWorker(
      {
        profileName: "finder",
        prompt: "q",
        cwd: "/tmp/cwd",
        model: "claude-subscription/claude-opus-4-6",
        modelPreferencesOverride: override,
      },
      { spawn: fakeSpawnCapturing(calls), resolveInvocation: (args) => ({ command: "pi", args }) },
    );
    assert.equal(calls.length, 1);
    const env = calls[0].options?.env;
    assert.ok(env, "spawn must receive a custom env when an override is present");
    assert.deepEqual(parseMmrSubagentModelPreferencesEnv(env[MMR_SUBAGENT_MODEL_PREFERENCES_ENV]), override);
    // The rest of process.env is preserved so the child still resolves Pi.
    assert.equal(env.PATH, process.env.PATH);
  });

  it("scrubs the override env var from the child when no override is present", async () => {
    const { runMmrSubagentWorker } = await importSource(RUNNER_MODULE);
    const { MMR_SUBAGENT_MODEL_PREFERENCES_ENV } = await importSource(ENV_MODULE);
    const calls = [];
    await runMmrSubagentWorker(
      { profileName: "finder", prompt: "q", cwd: "/tmp/cwd" },
      { spawn: fakeSpawnCapturing(calls), resolveInvocation: (args) => ({ command: "pi", args }) },
    );
    assert.equal(calls.length, 1);
    const env = calls[0].options?.env;
    // The runner always passes a scrubbed copy of process.env so a nested
    // worker never inherits a stale override var. With no override, the var
    // must be absent (scrubbed), while the rest of the env is preserved.
    assert.ok(env, "runner passes a child env (scrubbed copy of process.env)");
    assert.equal(env[MMR_SUBAGENT_MODEL_PREFERENCES_ENV], undefined);
    assert.equal(env.PATH, process.env.PATH);
  });

  it("scrubs a stale inherited override var so nested worker spawns do not leak it", async () => {
    // Simulates a fallback-spawned Task child (its process.env already
    // carries the override) that then spawns a nested worker (e.g. finder)
    // with no override of its own: the nested child must NOT inherit it.
    const { runMmrSubagentWorker } = await importSource(RUNNER_MODULE);
    const { MMR_SUBAGENT_MODEL_PREFERENCES_ENV } = await importSource(ENV_MODULE);
    const original = process.env[MMR_SUBAGENT_MODEL_PREFERENCES_ENV];
    process.env[MMR_SUBAGENT_MODEL_PREFERENCES_ENV] = JSON.stringify([{ model: "stale-route" }]);
    const calls = [];
    try {
      await runMmrSubagentWorker(
        { profileName: "finder", prompt: "q", cwd: "/tmp/cwd" },
        { spawn: fakeSpawnCapturing(calls), resolveInvocation: (args) => ({ command: "pi", args }) },
      );
    } finally {
      if (original === undefined) delete process.env[MMR_SUBAGENT_MODEL_PREFERENCES_ENV];
      else process.env[MMR_SUBAGENT_MODEL_PREFERENCES_ENV] = original;
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options?.env?.[MMR_SUBAGENT_MODEL_PREFERENCES_ENV], undefined, "stale override var must be scrubbed from the child env");
  });
});
