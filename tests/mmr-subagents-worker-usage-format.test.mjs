import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

// Boundary-value parity pins for the worker-metadata compact token formatter.
// These outputs are byte-for-byte frozen so the Item 5b shared-helper
// refactor (routing through mmr-core/token-format.ts) cannot change them.
const WORKER_TOKEN_CASES = [
  [999, "999"],
  [1000, "1.0k"],
  [1500, "1.5k"],
  [12345, "12k"],
  [999999, "1000k"],
  [1000000, "1.0M"],
  [1500000, "1.5M"],
  [9999999, "10.0M"],
  [10000000, "10.0M"],
];

describe("mmr-subagents worker usage formatting", () => {
  it("formats compact worker token counts byte-for-byte across boundary values", async () => {
    const { formatMmrWorkerTokens } = await importSource("extensions/mmr-subagents/worker-usage-format.ts");
    for (const [input, expected] of WORKER_TOKEN_CASES) {
      assert.equal(formatMmrWorkerTokens(input), expected, `formatMmrWorkerTokens(${input})`);
    }
  });
});
