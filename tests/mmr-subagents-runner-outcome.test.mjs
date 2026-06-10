import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

const OUTCOME_MODULE = "extensions/mmr-subagents/runner-outcome.ts";
const RUNNER_MODULE = "extensions/mmr-subagents/runner.ts";

after(cleanupLoadedSource);

/** Minimal classifiable result shape: clean exit, agent ran, no output. */
function makeResult(overrides = {}) {
  return {
    spawnError: undefined,
    subagentActivationError: undefined,
    aborted: false,
    signal: null,
    exitCode: 0,
    finalOutput: "",
    truncatedFinalOutput: "",
    outputTruncated: false,
    agentStarted: true,
    ...overrides,
  };
}

const FAIL_ON_NONZERO = { partialOutputPolicy: "fail-on-nonzero" };
const PREFER_USABLE = { partialOutputPolicy: "prefer-usable-output" };

describe("mmr-subagents runner-outcome", () => {
  it("treats truncated output as the usable-final-text source", async () => {
    const { hasUsableMmrWorkerFinalOutput } = await importSource(OUTCOME_MODULE);

    assert.equal(hasUsableMmrWorkerFinalOutput(makeResult({ finalOutput: "answer" })), true);
    assert.equal(
      hasUsableMmrWorkerFinalOutput(makeResult({ finalOutput: "", truncatedFinalOutput: "partial" })),
      true,
    );
    assert.equal(hasUsableMmrWorkerFinalOutput(makeResult({ finalOutput: "   \n" })), false);
    assert.equal(hasUsableMmrWorkerFinalOutput(makeResult()), false);
  });

  it("classifies outcomes by the documented precedence ladder", async () => {
    const { classifyMmrWorkerOutcome } = await importSource(OUTCOME_MODULE);

    assert.equal(
      classifyMmrWorkerOutcome(makeResult({ spawnError: "spawn ENOENT", aborted: true }), FAIL_ON_NONZERO),
      "spawn-error",
    );
    assert.equal(
      classifyMmrWorkerOutcome(makeResult({ subagentActivationError: "unknown profile", aborted: true }), FAIL_ON_NONZERO),
      "activation-error",
    );
    assert.equal(classifyMmrWorkerOutcome(makeResult({ aborted: true, finalOutput: "x" }), FAIL_ON_NONZERO), "aborted");
    assert.equal(classifyMmrWorkerOutcome(makeResult({ signal: "SIGKILL" }), FAIL_ON_NONZERO), "worker-error");
    assert.equal(
      classifyMmrWorkerOutcome(makeResult({ signal: "SIGTERM", finalOutput: "kept" }), PREFER_USABLE),
      "success",
    );
    assert.equal(classifyMmrWorkerOutcome(makeResult({ finalOutput: "done" }), FAIL_ON_NONZERO), "success");
    assert.equal(classifyMmrWorkerOutcome(makeResult({ agentStarted: false }), FAIL_ON_NONZERO), "no-agent-start");
    assert.equal(classifyMmrWorkerOutcome(makeResult(), FAIL_ON_NONZERO), "empty-output");
    // Backward compatibility: omitted agentStarted defaults to "started".
    const legacy = makeResult();
    delete legacy.agentStarted;
    assert.equal(classifyMmrWorkerOutcome(legacy, FAIL_ON_NONZERO), "empty-output");
  });

  it("applies the partial-output policy to nonzero exits", async () => {
    const { classifyMmrWorkerOutcome } = await importSource(OUTCOME_MODULE);

    const nonzeroWithOutput = makeResult({ exitCode: 1, finalOutput: "partial answer" });
    assert.equal(classifyMmrWorkerOutcome(nonzeroWithOutput, FAIL_ON_NONZERO), "worker-error");
    assert.equal(classifyMmrWorkerOutcome(nonzeroWithOutput, PREFER_USABLE), "success");
    assert.equal(classifyMmrWorkerOutcome(makeResult({ exitCode: 1 }), PREFER_USABLE), "worker-error");
  });

  it("projects worker results onto async terminal outcomes", async () => {
    const { deriveAsyncTerminalOutcome } = await importSource(OUTCOME_MODULE);

    assert.equal(deriveAsyncTerminalOutcome(makeResult({ aborted: true }), FAIL_ON_NONZERO), undefined);
    assert.equal(deriveAsyncTerminalOutcome(makeResult({ exitCode: 1 }), FAIL_ON_NONZERO), "failed");
    assert.equal(deriveAsyncTerminalOutcome(makeResult({ finalOutput: "ok" }), FAIL_ON_NONZERO), "success");
    assert.equal(
      deriveAsyncTerminalOutcome(makeResult({ finalOutput: "ok", outputTruncated: true }), FAIL_ON_NONZERO),
      "partial",
    );
  });

  it("extracts the latest assistant text as final output", async () => {
    const { getMmrWorkerFinalOutput } = await importSource(OUTCOME_MODULE);

    const messages = [
      { role: "assistant", content: [{ type: "text", text: "first" }] },
      { role: "toolResult", content: [{ type: "text", text: "tool noise" }] },
      { role: "assistant", content: [{ type: "text", text: "final answer" }] },
    ];
    assert.equal(getMmrWorkerFinalOutput(messages), "final answer");
    assert.equal(getMmrWorkerFinalOutput([{ role: "assistant", content: "not-an-array" }]), "");
    assert.equal(getMmrWorkerFinalOutput([]), "");
  });

  it("truncates output on a byte budget without splitting code points", async () => {
    const { truncateMmrWorkerOutput, DEFAULT_MMR_WORKER_OUTPUT_BYTE_LIMIT } = await importSource(OUTCOME_MODULE);

    assert.equal(DEFAULT_MMR_WORKER_OUTPUT_BYTE_LIMIT, 50 * 1024);
    assert.deepEqual(truncateMmrWorkerOutput("short", 100), { text: "short", truncated: false });

    const over = truncateMmrWorkerOutput("a".repeat(64), 16);
    assert.equal(over.truncated, true);
    assert.ok(over.text.startsWith("a".repeat(16)));
    assert.match(over.text, /\[Output truncated: 48 bytes omitted\./);

    // 4-byte emoji straddling the limit must be dropped, not split.
    const emoji = truncateMmrWorkerOutput("ab\u{1F600}", 3);
    assert.ok(emoji.text.startsWith("ab"), "multi-byte code point must not be split");
    assert.equal(emoji.truncated, true);
  });

  it("retries restricted children only for missing-extension signatures", async () => {
    const { shouldRetryMmrChildWithFullDiscovery } = await importSource(OUTCOME_MODULE);
    const scope = ["/abs/ext/index.ts"];

    assert.equal(shouldRetryMmrChildWithFullDiscovery(makeResult({ exitCode: 1, agentStarted: false }), undefined), false);
    assert.equal(shouldRetryMmrChildWithFullDiscovery(makeResult({ exitCode: 1, agentStarted: false }), []), false);
    assert.equal(shouldRetryMmrChildWithFullDiscovery(makeResult({ aborted: true }), scope), false);
    assert.equal(shouldRetryMmrChildWithFullDiscovery(makeResult({ spawnError: "spawn E2BIG" }), scope), false);
    assert.equal(shouldRetryMmrChildWithFullDiscovery(makeResult({ subagentActivationError: "tools.mismatch" }), scope), true);
    assert.equal(shouldRetryMmrChildWithFullDiscovery(makeResult({ exitCode: 1, agentStarted: false }), scope), true);
    assert.equal(
      shouldRetryMmrChildWithFullDiscovery(makeResult({ exitCode: 1, agentStarted: false, finalOutput: "usable" }), scope),
      false,
    );
    assert.equal(shouldRetryMmrChildWithFullDiscovery(makeResult(), scope), false);
  });

  it("keeps resolving identically through the runner entry file", async () => {
    const outcome = await importSource(OUTCOME_MODULE);
    const runner = await importSource(RUNNER_MODULE);

    // `importSource` cache-busts per call, so compare values/behavior rather
    // than function reference identity.
    assert.equal(runner.DEFAULT_MMR_WORKER_OUTPUT_BYTE_LIMIT, outcome.DEFAULT_MMR_WORKER_OUTPUT_BYTE_LIMIT);
    for (const name of [
      "classifyMmrWorkerOutcome",
      "deriveAsyncTerminalOutcome",
      "getMmrWorkerFinalOutput",
      "hasUsableMmrWorkerFinalOutput",
      "shouldRetryMmrChildWithFullDiscovery",
      "truncateMmrWorkerOutput",
    ]) {
      assert.equal(typeof runner[name], "function", `${name} must keep resolving from runner.ts`);
    }
    assert.equal(
      runner.classifyMmrWorkerOutcome(makeResult({ exitCode: 1, finalOutput: "x" }), PREFER_USABLE),
      "success",
    );
  });
});
