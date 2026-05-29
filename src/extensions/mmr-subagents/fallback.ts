import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MmrModelPreference } from "../mmr-core/types.js";
import type { MmrWorkerOutcomeStatus, MmrWorkerResult } from "./runner.js";

/**
 * Session-scoped subagent worker-model fallback (issue #9).
 *
 * Mirrors the locked-mode quota fallback (`mmr-session-fallback`) but
 * scoped to spawned subagent worker routes (`finder`, `oracle`,
 * `librarian`, `Task`, `cthulu`). When a worker route fails with a
 * model/provider error repeatedly within a session, the parent tool
 * prompts the user to pick a fallback model from the profile's configured
 * fallback chain / locally-authenticated registry, then re-runs the worker
 * once with that route. The selection is held in-process for the current
 * session + subagent scope only; it is never written to settings (that
 * would be global) and never silently switches a subscription-backed route
 * to an API-key-billed route — the user always confirms an explicitly
 * labelled choice.
 *
 * This module owns the pure decision logic and the in-process state. The
 * cross-process plumbing that keeps parent spawn and child activation in
 * agreement lives in the runner (env channel) and `mmr-core` child
 * activation (env read).
 */

/** Default number of same-route worker-model failures before prompting. */
export const MMR_WORKER_FALLBACK_FAILURE_THRESHOLD = 2;

/**
 * Worker outcome statuses that count as a retryable worker-model failure.
 *
 * Only `worker-error` qualifies: per the runner outcome ladder it is the
 * status produced when the child Pi run errors or is killed without usable
 * final text — the signature of a provider/model error (quota, auth, model
 * unavailable, request failure). Local/config failures are deliberately
 * excluded so a fallback prompt never fires for a problem changing the
 * model cannot fix:
 *   - `spawn-error`      — local process/Pi launch failure;
 *   - `activation-error` — profile/tool/model mismatch (config);
 *   - `aborted`          — user cancellation;
 *   - `no-agent-start` / `empty-output` — run/prompt issues, not model
 *     route failures;
 *   - `success`          — not a failure.
 */
const RETRYABLE_WORKER_MODEL_FAILURE_STATUSES: ReadonlySet<MmrWorkerOutcomeStatus> = new Set<MmrWorkerOutcomeStatus>([
  "worker-error",
]);

export function isRetryableMmrWorkerModelFailure(status: MmrWorkerOutcomeStatus): boolean {
  return RETRYABLE_WORKER_MODEL_FAILURE_STATUSES.has(status);
}

/** Billing-relevant route type surfaced before applying a fallback. */
export type MmrWorkerRouteBilling = "subscription" | "api-key" | "unknown";

/**
 * Providers whose configured auth is a subscription/OAuth seat rather than
 * metered API-key billing. Switching away from these to an API-key route
 * can start incurring usage charges, so the fallback flow labels the
 * distinction and never auto-applies it.
 */
const SUBSCRIPTION_BACKED_PROVIDERS: ReadonlySet<string> = new Set([
  "claude-subscription",
  "openai-codex",
  "github-copilot",
]);

/** Minimal registered-model shape consumed from `ctx.modelRegistry`. */
export interface MmrWorkerFallbackRegisteredModel {
  provider: string;
  id: string;
}

/** Minimal `ctx.modelRegistry` surface used to build candidates. */
export interface MmrWorkerFallbackRegistry<TModel extends MmrWorkerFallbackRegisteredModel = MmrWorkerFallbackRegisteredModel> {
  getAll(): TModel[];
  hasConfiguredAuth?(model: TModel): boolean;
  isUsingOAuth?(model: TModel): boolean;
}

function safeGetAll<TModel extends MmrWorkerFallbackRegisteredModel>(registry: MmrWorkerFallbackRegistry<TModel>): TModel[] {
  try {
    return registry.getAll();
  } catch {
    return [];
  }
}

function safeHasConfiguredAuth<TModel extends MmrWorkerFallbackRegisteredModel>(
  registry: MmrWorkerFallbackRegistry<TModel>,
  model: TModel,
): boolean {
  try {
    return registry.hasConfiguredAuth ? registry.hasConfiguredAuth(model) : true;
  } catch {
    return false;
  }
}

function safeIsUsingOAuth<TModel extends MmrWorkerFallbackRegisteredModel>(
  registry: MmrWorkerFallbackRegistry<TModel>,
  model: TModel,
): boolean {
  try {
    return registry.isUsingOAuth ? registry.isUsingOAuth(model) : false;
  } catch {
    return false;
  }
}

export function classifyMmrWorkerRouteBilling<TModel extends MmrWorkerFallbackRegisteredModel>(
  registry: MmrWorkerFallbackRegistry<TModel>,
  model: TModel,
): MmrWorkerRouteBilling {
  if (SUBSCRIPTION_BACKED_PROVIDERS.has(model.provider) || safeIsUsingOAuth(registry, model)) {
    return "subscription";
  }
  return safeHasConfiguredAuth(registry, model) ? "api-key" : "unknown";
}

const BILLING_LABELS: Record<MmrWorkerRouteBilling, string> = {
  subscription: "subscription",
  "api-key": "API key",
  unknown: "unknown billing",
};

/**
 * Leading marker per billing route, shown before the provider/model so a
 * metered or uncertain route stands out when skimming the prompt list.
 * Subscription routes carry no marker (visually lighter) so the eye is
 * drawn to the billed/uncertain ones; the marker never changes ordering,
 * which candidates are offered, or the `billing` value.
 */
const BILLING_MARKERS: Record<MmrWorkerRouteBilling, string> = {
  subscription: "",
  "api-key": "\u26a0 billed \u00b7 ",
  unknown: "\u26a0 unverified \u00b7 ",
};

/** One offered fallback route. */
export interface MmrWorkerFallbackCandidate {
  provider: string;
  model: string;
  billing: MmrWorkerRouteBilling;
  /** Preference entry applied/forwarded when this candidate is chosen. */
  preference: MmrModelPreference;
  suggested: boolean;
  /** User-facing label including provider/model and billing route type. */
  label: string;
}

function preferenceRank(modelId: string, preferences: readonly MmrModelPreference[]): number {
  const rank = preferences.findIndex((preference) => preference.model === modelId);
  return rank < 0 ? Number.MAX_SAFE_INTEGER : rank;
}

function thinkingLevelFor(modelId: string, preferences: readonly MmrModelPreference[]): MmrModelPreference["thinkingLevel"] | undefined {
  return preferences.find((preference) => preference.model === modelId)?.thinkingLevel;
}

/**
 * Build the ranked fallback candidate list from the locally-authenticated
 * registry, excluding the failing route, ranked by the profile fallback
 * chain. The highest-ranked chain match is flagged `suggested`. Each
 * candidate carries its billing route type so the prompt can show it
 * before the user commits.
 */
export function buildMmrWorkerFallbackCandidates<TModel extends MmrWorkerFallbackRegisteredModel>(args: {
  registry: MmrWorkerFallbackRegistry<TModel>;
  preferences: readonly MmrModelPreference[];
  failingProvider?: string;
  failingModel?: string;
}): MmrWorkerFallbackCandidate[] {
  const preferences = args.preferences ?? [];
  const seen = new Set<string>();
  const authenticated = safeGetAll(args.registry)
    .filter((model) => safeHasConfiguredAuth(args.registry, model))
    // Exclude the failing route. When the route was a bare model id (no
    // provider qualifier), exclude by model id alone so every provider
    // variant of the failing model is dropped.
    .filter((model) => !(model.id === args.failingModel
      && (args.failingProvider === undefined || model.provider === args.failingProvider)))
    .filter((model) => {
      const key = `${model.provider}\u0000${model.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  const sorted = [...authenticated].sort((a, b) => {
    const rankDelta = preferenceRank(a.id, preferences) - preferenceRank(b.id, preferences);
    if (rankDelta !== 0) return rankDelta;
    const providerDelta = a.provider.localeCompare(b.provider);
    if (providerDelta !== 0) return providerDelta;
    return a.id.localeCompare(b.id);
  });

  const suggestedIndex = sorted.findIndex((model) => preferenceRank(model.id, preferences) < Number.MAX_SAFE_INTEGER);

  return sorted.map((model, index) => {
    const suggested = index === suggestedIndex;
    const billing = classifyMmrWorkerRouteBilling(args.registry, model);
    const thinkingLevel = thinkingLevelFor(model.id, preferences);
    const preference: MmrModelPreference = {
      model: model.id,
      providers: [model.provider],
      ...(thinkingLevel ? { thinkingLevel } : {}),
    };
    const label = `${suggested ? "Suggested: " : ""}${BILLING_MARKERS[billing]}${model.provider}/${model.id} — ${BILLING_LABELS[billing]}`;
    return { provider: model.provider, model: model.id, billing, preference, suggested, label };
  });
}

// --- In-process session-scoped state -------------------------------------

interface MmrWorkerFallbackRuntime {
  /** route-key -> consecutive retryable failure count within the session. */
  failureCounts: Map<string, number>;
  /** scope-key -> applied fallback preference chain for the session. */
  overrides: Map<string, MmrModelPreference[]>;
  /** scope-keys with a prompt currently in flight (reentrancy guard). */
  promptInFlight: Set<string>;
}

const globalState = globalThis as typeof globalThis & {
  __mmrWorkerFallbackRuntime__?: MmrWorkerFallbackRuntime;
};

function getRuntime(): MmrWorkerFallbackRuntime {
  if (!globalState.__mmrWorkerFallbackRuntime__) {
    globalState.__mmrWorkerFallbackRuntime__ = {
      failureCounts: new Map(),
      overrides: new Map(),
      promptInFlight: new Set(),
    };
  }
  return globalState.__mmrWorkerFallbackRuntime__;
}

function part(value: string | undefined): string {
  return value && value.length > 0 ? value : "-";
}

/**
 * Scope key for a stored fallback override. Keyed by session + profile +
 * parent mode (parent mode matters for mode-derived Task routes), so the
 * override applies only to that subagent in that session.
 */
export function mmrWorkerFallbackScopeKey(args: {
  sessionId?: string;
  profileName: string;
  parentMode?: string;
}): string {
  return [part(args.sessionId), part(args.profileName), part(args.parentMode)].join("\u0000");
}

/** Route key for failure counting: scope + the specific failing route. */
export function mmrWorkerFallbackRouteKey(scopeKey: string, route: string | undefined): string {
  return `${scopeKey}\u0000${part(route)}`;
}

/** Increment and return the session failure count for a route. */
export function recordMmrWorkerFallbackFailure(routeKey: string): number {
  const runtime = getRuntime();
  const next = (runtime.failureCounts.get(routeKey) ?? 0) + 1;
  runtime.failureCounts.set(routeKey, next);
  return next;
}

/**
 * Clear the consecutive-failure count for a route. Called on any
 * non-retryable outcome (including success) so the count reflects
 * *consecutive* retryable failures rather than a lifetime tally, and so
 * the map does not grow without bound across a long session.
 */
export function resetMmrWorkerFallbackFailure(routeKey: string): void {
  getRuntime().failureCounts.delete(routeKey);
}

export function getMmrWorkerFallbackOverride(scopeKey: string): readonly MmrModelPreference[] | undefined {
  return getRuntime().overrides.get(scopeKey);
}

export function setMmrWorkerFallbackOverride(scopeKey: string, preferences: readonly MmrModelPreference[]): void {
  getRuntime().overrides.set(scopeKey, preferences.map((preference) => ({ ...preference })));
}

/** Safely read the current session id from an extension context. */
export function readMmrWorkerSessionId(
  ctx: { sessionManager?: { getSessionId?: () => string | undefined } },
): string | undefined {
  try {
    return ctx.sessionManager?.getSessionId?.();
  } catch {
    return undefined;
  }
}

/** Clear all in-process worker-fallback state (test isolation + new sessions). */
export function resetMmrWorkerFallbackState(): void {
  globalState.__mmrWorkerFallbackRuntime__ = {
    failureCounts: new Map(),
    overrides: new Map(),
    promptInFlight: new Set(),
  };
}

// --- Prompt ---------------------------------------------------------------

/**
 * Prompt the user (parent UI) to pick a fallback worker route. Returns the
 * chosen candidate, or `undefined` when there are no candidates, the user
 * cancels, or a prompt is already in flight for this scope. Never mutates
 * stored state — the caller decides whether to apply the selection.
 */
export async function promptMmrWorkerFallback(args: {
  ctx: Pick<ExtensionContext, "ui" | "hasUI">;
  scopeKey: string;
  toolName: string;
  candidates: readonly MmrWorkerFallbackCandidate[];
  reason: string;
}): Promise<MmrWorkerFallbackCandidate | undefined> {
  if (!args.ctx.hasUI) return undefined;
  if (args.candidates.length === 0) return undefined;

  const runtime = getRuntime();
  if (runtime.promptInFlight.has(args.scopeKey)) return undefined;
  runtime.promptInFlight.add(args.scopeKey);
  try {
    const byLabel = new Map(args.candidates.map((candidate) => [candidate.label, candidate]));
    const picked = await args.ctx.ui.select(
      `${args.toolName}: repeated worker-model errors — ${args.reason}. Select a fallback model:`,
      args.candidates.map((candidate) => candidate.label),
    );
    if (!picked) return undefined;
    return byLabel.get(picked);
  } finally {
    runtime.promptInFlight.delete(args.scopeKey);
  }
}

// --- Orchestrator ---------------------------------------------------------

/** Split a worker route string into provider/model parts. */
function splitWorkerRoute(route: string | undefined): { provider?: string; model?: string } {
  if (!route) return {};
  const slash = route.indexOf("/");
  if (slash > 0 && slash < route.length - 1) {
    return { provider: route.slice(0, slash), model: route.slice(slash + 1) };
  }
  return { model: route };
}

/**
 * Build the override preference chain applied after the user accepts a
 * fallback: the chosen route first, then the remaining base preferences
 * (so further degradation is still possible), excluding the chosen model
 * and the failing model.
 */
function buildOverrideChain(
  chosen: MmrModelPreference,
  basePreferences: readonly MmrModelPreference[],
  failingModel: string | undefined,
): MmrModelPreference[] {
  const rest = basePreferences.filter(
    (preference) => preference.model !== chosen.model && preference.model !== failingModel,
  );
  return [chosen, ...rest];
}

export interface MmrWorkerFallbackRunArgs {
  /**
   * Applied fallback override for this run, or `undefined` for the normal
   * route. When defined, the caller's `run` closure must (a) select the
   * worker model from this override and (b) forward it to the runner as
   * `modelPreferencesOverride` so the child activation guard resolves the
   * same route via the env channel. When `undefined`, the closure does its
   * own normal preference resolution (settings/profile), unchanged.
   */
  override?: readonly MmrModelPreference[];
}

export interface MmrWorkerFallbackRunOutput {
  result: MmrWorkerResult;
  /** Parent-selected worker route string the run used (`provider/model` or bare id). */
  route: string | undefined;
}

export interface MmrWorkerFallbackOutcome {
  result: MmrWorkerResult;
  route: string | undefined;
  /** True when the returned result came from a run under a fallback override. */
  fallbackApplied: boolean;
}

/**
 * Run a spawned worker with session-scoped model fallback.
 *
 * 1. Apply any stored session fallback override for this scope before the
 *    first run (so later calls skip straight to the fallback route).
 * 2. Run once via the caller's `run` closure (which selects the route from
 *    the given preferences, builds runner options, and runs the worker).
 * 3. On a retryable worker-model failure, increment the session failure
 *    count for the route. When the threshold is reached, there is no
 *    override yet, and UI is available, prompt the user for a fallback and
 *    — if accepted — store the override and re-run once with it.
 *
 * Never auto-applies a fallback: the user always confirms an explicitly
 * billing-labelled choice, so a subscription route is never silently
 * swapped for an API-key-billed one.
 */
export async function runMmrWorkerWithModelFallback(args: {
  ctx: Pick<ExtensionContext, "ui" | "hasUI">;
  sessionId?: string;
  registry: MmrWorkerFallbackRegistry;
  toolName: string;
  profileName: string;
  parentMode?: string;
  /**
   * Profile fallback chain used to rank candidates and build the override
   * chain. Provider-qualified preferences improve candidate matching.
   */
  candidatePreferences: readonly MmrModelPreference[];
  classifyOutcome: (result: MmrWorkerResult) => MmrWorkerOutcomeStatus;
  run: (runArgs: MmrWorkerFallbackRunArgs) => Promise<MmrWorkerFallbackRunOutput>;
  failureThreshold?: number;
}): Promise<MmrWorkerFallbackOutcome> {
  const threshold = args.failureThreshold ?? MMR_WORKER_FALLBACK_FAILURE_THRESHOLD;
  const scopeKey = mmrWorkerFallbackScopeKey({
    sessionId: args.sessionId,
    profileName: args.profileName,
    parentMode: args.parentMode,
  });
  const stored = getMmrWorkerFallbackOverride(scopeKey);

  const first = await args.run(stored ? { override: stored } : {});
  const fallbackApplied = Boolean(stored);

  const status = args.classifyOutcome(first.result);
  if (!isRetryableMmrWorkerModelFailure(status)) {
    // Success or any non-retryable terminal outcome resets the route's
    // consecutive-failure count so a later isolated failure does not jump
    // straight to the prompt.
    resetMmrWorkerFallbackFailure(mmrWorkerFallbackRouteKey(scopeKey, first.route));
    return { result: first.result, route: first.route, fallbackApplied };
  }

  const count = recordMmrWorkerFallbackFailure(mmrWorkerFallbackRouteKey(scopeKey, first.route));
  // Already running a fallback, below threshold, or no UI to prompt: return
  // the failure unchanged. Only fresh routes reaching the threshold with an
  // interactive parent get a prompt.
  if (stored || count < threshold || !args.ctx.hasUI) {
    return { result: first.result, route: first.route, fallbackApplied };
  }

  const { provider: failingProvider, model: failingModel } = splitWorkerRoute(first.route);
  const candidates = buildMmrWorkerFallbackCandidates({
    registry: args.registry,
    preferences: args.candidatePreferences,
    ...(failingProvider !== undefined ? { failingProvider } : {}),
    ...(failingModel !== undefined ? { failingModel } : {}),
  });
  const choice = await promptMmrWorkerFallback({
    ctx: args.ctx,
    scopeKey,
    toolName: args.toolName,
    candidates,
    reason: failingModel ? `route ${first.route} failed` : "worker route failed",
  });
  if (!choice) {
    return { result: first.result, route: first.route, fallbackApplied };
  }

  const override = buildOverrideChain(choice.preference, args.candidatePreferences, failingModel);
  const retry = await args.run({ override });
  // Persist the override only when the retry actually adopted the chosen
  // route. The per-tool `run` closure can silently fall back to the
  // original route when the override fails to resolve; persisting a
  // non-adopted override would store a dead route and block every future
  // fallback prompt for this scope. `fallbackApplied` stays true because
  // the override DID apply to this run — only the *persistence* is gated on
  // the retry route's model part matching the chosen model, so a failed
  // adoption lets a later call re-prompt instead of silently reusing it.
  if (splitWorkerRoute(retry.route).model === choice.preference.model) {
    setMmrWorkerFallbackOverride(scopeKey, override);
  }
  return { result: retry.result, route: retry.route, fallbackApplied: true };
}
