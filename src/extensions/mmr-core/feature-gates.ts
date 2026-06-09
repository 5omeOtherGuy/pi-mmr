import type {
  MmrFeatureGateDecision,
  MmrFeatureGateProvider,
  MmrFeatureGateRegistry,
} from "./types.js";

/**
 * Feature-gate resolver.
 *
 * mmr-core does not implement feature behavior; it only resolves named gates so
 * that mode resolution can record an explainable decision per gate. The
 * resolver is built from an ordered list of providers: later registrations take
 * precedence and may return `enabled`, `disabled`, or `missing` decisions.
 *
 * Two providers are always present in the chain:
 *
 * - `mmr-core.reserved`: known names reserved for future MMR extensions. They
 *   resolve as `missing` with a per-gate reason that names the owning
 *   extension. This makes status output stable and lets later modules detect
 *   that mmr-core has at least heard of them.
 * - `mmr-core.unknown`: terminal fallback for any name no provider claims. It
 *   resolves as `missing` with a generic "unknown feature gate" reason so
 *   typos and stale gate names surface in `/mmr-status` instead of being
 *   silently ignored.
 *
 * Server- and package-provided gates plug in via `registerProvider(...)` on a
 * registry instance (typically the runtime singleton in runtime.ts). Providers
 * registered later take precedence; this lets later MMR extensions override a
 * reserved decision once they actually ship the feature.
 */

/**
 * Reserved gate names. The contract is: a gate name is the bare extension
 * identifier (`mmr-subagents`, not `mmr-subagents.enabled`). Modes opt in by
 * listing the extension name in `MmrModeDefinition.featureGates`, and the
 * reserved provider answers "missing" until that extension actually ships and
 * registers a provider that overrides the decision. Keep this map in sync with
 * the set of extensions consuming the reserved-gate convention.
 */
const RESERVED_GATE_REASONS: Record<string, string> = {
  "mmr-subagents": "Reserved for the mmr-subagents extension; not yet provided.",
  "mmr-subagents.async-tasks": "Reserved for the mmr-subagents async background task tools; not yet provided.",
  "mmr-history": "Reserved for the mmr-history extension; not yet provided.",
  "mmr-web": "Reserved for the mmr-web extension; not yet provided.",
  "mmr-patch": "Reserved for the mmr-patch extension; not yet provided.",
  "mmr-tasks": "Reserved for the mmr-tasks extension; not yet provided.",
  "mmr-toolbox-mcp": "Reserved for the mmr-toolbox-mcp extension; not yet provided.",
};

const RESERVED_PROVIDER: MmrFeatureGateProvider = {
  name: "mmr-core.reserved",
  evaluate(gate) {
    // Use Object.hasOwn to ignore prototype-chain names like "toString" or
    // "constructor", matching the same defensive lookup tool-registry.ts uses
    // for user aliases. A bracket lookup would otherwise return a `Function`
    // (truthy) and short-circuit the guard, producing a decision whose `reason`
    // violates `MmrFeatureGateDecision`.
    if (!Object.hasOwn(RESERVED_GATE_REASONS, gate)) return undefined;
    const reason = RESERVED_GATE_REASONS[gate];
    return { gate, status: "missing", reason };
  },
};

/**
 * Terminal catch-all provider. Always claims the gate as `missing` so the
 * registry never produces an unsourced decision and consumers can introspect
 * it via `getProviders()` like any other provider.
 */
const UNKNOWN_PROVIDER: MmrFeatureGateProvider = {
  name: "mmr-core.unknown",
  evaluate(gate) {
    return { gate, status: "missing", reason: "Unknown feature gate; no provider claimed it." };
  },
};

export function createMmrFeatureGateRegistry(): MmrFeatureGateRegistry {
  // Higher index = higher priority. The unknown catch-all sits at the bottom
  // so it only fires when nothing else claims the gate; reserved sits just
  // above it; explicit registrations push to the top and take precedence.
  const providers: MmrFeatureGateProvider[] = [UNKNOWN_PROVIDER, RESERVED_PROVIDER];

  function evaluateGate(gate: string): MmrFeatureGateDecision {
    for (let i = providers.length - 1; i >= 0; i -= 1) {
      const provider = providers[i];
      const decision = provider.evaluate(gate);
      if (decision) return { ...decision, source: provider.name };
    }
    // Unreachable: UNKNOWN_PROVIDER always returns a decision.
    throw new Error(`No provider resolved feature gate "${gate}"`);
  }

  return {
    registerProvider(provider) {
      providers.push(provider);
    },
    resolve(gates) {
      return gates.map(evaluateGate);
    },
    getProviders() {
      return [...providers];
    },
  };
}

/**
 * Module-level resolver used by callers that do not need a long-lived registry
 * (tests, ad-hoc decisions). It always uses a fresh registry containing only
 * the built-in reserved/unknown providers, so registrations on the runtime
 * singleton never leak into module-level calls and vice versa.
 */
export function resolveMmrFeatureGates(gates: readonly string[]): MmrFeatureGateDecision[] {
  return createMmrFeatureGateRegistry().resolve(gates);
}
