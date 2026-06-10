import { isRecord } from "../mmr-core/internal/json.js";
import type { MmrWorkerMessage, MmrWorkerUsageStats } from "./runner.js";

/**
 * Pure usage-stats helpers for subagent workers: the zeroed
 * `MmrWorkerUsageStats` shape, tolerant scalar readers for untrusted worker
 * stream values, and per-assistant-message usage accumulation. No worker or
 * stream state lives here; `runner.ts` re-exports the public surface.
 *
 * This module is a leaf at runtime: the `import type` references back to
 * `./runner.js` are erased and create no runtime cycle.
 */

/** Zeroed usage-stats accumulator for a fresh worker run. */
export function emptyMmrWorkerUsageStats(): MmrWorkerUsageStats {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  };
}

/** Tolerant numeric reader for untrusted worker-stream values; non-finite reads as 0. */
function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Tolerant string reader for untrusted worker-stream values. */
export function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Accumulate one assistant message of worker usage into the running stats. */
export function collectUsage(message: MmrWorkerMessage, usage: MmrWorkerUsageStats): void {
  if (message.role !== "assistant") return;
  usage.turns += 1;
  if (!isRecord(message.usage)) return;
  usage.input += readNumber(message.usage.input);
  usage.output += readNumber(message.usage.output);
  usage.cacheRead += readNumber(message.usage.cacheRead);
  usage.cacheWrite += readNumber(message.usage.cacheWrite);
  usage.contextTokens = readNumber(message.usage.totalTokens) || usage.contextTokens;
  const cost = message.usage.cost;
  if (isRecord(cost)) usage.cost += readNumber(cost.total);
}
