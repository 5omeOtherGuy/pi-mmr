import { createMmrFeatureGateRegistry } from "./feature-gates.js";
import { getMmrMode } from "./modes.js";
import { createMmrModelPlan } from "./model-resolver.js";
import type { MmrSubagentPromptRoute } from "./subagent-profiles.js";
import { createMmrToolRegistry, type MmrToolRegistry } from "./tool-registry.js";
import type {
  MmrFeatureGateDecision,
  MmrFeatureGateProvider,
  MmrFeatureGateRegistry,
  MmrLockedModeKey,
  MmrModeEvent,
  MmrModeExtraToolProvider,
  MmrModeKey,
  MmrModeState,
  MmrModelResolution,
  MmrPromptRoute,
  MmrSessionIdentity,
  MmrToolProvider,
  MmrToolResolution,
} from "./types.js";

/**
 * Bounded cap on the in-memory mode/fallback event history. Old entries are
 * dropped FIFO once the cap is reached. Small on purpose: this is an operator
 * debugging aid surfaced by `/mmr-status debug`, not an audit log.
 */
export const MMR_MODE_HISTORY_LIMIT = 16;

/**
 * Live runtime snapshot of an active subagent worker. Set only while a
 * `--mmr-subagent <name>` child Pi process is running; cleared when no
 * subagent is active. Distinct from `MmrModeState` so subagent activation
 * never appears as a locked user-facing mode in /mmr-status, the footer,
 * or persisted session entries.
 */
export interface MmrManagedModelOverrideState {
  kind: "session-fallback";
  provider: string;
  model: string;
  thinkingLevel?: string;
  appliedAt: string;
}

export interface MmrSubagentState {
  /** Subagent profile name (matches `--mmr-subagent <name>`). */
  profile: string;
  /** Resolved provider/id route applied via `pi.setModel`. */
  provider: string;
  model: string;
  /** Thinking level applied via `pi.setThinkingLevel`, if any. */
  thinkingLevel?: string;
  /**
   * Profile-declared hard cap on per-request output tokens, applied by
   * mmr-core's `before_provider_request` hook in the child Pi process.
   * Undefined leaves Pi's provider default in place.
   */
  maxOutputTokens?: number;
  /** Profile prompt route. Always `"subagent"` today. */
  promptRoute: MmrSubagentPromptRoute;
  /** Concrete Pi tool allowlist applied via `pi.setActiveTools`. */
  activeTools: readonly string[];
  /** ISO-8601 timestamp at activation time. */
  activatedAt: string;
}

/**
 * Pi event-bus topic emitted by the mmr-core extension whenever the active
 * MMR mode state changes (mode switch, free-mode opt-out, native control
 * fallback). The payload is the deep-frozen runtime singleton's MmrModeState
 * (or `undefined` when state was cleared).
 *
 * Pi's event bus fans the same payload object out to every subscriber for a
 * given emission, so the raw payload delivered through
 * `pi.events.on(MMR_EVENT_STATE_CHANGED, ...)` is shared across listeners and
 * is frozen — attempts to mutate it throw in strict mode. Use
 * `onMmrStateChanged(pi, handler)` for a per-invocation deep clone that
 * handlers may mutate freely.
 */
export const MMR_EVENT_STATE_CHANGED = "mmr-core:state-changed";

/**
 * Pi event-bus topic emitted whenever the resolved `MmrSessionIdentity`
 * changes (initial capture at session_start, session replacement, or explicit
 * clear). Payload is the deep-frozen live identity, or `undefined` if it was
 * cleared. As with `MMR_EVENT_STATE_CHANGED`, use
 * `onMmrSessionIdentityChanged(pi, handler)` for a per-handler mutable deep
 * clone.
 */
export const MMR_EVENT_SESSION_IDENTITY_CHANGED = "mmr-core:session-identity-changed";

// Intentionally a JSON-shaped clone, not a generic deep clone. Runtime
// snapshots are treated as JSON data; JSON round-trip behavior is observable
// and differs from structuredClone for own undefined-valued properties and
// future non-JSON values. Do not replace with structuredClone unless the state
// contract changes (e.g. Map/Set/Date enters state).
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneMmrSessionIdentity(identity: MmrSessionIdentity): MmrSessionIdentity {
  return cloneJson(identity);
}

function looksLikeMmrSessionIdentity(value: unknown): value is MmrSessionIdentity {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<MmrSessionIdentity>;
  return candidate.version === 1 && typeof candidate.source === "string";
}

function deepFreezeJson<T>(value: T): T {
  const seen = new WeakSet<object>();
  const freeze = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    Object.freeze(node);
    for (const child of Object.values(node as Record<string, unknown>)) freeze(child);
  };
  freeze(value);
  return value;
}

function mmrSessionIdentityEqual(
  a: MmrSessionIdentity | undefined,
  b: MmrSessionIdentity | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  // `observedAt` is intentionally excluded: it records *when* identity was
  // captured, not *what* the identity is. Including it would make every
  // fresh capture of the same session report `changed: true` and re-emit
  // `MMR_EVENT_SESSION_IDENTITY_CHANGED`, contradicting the event's name.
  return a.version === b.version
    && a.cwd === b.cwd
    && a.sessionId === b.sessionId
    && a.sessionName === b.sessionName
    && a.source === b.source;
}

function cloneMmrModeState(state: MmrModeState): MmrModeState {
  // Structured-clone-style deep copy. mmr-core's state shape is plain JSON
  // (no Maps/Sets/Dates), so JSON round-trip is sufficient and avoids leaking
  // live array/object references that callers could mutate. The result is
  // unfrozen even when `state` came from the deep-frozen runtime singleton,
  // so callers can mutate the snapshot freely.
  return cloneJson(state);
}

function looksLikeMmrModeState(value: unknown): value is MmrModeState {
  // Cheap structural check; the bus is structurally typed (`unknown`) so a
  // third party could legally emit on this topic. We require a plain object
  // with the discriminating `mode` field the snapshot always carries; that
  // is enough to reject unrelated emissions (strings, numbers, arrays) before
  // they reach JSON.stringify in the clone path.
  if (value === null || typeof value !== "object") return false;
  return typeof (value as Partial<MmrModeState>).mode === "string";
}

/**
 * Minimal slice of Pi's `EventBus` that mmr-core needs to subscribe to the
 * shared event bus. Declared structurally so callers do not need to import
 * the Pi type just to subscribe. Pi's real bus has `on` return an
 * unsubscribe function; test hosts that do not return one are tolerated
 * with a no-op cleanup.
 */
export interface MmrEventBusHost {
  events: {
    on(eventName: string, handler: (data: unknown) => void): void | (() => void);
  };
}

export type MmrStateChangedHandler = (state: MmrModeState | undefined) => void;
export type MmrSessionIdentityChangedHandler = (identity: MmrSessionIdentity | undefined) => void;

/**
 * Subscribe to MMR mode-state changes with per-invocation deep cloning.
 *
 * Pi's event bus shares one payload object across all subscribers per emission,
 * so handlers attached via `pi.events.on(MMR_EVENT_STATE_CHANGED, ...)` must
 * not mutate the value. This helper wraps that subscription and hands each
 * handler its own deep-cloned snapshot, which is safe to retain or mutate.
 *
 * Returns the unsubscribe function from Pi's bus (or a no-op fallback for
 * test hosts that do not return one), so callers can detach the handler.
 */
export function onMmrStateChanged(pi: MmrEventBusHost, handler: MmrStateChangedHandler): () => void {
  const dispose = pi.events.on(MMR_EVENT_STATE_CHANGED, (data) => {
    if (data === undefined || data === null) {
      handler(undefined);
      return;
    }
    if (!looksLikeMmrModeState(data)) return;
    handler(cloneMmrModeState(data));
  });
  return typeof dispose === "function" ? dispose : () => {};
}

/**
 * Subscribe to MMR session-identity changes with per-invocation deep cloning.
 *
 * Mirrors `onMmrStateChanged`: Pi's event bus shares one payload across
 * subscribers, so handlers attached via raw `pi.events.on(...)` must not
 * mutate. This helper hands each handler its own mutable deep clone and
 * filters payloads that do not look like an `MmrSessionIdentity`.
 */
export function onMmrSessionIdentityChanged(
  pi: MmrEventBusHost,
  handler: MmrSessionIdentityChangedHandler,
): () => void {
  const dispose = pi.events.on(MMR_EVENT_SESSION_IDENTITY_CHANGED, (data) => {
    if (data === undefined || data === null) {
      handler(undefined);
      return;
    }
    if (!looksLikeMmrSessionIdentity(data)) return;
    handler(cloneMmrSessionIdentity(data));
  });
  return typeof dispose === "function" ? dispose : () => {};
}

/**
 * Result of an identity write. `changed` is `true` iff the identity differs
 * from the previously published one. Callers use this to decide whether to
 * emit `MMR_EVENT_SESSION_IDENTITY_CHANGED`.
 */
export interface MmrSessionIdentityWriteResult {
  changed: boolean;
}

export interface MmrCoreRuntime {
  /** Live subagent state; undefined when no subagent worker is active. */
  getMmrSubagentState(): MmrSubagentState | undefined;
  setMmrSubagentState(state: MmrSubagentState | undefined): void;
  getMmrManagedModelOverride(): MmrManagedModelOverrideState | undefined;
  setMmrManagedModelOverride(state: MmrManagedModelOverrideState | undefined): void;
  getMmrModeState(): MmrModeState | undefined;
  /** Deep-cloned snapshot of the current state; safe to retain or mutate. */
  getMmrModeStateSnapshot(): MmrModeState | undefined;
  setMmrModeState(state: MmrModeState | undefined): void;
  /** Frozen live identity; do not mutate. */
  getMmrSessionIdentity(): MmrSessionIdentity | undefined;
  /** Deep-cloned snapshot of the current identity; safe to retain or mutate. */
  getMmrSessionIdentitySnapshot(): MmrSessionIdentity | undefined;
  /**
   * Internal setter for the current Pi/MMR session identity. Returns whether
   * the identity actually changed.
   *
   * Intentionally not re-exported from the package root: identity should
   * flow from Pi's session lifecycle in mmr-core, not be poked by arbitrary
   * callers.
   */
  setMmrSessionIdentity(identity: MmrSessionIdentity | undefined): MmrSessionIdentityWriteResult;
  getPromptRoute(modeKey: MmrModeKey): MmrPromptRoute;
  resolveMmrModel(modeKey: MmrModeKey): MmrModelResolution;
  resolveMmrTools(modeKey: MmrModeKey, availableTools: readonly string[]): MmrToolResolution;
  isToolAllowed(toolName: string): boolean;
  registerToolProvider(provider: MmrToolProvider): void;
  getToolRegistry(): MmrToolRegistry;
  registerModeExtraToolProvider(provider: MmrModeExtraToolProvider): void;
  resolveModeExtraTools(modeKey: MmrLockedModeKey, cwd: string): string[];
  registerFeatureGateProvider(provider: MmrFeatureGateProvider): void;
  resolveFeatureGates(gates: readonly string[]): MmrFeatureGateDecision[];
  getFeatureGateRegistry(): MmrFeatureGateRegistry;
  isMmrManagedModelUpdateActive(): boolean;
  runMmrManagedModelUpdate<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Append a mode/fallback event to the bounded history. Consecutive
   * duplicates (same mode, source, model, fallback state, and reason) are
   * collapsed so a re-apply that changed nothing does not spam the log.
   */
  recordMmrModeEvent(event: MmrModeEvent): void;
  /** Oldest-to-newest snapshot of the bounded mode/fallback event history. */
  getMmrModeHistory(): readonly MmrModeEvent[];
}

export function createMmrCoreRuntime(
  toolRegistry: MmrToolRegistry = createMmrToolRegistry(),
  featureGateRegistry: MmrFeatureGateRegistry = createMmrFeatureGateRegistry(),
): MmrCoreRuntime {
  let activeState: MmrModeState | undefined;
  let activeSubagent: MmrSubagentState | undefined;
  let activeIdentity: MmrSessionIdentity | undefined;
  let activeManagedModelOverride: MmrManagedModelOverrideState | undefined;
  let managedModelUpdateDepth = 0;
  const modeExtraToolProviders: MmrModeExtraToolProvider[] = [];
  const modeHistory: MmrModeEvent[] = [];

  return {
    getMmrSubagentState() {
      return activeSubagent;
    },
    setMmrSubagentState(state) {
      if (!state) {
        activeSubagent = undefined;
        return;
      }
      // Deep-freeze the live singleton so callers cannot mutate the
      // activeTools array or other fields through the returned reference.
      const frozen: MmrSubagentState = {
        ...state,
        activeTools: Object.freeze([...state.activeTools]),
      };
      activeSubagent = Object.freeze(frozen);
    },

    getMmrManagedModelOverride() {
      return activeManagedModelOverride;
    },

    setMmrManagedModelOverride(state) {
      activeManagedModelOverride = state ? Object.freeze({ ...state }) : undefined;
    },

    getMmrModeState() {
      return activeState;
    },

    getMmrModeStateSnapshot() {
      return activeState ? cloneMmrModeState(activeState) : undefined;
    },

    setMmrModeState(state) {
      // Deep-freeze the live singleton so callers that hold the reference
      // returned by `getMmrModeState()` cannot accidentally corrupt runtime
      // state through array push / property assignment. Callers that need a
      // mutable copy should use `getMmrModeStateSnapshot()`.
      activeState = state ? deepFreezeJson(state) : undefined;
    },

    getMmrSessionIdentity() {
      return activeIdentity;
    },

    getMmrSessionIdentitySnapshot() {
      return activeIdentity ? cloneMmrSessionIdentity(activeIdentity) : undefined;
    },

    setMmrSessionIdentity(identity) {
      const next = identity ? deepFreezeJson(cloneMmrSessionIdentity(identity)) : undefined;
      const changed = !mmrSessionIdentityEqual(activeIdentity, next);
      activeIdentity = next;
      return { changed };
    },

    getPromptRoute(modeKey) {
      return getMmrMode(modeKey).promptRoute;
    },

    resolveMmrModel(modeKey) {
      return createMmrModelPlan(getMmrMode(modeKey).modelPreferences);
    },

    resolveMmrTools(modeKey, availableTools) {
      return toolRegistry.resolve(getMmrMode(modeKey).tools, availableTools);
    },

    isToolAllowed(toolName) {
      return Boolean(activeState?.activeTools.includes(toolName));
    },

    registerToolProvider(provider) {
      toolRegistry.registerProvider(provider);
    },

    getToolRegistry() {
      return toolRegistry;
    },

    registerModeExtraToolProvider(provider) {
      // De-dup by name so an in-process extension reload replaces rather than
      // stacks duplicate providers.
      const existingIndex = modeExtraToolProviders.findIndex((entry) => entry.name === provider.name);
      if (existingIndex >= 0) modeExtraToolProviders[existingIndex] = provider;
      else modeExtraToolProviders.push(provider);
    },

    resolveModeExtraTools(modeKey, cwd) {
      const seen = new Set<string>();
      const result: string[] = [];
      for (const provider of modeExtraToolProviders) {
        let names: readonly string[];
        try {
          names = provider.getExtraTools({ modeKey, cwd });
        } catch {
          names = [];
        }
        for (const name of names) {
          const trimmed = typeof name === "string" ? name.trim() : "";
          if (trimmed.length === 0 || seen.has(trimmed)) continue;
          seen.add(trimmed);
          result.push(trimmed);
        }
      }
      return result;
    },

    registerFeatureGateProvider(provider) {
      featureGateRegistry.registerProvider(provider);
    },

    resolveFeatureGates(gates) {
      return featureGateRegistry.resolve(gates);
    },

    getFeatureGateRegistry() {
      return featureGateRegistry;
    },

    isMmrManagedModelUpdateActive() {
      return managedModelUpdateDepth > 0;
    },

    async runMmrManagedModelUpdate(fn) {
      managedModelUpdateDepth += 1;
      try {
        return await fn();
      } finally {
        await Promise.resolve();
        managedModelUpdateDepth -= 1;
      }
    },

    recordMmrModeEvent(event) {
      const last = modeHistory[modeHistory.length - 1];
      // Collapse exact consecutive duplicates (ignoring timestamp): a re-apply
      // that changed nothing observable should not grow the log.
      if (
        last
        && last.mode === event.mode
        && last.previousMode === event.previousMode
        && last.source === event.source
        && last.model === event.model
        && last.thinkingLevel === event.thinkingLevel
        && last.fallbackApplied === event.fallbackApplied
        && last.fallbackReason === event.fallbackReason
      ) {
        return;
      }
      modeHistory.push({ ...event });
      // FIFO trim to the cap.
      while (modeHistory.length > MMR_MODE_HISTORY_LIMIT) modeHistory.shift();
    },

    getMmrModeHistory() {
      return modeHistory.map((event) => ({ ...event }));
    },
  };
}

// Bumped to v2 when the runtime dropped `registerMmrToolAlias` and the
// alias-based tool registry. The shape-check below also rebuilds the
// singleton if an older build's instance is still on `globalThis`.
const MMR_CORE_RUNTIME_GLOBAL_KEY = "__pi_mmr_core_runtime_v2__";

const globalRuntimeStore = globalThis as typeof globalThis & {
  [MMR_CORE_RUNTIME_GLOBAL_KEY]?: MmrCoreRuntime;
};

/**
 * Methods every consumer of the global runtime singleton expects to be
 * callable. When Pi reloads an extension in-place against an upgraded
 * `mmr-core` build, the old singleton already stored on `globalThis` may
 * predate methods added after it was first created. Re-using that stale
 * object would throw `runtime.<method> is not a function` from the new
 * wrappers below. The shape check at `resolveProcessRuntime()` rebuilds the
 * singleton whenever any expected method is missing.
 */
const REQUIRED_RUNTIME_METHODS = [
  "getMmrSubagentState",
  "setMmrSubagentState",
  "getMmrManagedModelOverride",
  "setMmrManagedModelOverride",
  "getMmrModeState",
  "getMmrModeStateSnapshot",
  "setMmrModeState",
  "getMmrSessionIdentity",
  "getMmrSessionIdentitySnapshot",
  "setMmrSessionIdentity",
  "getPromptRoute",
  "resolveMmrModel",
  "resolveMmrTools",
  "isToolAllowed",
  "registerToolProvider",
  "getToolRegistry",
  "registerModeExtraToolProvider",
  "resolveModeExtraTools",
  "registerFeatureGateProvider",
  "resolveFeatureGates",
  "getFeatureGateRegistry",
  "isMmrManagedModelUpdateActive",
  "runMmrManagedModelUpdate",
  "recordMmrModeEvent",
  "getMmrModeHistory",
] as const satisfies readonly (keyof MmrCoreRuntime)[];

function isMmrCoreRuntimeCompatible(value: unknown): value is MmrCoreRuntime {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return REQUIRED_RUNTIME_METHODS.every((method) => typeof candidate[method] === "function");
}

/**
 * Process-global runtime singleton.
 *
 * Pi may load package extension entrypoints with isolated module caches. A
 * module-local singleton would give `mmr-core`, `mmr-toolbox`, and `mmr-web`
 * separate registries even though they run in the same Pi process, so sibling
 * extensions' `registerMmrToolProvider` / `registerMmrFeatureGateProvider`
 * calls would not affect the resolver that applies modes. Store the singleton
 * on `globalThis` so all cache-isolated copies share one runtime instance.
 *
 * The shape check guards against an in-process upgrade where a previously
 * loaded build of `mmr-core` left an older singleton on `globalThis`: if any
 * method this build relies on is missing, drop the stale instance and create
 * a fresh one. Sibling-extension state held only on the prior singleton is
 * lost, but that is preferable to throwing from every `before_provider_request`
 * hook and breaking every tool call in the session.
 */
function resolveProcessRuntime(): MmrCoreRuntime {
  const existing = globalRuntimeStore[MMR_CORE_RUNTIME_GLOBAL_KEY];
  if (isMmrCoreRuntimeCompatible(existing)) return existing;
  const fresh = createMmrCoreRuntime();
  globalRuntimeStore[MMR_CORE_RUNTIME_GLOBAL_KEY] = fresh;
  return fresh;
}

const runtime = resolveProcessRuntime();

/**
 * Live read of the current MMR mode state.
 *
 * The returned object is the runtime singleton's live state and **must not be
 * mutated**. New consumers should prefer `getMmrModeStateSnapshot()`, which
 * returns a deep clone safe to keep or mutate. This live-read variant remains
 * exported for backward compatibility with existing callers that only read
 * scalar fields.
 */
export function getMmrModeState(): MmrModeState | undefined {
  return runtime.getMmrModeState();
}

/**
 * Public, copy-on-read view of the current MMR mode state.
 *
 * Returns a deep-cloned snapshot, so callers may keep or mutate the result
 * without affecting the runtime singleton or other listeners.
 */
export function getMmrModeStateSnapshot(): MmrModeState | undefined {
  return runtime.getMmrModeStateSnapshot();
}

export function setMmrModeState(state: MmrModeState | undefined): void {
  runtime.setMmrModeState(state);
}

/**
 * Live read of the current subagent runtime state. Undefined when no
 * `--mmr-subagent <name>` worker is active. The returned object is the
 * runtime singleton's frozen value and must not be mutated.
 */
export function getMmrSubagentState(): MmrSubagentState | undefined {
  return runtime.getMmrSubagentState();
}

export function setMmrSubagentState(state: MmrSubagentState | undefined): void {
  runtime.setMmrSubagentState(state);
}

export function getMmrManagedModelOverride(): MmrManagedModelOverrideState | undefined {
  return runtime.getMmrManagedModelOverride();
}

export function setMmrManagedModelOverride(state: MmrManagedModelOverrideState | undefined): void {
  runtime.setMmrManagedModelOverride(state);
}

export function clearMmrManagedModelOverride(): void {
  runtime.setMmrManagedModelOverride(undefined);
}

/**
 * Live read of the current resolved MMR session identity.
 *
 * The returned object is the runtime singleton's deep-frozen identity and
 * **must not be mutated**. Use `getMmrSessionIdentitySnapshot()` when a
 * mutable copy is needed.
 */
export function getMmrSessionIdentity(): MmrSessionIdentity | undefined {
  return runtime.getMmrSessionIdentity();
}

/**
 * Public, copy-on-read view of the current MMR session identity.
 *
 * Returns a deep-cloned snapshot, so callers may keep or mutate the result
 * without affecting the runtime singleton or other listeners.
 */
export function getMmrSessionIdentitySnapshot(): MmrSessionIdentity | undefined {
  return runtime.getMmrSessionIdentitySnapshot();
}

/**
 * Internal setter for the base identity. Exported from this module so
 * mmr-core's extension entrypoint (and tests resetting the singleton) can
 * push captured identity through Pi lifecycle hooks. Intentionally **not**
 * re-exported from the package root.
 */
export function setMmrSessionIdentity(
  identity: MmrSessionIdentity | undefined,
): MmrSessionIdentityWriteResult {
  return runtime.setMmrSessionIdentity(identity);
}

/**
 * Prompt route for a given mode key. Stable contract for prompt-aware
 * extensions: they should branch on this value rather than reading mode
 * definitions or `MmrModeState.promptRoute` through private paths.
 */
export function getMmrPromptRoute(modeKey: MmrModeKey): MmrPromptRoute {
  return runtime.getPromptRoute(modeKey);
}

export function resolveMmrModel(modeKey: MmrModeKey): MmrModelResolution {
  return runtime.resolveMmrModel(modeKey);
}

export function resolveMmrTools(modeKey: MmrModeKey, availableTools: readonly string[]): MmrToolResolution {
  return runtime.resolveMmrTools(modeKey, availableTools);
}

export function isToolAllowed(toolName: string): boolean {
  return runtime.isToolAllowed(toolName);
}

export function registerMmrToolProvider(provider: MmrToolProvider): void {
  runtime.registerToolProvider(provider);
}

export function getMmrToolRegistry(): MmrToolRegistry {
  return runtime.getToolRegistry();
}

/**
 * Register a provider that contributes extra concrete tool names to locked
 * modes at activation time (e.g. mmr-subagents enabled custom `sa__*`
 * subagents). Providers are de-duped by `name`.
 */
export function registerMmrModeExtraToolProvider(provider: MmrModeExtraToolProvider): void {
  runtime.registerModeExtraToolProvider(provider);
}

/** Resolve all provider-contributed extra tool names for a locked mode + cwd. */
export function resolveMmrModeExtraTools(modeKey: MmrLockedModeKey, cwd: string): string[] {
  return runtime.resolveModeExtraTools(modeKey, cwd);
}

export function registerMmrFeatureGateProvider(provider: MmrFeatureGateProvider): void {
  runtime.registerFeatureGateProvider(provider);
}

/**
 * Runtime-bound feature gate resolver.
 *
 * This is the public root API entry point: it always uses the runtime
 * singleton's registry, so providers added through
 * `registerMmrFeatureGateProvider` are reflected here. Callers that need an
 * isolated resolver should build one via `createMmrFeatureGateRegistry()` from
 * `feature-gates.ts`.
 */
export function resolveMmrFeatureGates(gates: readonly string[]): MmrFeatureGateDecision[] {
  return runtime.resolveFeatureGates(gates);
}

export function getMmrFeatureGateRegistry(): MmrFeatureGateRegistry {
  return runtime.getFeatureGateRegistry();
}

export function isMmrManagedModelUpdateActive(): boolean {
  return runtime.isMmrManagedModelUpdateActive();
}

export async function runMmrManagedModelUpdate<T>(fn: () => Promise<T>): Promise<T> {
  return runtime.runMmrManagedModelUpdate(fn);
}

/**
 * Record a mode/fallback event in the bounded, in-memory history surfaced by
 * `/mmr-status debug`. Consecutive duplicates are collapsed by the runtime.
 */
export function recordMmrModeEvent(event: MmrModeEvent): void {
  runtime.recordMmrModeEvent(event);
}

/** Oldest-to-newest snapshot of the bounded mode/fallback event history. */
export function getMmrModeHistory(): readonly MmrModeEvent[] {
  return runtime.getMmrModeHistory();
}
