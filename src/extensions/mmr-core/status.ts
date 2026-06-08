import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMmrPolicyDiagnostics } from "./diagnostics.js";
import { formatMmrCompactTokens } from "./token-format.js";
import {
  MMR_REQUEST_POLICIES,
  applyMmrThinkingLevelToPolicy,
  formatMmrPolicyContext,
  formatMmrPolicyThinking,
  isToggleableMmrMode,
  providerOmitsMaxOutputTokens,
  type MmrToggleThinkingLevel,
} from "./request-policy.js";
import type {
  MmrModeEvent,
  MmrModelCandidateResolution,
  MmrModeState,
  MmrPolicyDiagnostic,
  MmrPolicyDiagnosticSeverity,
  MmrToolResolution,
} from "./types.js";

type LockedMmrModeKey = Exclude<MmrModeState["mode"], "free">;

function getRequestPolicyForState(state: MmrModeState) {
  if (state.mode === "free") return undefined;
  const policy = MMR_REQUEST_POLICIES[state.mode as LockedMmrModeKey];
  // Toggleable modes carry a runtime thinking level that the static policy
  // does not encode. Derive the displayed policy from the applied level so
  // the Thinking/Context lines reflect the current toggle (including Smart's
  // larger high-thinking output budget) rather than the medium default.
  if (isToggleableMmrMode(state.mode) && isMmrToggleThinkingLevel(state.thinkingLevel)) {
    return applyMmrThinkingLevelToPolicy(state.mode, policy, state.thinkingLevel);
  }
  return policy;
}

function isMmrToggleThinkingLevel(value: string | undefined): value is MmrToggleThinkingLevel {
  return value === "medium" || value === "high" || value === "xhigh";
}

function getContextOverridesForState(state: MmrModeState) {
  // For providers whose wire payload does not accept `max_output_tokens`
  // (e.g. openai-codex), explicitly omit the value from display so /mmr-status
  // and the footer status do not advertise a number that is never sent.
  const maxOutputTokens = providerOmitsMaxOutputTokens(state.provider) ? null : state.effectiveMaxOutputTokens;
  return {
    contextWindow: state.effectiveContextWindow,
    maxOutputTokens,
    effectiveMaxInputTokens: state.effectiveMaxInputTokens,
  };
}

export interface FormatMmrStatusOptions {
  /** Append a Debug section with mode-resolution detail. */
  debug?: boolean;
  /**
   * Oldest-to-newest mode/fallback event history. Rendered inside the Debug
   * section when `debug` is set. Deterministic operator aid only — records
   * explicit applies and provider-failure fallbacks, not automatic routing.
   */
  modeHistory?: readonly MmrModeEvent[];
}

function formatSelectedModel(state: MmrModeState): string {
  return state.modelApplied ? `${state.provider}/${state.model}` : "none";
}

function formatPolicyWarnings(state: MmrModeState): string {
  const diagnostics = getMmrPolicyDiagnostics(state);
  if (diagnostics.length === 0) return "none";
  return diagnostics.map((diag) => diag.message).join("; ");
}

function formatBaseline(state: MmrModeState): string {
  if (!state.baselineCaptured) return "no";
  return state.baselineModel ? `yes (${state.baselineModel})` : "yes (model unknown)";
}

function formatMmrContextCap(effectiveMaxInputTokens: number | undefined, mode: string): string {
  if (mode === "free") return "none";
  if (typeof effectiveMaxInputTokens === "number" && Number.isFinite(effectiveMaxInputTokens) && effectiveMaxInputTokens > 0) {
    return `${effectiveMaxInputTokens} input tokens (mode profile)`;
  }
  return "model default";
}

const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

function visibleWidth(value: string): number {
  return value.replace(ANSI_PATTERN, "").length;
}

function truncateToWidth(value: string, width: number, ellipsis = "..."): string {
  if (width <= 0) return "";
  if (visibleWidth(value) <= width) return value;
  const plain = value.replace(ANSI_PATTERN, "");
  const suffix = visibleWidth(ellipsis) < width ? ellipsis : "";
  return `${plain.slice(0, Math.max(0, width - visibleWidth(suffix)))}${suffix}`;
}

function sanitizeFooterText(value: string): string {
  return value.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

// Exported as a narrow test seam so boundary-value parity tests can pin the
// footer format byte-for-byte; not re-exported from the package root.
export function formatFooterTokens(count: number): string {
  // The >=10M tier (rounded whole `M`) is unique to the footer to save width;
  // the lower tiers share mmr-core's compact formatter so the footer and the
  // worker-metadata footer (formatMmrWorkerTokens) stay byte-for-byte aligned.
  if (count < 10_000_000) return formatMmrCompactTokens(count);
  return `${Math.round(count / 1_000_000)}M`;
}

/**
 * Structural shape of the optional Pi `SessionManager` surfaces mmr-core's
 * footer reads. Declared once here so each call site shares the same view
 * and a Pi-side rename surfaces as a single typecheck failure rather than a
 * per-call-site silent no-op.
 */
interface MmrSessionManagerHost {
  getEntries?: () => unknown[];
  getBranch?: () => unknown[];
  getCwd?: () => string;
  getSessionName?: () => string | undefined;
}

function asSessionManagerHost(ctx: ExtensionContext): MmrSessionManagerHost {
  return ctx.sessionManager as unknown as MmrSessionManagerHost;
}

function getSessionEntries(ctx: ExtensionContext): unknown[] {
  const sessionManager = asSessionManagerHost(ctx);
  return sessionManager.getEntries?.() ?? sessionManager.getBranch?.() ?? [];
}

interface MmrAssistantUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

/**
 * Single type guard that extracts the assistant-message usage shape from a
 * raw Pi session entry. Returns undefined for any entry that is not an
 * assistant message with a usage block, replacing what was a chain of
 * `as Record<string, unknown>` casts at the read site.
 */
function readAssistantUsage(entry: unknown): MmrAssistantUsage | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const record = entry as Record<string, unknown>;
  if (record.type !== "message") return undefined;
  const message = record.message;
  if (typeof message !== "object" || message === null) return undefined;
  const msg = message as Record<string, unknown>;
  if (msg.role !== "assistant") return undefined;
  const usage = msg.usage;
  if (typeof usage !== "object" || usage === null) return undefined;
  const u = usage as Record<string, unknown>;
  const costRecord = typeof u.cost === "object" && u.cost !== null
    ? u.cost as Record<string, unknown>
    : undefined;
  return {
    input: typeof u.input === "number" ? u.input : 0,
    output: typeof u.output === "number" ? u.output : 0,
    cacheRead: typeof u.cacheRead === "number" ? u.cacheRead : 0,
    cacheWrite: typeof u.cacheWrite === "number" ? u.cacheWrite : 0,
    cost: costRecord && typeof costRecord.total === "number" ? costRecord.total : 0,
  };
}

function getFooterCwd(ctx: ExtensionContext): string {
  let cwd = asSessionManagerHost(ctx).getCwd?.() ?? ctx.cwd;
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home && cwd.startsWith(home)) cwd = `~${cwd.slice(home.length)}`;
  return cwd;
}

function getFooterSessionName(ctx: ExtensionContext): string | undefined {
  return asSessionManagerHost(ctx).getSessionName?.();
}

function formatContextUsage(ctx: ExtensionContext, state: MmrModeState, theme: ExtensionContext["ui"]["theme"]): string {
  const usage = ctx.getContextUsage?.();
  const model = ctx.modelRegistry.find(state.provider, state.model) ?? ctx.model;
  const modelContextWindow = model && typeof model.contextWindow === "number" && Number.isFinite(model.contextWindow)
    ? model.contextWindow
    : undefined;
  const contextWindow = state.effectiveContextWindow ?? usage?.contextWindow ?? modelContextWindow ?? state.effectiveMaxInputTokens ?? 0;
  const tokens = usage?.tokens ?? null;
  const percentValue = tokens === null || contextWindow <= 0
    ? null
    : usage?.contextWindow === contextWindow && typeof usage.percent === "number"
      ? usage.percent
      : (tokens / contextWindow) * 100;
  const percent = percentValue === null ? "?" : percentValue.toFixed(1);
  const display = `${percent}%/${formatFooterTokens(contextWindow)} (auto)`;
  if (percentValue !== null && percentValue > 90) return theme.fg("error", display);
  if (percentValue !== null && percentValue > 70) return theme.fg("warning", display);
  return display;
}

function modelUsesSubscription(ctx: ExtensionContext, state: MmrModeState): boolean {
  const model = ctx.modelRegistry.find(state.provider, state.model) ?? ctx.model;
  return model ? ctx.modelRegistry.isUsingOAuth(model) : false;
}

function formatFooterModelName(modelId: string): string {
  const claude = /^claude-(opus|sonnet|haiku)-(\d+)-(\d+)(?:-.+)?$/.exec(modelId);
  if (claude) return `${claude[1]}-${claude[2]}.${claude[3]}`;
  return modelId;
}

function installMmrFooter(ctx: ExtensionContext, state: MmrModeState): void {
  ctx.ui.setFooter?.((tui, theme, footerData) => {
    const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
    // Per-footer-installation memo for assistant-usage totals. Every TUI
    // redraw (branch change, terminal resize, idle tick) triggers render(),
    // and the previous implementation re-walked the entire session entry
    // list on each call. Memoize keyed on (entry-list length, last entry
    // identity) so totals only recompute when the list actually grows or
    // its tail changes — typical idle redraws become O(1). When the cache
    // stays cold (zero entries) the comparison still costs an array length
    // read, which is fine. Cache lives in this closure and is discarded
    // when updateMmrStatus reinstalls the footer on the next mode apply.
    let cachedTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    let cachedLength = -1;
    let cachedLastEntry: unknown = undefined;
    return {
      dispose: unsubscribe,
      invalidate() {},
      render(width: number): string[] {
        const entries = getSessionEntries(ctx);
        const lastEntry = entries.length > 0 ? entries[entries.length - 1] : undefined;
        if (entries.length !== cachedLength || lastEntry !== cachedLastEntry) {
          let totalInput = 0;
          let totalOutput = 0;
          let totalCacheRead = 0;
          let totalCacheWrite = 0;
          let totalCost = 0;
          for (const entry of entries) {
            const usage = readAssistantUsage(entry);
            if (!usage) continue;
            totalInput += usage.input;
            totalOutput += usage.output;
            totalCacheRead += usage.cacheRead;
            totalCacheWrite += usage.cacheWrite;
            totalCost += usage.cost;
          }
          cachedTotals = { input: totalInput, output: totalOutput, cacheRead: totalCacheRead, cacheWrite: totalCacheWrite, cost: totalCost };
          cachedLength = entries.length;
          cachedLastEntry = lastEntry;
        }
        const totalInput = cachedTotals.input;
        const totalOutput = cachedTotals.output;
        const totalCacheRead = cachedTotals.cacheRead;
        const totalCacheWrite = cachedTotals.cacheWrite;
        const totalCost = cachedTotals.cost;

        let pwd = getFooterCwd(ctx);
        const branch = footerData.getGitBranch();
        if (branch) pwd = `${pwd} (${branch})`;
        const sessionName = getFooterSessionName(ctx);
        if (sessionName) pwd = `${pwd} • ${sanitizeFooterText(sessionName)}`;

        const statsParts: string[] = [];
        if (totalInput) statsParts.push(`↑${formatFooterTokens(totalInput)}`);
        if (totalOutput) statsParts.push(`↓${formatFooterTokens(totalOutput)}`);
        if (totalCacheRead) statsParts.push(`R${formatFooterTokens(totalCacheRead)}`);
        if (totalCacheWrite) statsParts.push(`W${formatFooterTokens(totalCacheWrite)}`);
        const usingSubscription = modelUsesSubscription(ctx, state);
        if (totalCost || usingSubscription) statsParts.push(`$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
        statsParts.push(formatContextUsage(ctx, state, theme));

        let left = statsParts.join(" ");
        if (visibleWidth(left) > width) left = truncateToWidth(left, width, "...");
        const right = sanitizeFooterText(`${formatFooterModelName(state.model || "no-model")} • ${state.mode}`);
        const leftWidth = visibleWidth(left);
        const rightWidth = visibleWidth(right);
        const minPadding = 2;
        let statsLine: string;
        if (leftWidth + minPadding + rightWidth <= width) {
          statsLine = `${left}${" ".repeat(width - leftWidth - rightWidth)}${right}`;
        } else {
          const availableRight = width - leftWidth - minPadding;
          if (availableRight > 0) {
            const truncatedRight = truncateToWidth(right, availableRight, "");
            statsLine = `${left}${" ".repeat(Math.max(0, width - leftWidth - visibleWidth(truncatedRight)))}${truncatedRight}`;
          } else {
            statsLine = left;
          }
        }

        return [
          truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "...")),
          theme.fg("dim", statsLine),
        ];
      },
    };
  });
}


export function updateMmrStatus(ctx: ExtensionContext, state: MmrModeState | undefined): void {
  if (!state) {
    ctx.ui.setStatus("mmr-mode", undefined);
    ctx.ui.setFooter?.(undefined);
    return;
  }

  if (state.mode === "free") {
    ctx.ui.setStatus("mmr-mode", undefined);
    ctx.ui.setFooter?.(undefined);
    return;
  }

  ctx.ui.setStatus("mmr-mode", undefined);
  installMmrFooter(ctx, state);
}


function formatRejectedSources(state: MmrModeState): string {
  const rejected = state.resolution.rejectedSources;
  if (rejected.length === 0) return "Rejected sources: none";
  // JSON.stringify the value so embedded quotes / control chars do not produce
  // malformed status output. Source and reason are MMR-controlled identifiers,
  // so they stay un-quoted.
  const items = rejected.map((entry) => `${entry.source}=${JSON.stringify(entry.value)} (${entry.reason})`);
  return `Rejected sources: ${items.join("; ")}`;
}

function formatSettingsFilesRead(state: MmrModeState): string {
  const files = state.settingsFilesRead ?? [];
  if (files.length === 0) return "Settings files read: none";
  return `Settings files read: ${files.join(", ")}`;
}

function formatSettingsWarnings(state: MmrModeState): string | undefined {
  const warnings = state.settingsWarnings ?? [];
  if (warnings.length === 0) return undefined;
  const lines = warnings.map((message) => `  - ${message}`);
  return ["Settings warnings:", ...lines].join("\n");
}

const DIAGNOSTIC_SEVERITY_ORDER: readonly MmrPolicyDiagnosticSeverity[] = ["warning", "info"];

function formatDiagnosticsBySeverity(state: MmrModeState): string | undefined {
  const diagnostics = getMmrPolicyDiagnostics(state);
  if (diagnostics.length === 0) return undefined;

  const grouped = new Map<MmrPolicyDiagnosticSeverity, MmrPolicyDiagnostic[]>();
  for (const diag of diagnostics) {
    const bucket = grouped.get(diag.severity) ?? [];
    bucket.push(diag);
    grouped.set(diag.severity, bucket);
  }

  const sections: string[] = ["Diagnostics by severity:"];
  for (const severity of DIAGNOSTIC_SEVERITY_ORDER) {
    const bucket = grouped.get(severity);
    if (!bucket || bucket.length === 0) continue;
    sections.push(`  ${severity}:`);
    for (const diag of bucket) sections.push(`    - ${diag.message}`);
  }
  return sections.join("\n");
}

function formatModelCandidate(candidate: MmrModelCandidateResolution): string {
  const route = `${candidate.provider}/${candidate.model}`;
  const flags: string[] = [];
  flags.push(`registered=${candidate.registered ? "yes" : "no"}`);
  flags.push(`authenticated=${candidate.authenticated ? "yes" : "no"}`);
  if (candidate.subscription) flags.push("subscription");
  if (candidate.attempted) flags.push("attempted");
  flags.push(candidate.applied ? "applied" : "not-applied");
  if (candidate.thinkingLevel) flags.push(`thinking=${candidate.thinkingLevel}`);
  const reason = candidate.reason ? ` — ${candidate.reason}` : "";
  return `  - ${candidate.requestedModel} -> ${route} [${flags.join(", ")}]${reason}`;
}

function formatModeEvent(event: MmrModeEvent): string {
  const transition = event.previousMode && event.previousMode !== event.mode
    ? `${event.previousMode} → ${event.mode}`
    : event.mode;
  const model = event.model ?? "none";
  const thinking = event.thinkingLevel ? ` thinking:${event.thinkingLevel}` : "";
  const fallback = event.fallbackApplied
    ? ` fallback:yes - ${event.fallbackReason ?? "fallback model applied"}`
    : "";
  return `  - ${event.at} ${transition} (source: ${event.source}) model:${model}${thinking}${fallback}`;
}

function formatModeHistory(history: readonly MmrModeEvent[] | undefined): string | undefined {
  if (!history || history.length === 0) return undefined;
  // Newest first for quick scanning.
  const lines = [...history].reverse().map((event) => formatModeEvent(event));
  return ["  Mode/fallback history (newest first):", ...lines].join("\n");
}

function formatDebugSection(state: MmrModeState, options: FormatMmrStatusOptions = {}): string {
  const lines: string[] = ["Debug:"];
  lines.push(`  Selected source: ${state.source}`);
  lines.push(`  ${formatRejectedSources(state)}`);
  if (state.modelCandidates.length === 0) {
    lines.push("  Model preference candidates: none");
  } else {
    lines.push("  Model preference candidates:");
    for (const candidate of state.modelCandidates) lines.push(`  ${formatModelCandidate(candidate)}`);
  }
  const history = formatModeHistory(options.modeHistory);
  if (history) lines.push(history);
  return lines.join("\n");
}

function joinLines(lines: ReadonlyArray<string | undefined>): string {
  return lines.filter((line): line is string => typeof line === "string" && line.length > 0).join("\n");
}

function decisionTarget(decision: MmrToolResolution["decisions"][number]): string {
  if (decision.chosenTools.length > 0) return decision.chosenTools.join(" + ");
  if (decision.chosen) return decision.chosen;
  return decision.status;
}

function formatToolDecisions(decisions: MmrToolResolution["decisions"]): string {
  if (decisions.length === 0) return "Tool resolution: none";
  const lines = decisions.map((decision) => {
    const target = decisionTarget(decision);
    const owner = decision.owner ? ` via ${decision.owner}` : "";
    const diagnostic = decision.diagnostic ? `\n      ${decision.diagnostic}` : "";
    const candidateList = decision.candidates.length > 0
      ? ` [candidates: ${decision.candidates.join(", ")}]`
      : "";
    return `  - ${decision.requested} -> ${target} (${decision.status})${owner}${candidateList}${diagnostic}`;
  });
  return ["Tool resolution:", ...lines].join("\n");
}

function formatFeatureGates(state: MmrModeState): string {
  const decisions = state.resolution.featureGateDecisions;
  if (decisions.length === 0) return "Feature gates: none";
  const lines = decisions.map((decision) => `  - ${decision.gate}: ${decision.status} via ${decision.source} (${decision.reason})`);
  return ["Feature gates:", ...lines].join("\n");
}

export function formatMmrStatus(state: MmrModeState | undefined, options: FormatMmrStatusOptions = {}): string {
  if (!state) return "MMR mode has not been resolved yet.";

  if (state.mode === "free") {
    return joinLines([
      "Mode: Free (free)",
      `Selected source: ${state.source}`,
      formatRejectedSources(state),
      "Mode control: native Pi controls",
      "Prompt surface: Pi standard prompt (MMR disabled)",
      "Tool allowlist: disabled",
      "Context cap: none",
      `Baseline captured: ${formatBaseline(state)}`,
      `Active tools: ${state.activeTools.join(", ") || "none"}`,
      formatSettingsFilesRead(state),
      formatSettingsWarnings(state),
      `Policy warnings: ${formatPolicyWarnings(state)}`,
      `State version: ${state.version}`,
      `Applied at: ${state.appliedAt}`,
      options.debug ? formatDebugSection(state, options) : undefined,
    ]);
  }

  return joinLines([
    `Mode: ${state.displayName} (${state.mode})`,
    `Selected source: ${state.source}`,
    formatRejectedSources(state),
    `Model preference order: ${state.requestedModels.join(" → ") || state.targetModel || "none"}`,
    `Resolved model: ${formatSelectedModel(state)}`,
    `Resolved model available: ${state.modelFound ? "yes" : "no"}`,
    `Model applied: ${state.modelApplied ? "yes" : "no"}`,
    `Configured fallback: ${state.resolution.modelDecision.fallbackApplied ? `yes - ${state.resolution.modelDecision.reason ?? "fallback model applied"}` : "no"}`,
    `Thinking: ${state.thinkingLevel ?? "Pi default"} (request policy: ${formatMmrPolicyThinking(getRequestPolicyForState(state))})`,
    `Context: ${formatMmrPolicyContext(getRequestPolicyForState(state), getContextOverridesForState(state))}`,
    `Context cap: ${formatMmrContextCap(state.effectiveMaxInputTokens, state.mode)}`,
    `Baseline captured: ${formatBaseline(state)}`,
    `Prompt surface: ${state.promptRoute}`,
    `Active tools: ${state.activeTools.join(", ") || "none"}`,
    `Missing tools: ${state.missingTools.join(", ") || "none"}`,
    `Deferred tools: ${state.deferredTools.join(", ") || "none"}`,
    `Gated tools: ${state.gatedTools.join(", ") || "none"}`,
    `Disabled tools: ${state.disabledTools.join(", ") || "none"}`,
    formatToolDecisions(state.resolution.toolDecisions),
    formatFeatureGates(state),
    formatSettingsFilesRead(state),
    formatSettingsWarnings(state),
    `Policy warnings: ${formatPolicyWarnings(state)}`,
    formatDiagnosticsBySeverity(state),
    `State version: ${state.version}`,
    `Applied at: ${state.appliedAt}`,
    options.debug ? formatDebugSection(state, options) : undefined,
  ]);
}
