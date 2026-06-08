/**
 * Shared formatters for the worker-metadata footer rendered by both
 * `mmr-subagents` progress rendering (finder / oracle / Task) and the
 * `mmr-history` history-reader-backed read tools.
 *
 * Kept narrow on purpose: this module owns just the usage / model
 * string formatting so the two extensions agree on token / cost /
 * model-name presentation without depending on `mmr-history` types
 * from `mmr-subagents` or vice versa. The Pi-TUI Container assembly
 * stays in each extension's own progress-rendering module.
 */
import { formatMmrCompactTokens } from "../mmr-core/token-format.js";
import type { MmrWorkerUsageStats } from "./runner.js";

/** Strip a leading `provider/` from a worker model id so the footer shows a short name. */
export function stripMmrWorkerModelProvider(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const trimmed = model.trim();
  if (!trimmed) return undefined;
  return trimmed.split("/").filter(Boolean).pop() ?? trimmed;
}

/**
 * Format a non-negative token count for the worker metadata footer. Routes
 * through mmr-core's shared compact formatter so this and the /mmr-status
 * footer stay byte-for-byte identical (see mmr-core/token-format.ts).
 */
export function formatMmrWorkerTokens(count: number): string {
  return formatMmrCompactTokens(count);
}

/**
 * Format the worker metadata footer for a subagent or history-reader
 * run. Returns `undefined` when there is nothing meaningful to show
 * (no usage and no model), so callers can simply skip rendering the
 * footer row.
 *
 * The model argument should already be stripped to a bare model name
 * (see {@link stripMmrWorkerModelProvider}); callers that hold the
 * raw `provider/model` should strip it before forwarding.
 */
export function formatMmrWorkerUsage(
  usage: MmrWorkerUsageStats | undefined,
  model: string | undefined,
): string | undefined {
  if (!usage) return model;
  const parts: string[] = [];
  if (usage.turns > 0) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
  if (usage.input > 0) parts.push(`↑${formatMmrWorkerTokens(usage.input)}`);
  if (usage.output > 0) parts.push(`↓${formatMmrWorkerTokens(usage.output)}`);
  if (usage.cacheRead > 0) parts.push(`R${formatMmrWorkerTokens(usage.cacheRead)}`);
  if (usage.cacheWrite > 0) parts.push(`W${formatMmrWorkerTokens(usage.cacheWrite)}`);
  if (usage.cost > 0) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens > 0) parts.push(`ctx:${formatMmrWorkerTokens(usage.contextTokens)}`);
  if (model) parts.push(model);
  return parts.length > 0 ? parts.join(" ") : undefined;
}
