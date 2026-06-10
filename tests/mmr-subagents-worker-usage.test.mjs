import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

const USAGE_MODULE = "extensions/mmr-subagents/worker-usage.ts";
const RUNNER_MODULE = "extensions/mmr-subagents/runner.ts";

after(cleanupLoadedSource);

describe("mmr-subagents worker-usage", () => {
  it("starts from an all-zero usage shape", async () => {
    const { emptyMmrWorkerUsageStats } = await importSource(USAGE_MODULE);

    assert.deepEqual(emptyMmrWorkerUsageStats(), {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    });
    // Fresh object per call: accumulating into one run never leaks into another.
    const a = emptyMmrWorkerUsageStats();
    const b = emptyMmrWorkerUsageStats();
    a.turns = 5;
    assert.equal(b.turns, 0);
  });

  it("reads strings tolerantly from untrusted stream values", async () => {
    const { readString } = await importSource(USAGE_MODULE);

    assert.equal(readString("model-x"), "model-x");
    assert.equal(readString(""), "");
    assert.equal(readString(42), undefined);
    assert.equal(readString(null), undefined);
    assert.equal(readString({ value: "nope" }), undefined);
  });

  it("accumulates assistant-message usage and ignores everything else", async () => {
    const { collectUsage, emptyMmrWorkerUsageStats } = await importSource(USAGE_MODULE);
    const usage = emptyMmrWorkerUsageStats();

    collectUsage({ role: "toolResult", usage: { input: 99 } }, usage);
    assert.deepEqual(usage, emptyMmrWorkerUsageStats());

    collectUsage(
      {
        role: "assistant",
        usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, totalTokens: 20, cost: { total: 0.5 } },
      },
      usage,
    );
    collectUsage(
      {
        role: "assistant",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } },
      },
      usage,
    );
    assert.deepEqual(usage, {
      input: 11,
      output: 6,
      cacheRead: 3,
      cacheWrite: 2,
      cost: 0.75,
      // The second message reported no totalTokens, so the last good value sticks.
      contextTokens: 20,
      turns: 2,
    });

    // An assistant message without a usage record still counts as a turn.
    collectUsage({ role: "assistant" }, usage);
    assert.equal(usage.turns, 3);
    assert.equal(usage.input, 11);

    // Non-finite/malformed numbers read as 0 instead of corrupting the stats.
    collectUsage({ role: "assistant", usage: { input: Number.NaN, output: "9", cost: { total: Infinity } } }, usage);
    assert.equal(usage.input, 11);
    assert.equal(usage.output, 6);
    assert.equal(usage.cost, 0.75);
  });

  it("keeps emptyMmrWorkerUsageStats resolving through the runner entry file", async () => {
    const usage = await importSource(USAGE_MODULE);
    const runner = await importSource(RUNNER_MODULE);

    assert.equal(typeof runner.emptyMmrWorkerUsageStats, "function");
    assert.deepEqual(runner.emptyMmrWorkerUsageStats(), usage.emptyMmrWorkerUsageStats());
  });
});
