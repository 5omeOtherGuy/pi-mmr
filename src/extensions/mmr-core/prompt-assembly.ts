import {
  buildBuiltinToolGuidance,
  extractActiveBuiltinToolNames,
} from "./builtin-tool-guidance.js";
import { SHARED_CODING_GUIDANCE, SHARED_TOOL_GUIDANCE } from "./prompt-modules.js";
import { MMR_CTHULU_SUMMON_GATE } from "./prompt-templates.js";
import {
  getMmrModePromptRecipe,
  getMmrPromptBase,
  MMR_RESPONSE_STYLE_HEADING,
  MMR_TOOL_USE_HEADING,
  MMR_TOOL_USE_POSTURE_LINE,
  type MmrPromptFragmentId,
} from "./prompt-registry.js";
import type {
  MmrActiveToolManifestEntry,
  MmrModeKey,
  MmrModeState,
  MmrPromptAssemblyResult,
  MmrPromptBlock,
  MmrPromptPassthroughReason,
} from "./types.js";

/**
 * Public mmr-core constants reused by the splice. Re-exported here for
 * backwards compatibility with existing callers and tests; the prompt registry
 * is the source of truth for base prompt and fragment metadata.
 */
export {
  MMR_ADDITIONAL_TOOLS_LINE,
  MMR_IDENTITY_LINE,
  MMR_RESPONSE_STYLE_HEADING,
  MMR_TOOL_USE_HEADING,
  MMR_TOOL_USE_POSTURE_LINE,
} from "./prompt-registry.js";

function findHeaderStart(prompt: string, anchor: string, fromIdx: number): number {
  const idx = prompt.indexOf(anchor, fromIdx);
  return idx === -1 ? -1 : idx + 2;
}

export interface AssembleActiveSurfaceInput {
  state: MmrModeState;
  /** Pi's current chained system prompt for this turn. Read-only input. */
  baseSystemPrompt: string;
  /**
   * The caller-resolved active tool manifest for this turn. Must contain only
   * currently-active tools; deferred/planned/gated/disabled entries must not
   * appear here. Passed through unchanged into the result.
   */
  activeToolManifest: MmrActiveToolManifestEntry[];
  /**
   * Built-in tool guidance source. When provided, the `## Built-in tool
   * guidance` block follows these tool names (the resolved callable/active
   * set) instead of the names parsed from Pi's rendered `Available tools:`
   * block, so guidance covers a tool the agent can call even when Pi did
   * not give it a one-line snippet (snippet-gated tools are omitted from the
   * rendered block but remain callable). `buildBuiltinToolGuidance` filters
   * this list to the curated built-ins, so passing the full active set is
   * safe. An empty array suppresses the block; when omitted, the block falls
   * back to parsing the rendered tools text (unchanged behavior).
   */
  activeToolNames?: readonly string[];
  /** Optional provider/model identifiers forwarded to the result. */
  provider?: string;
  model?: string;
}

function passthroughResult(
  input: AssembleActiveSurfaceInput,
  passthroughReason: MmrPromptPassthroughReason,
): MmrPromptAssemblyResult {
  return {
    mode: input.state.mode,
    provider: input.provider,
    model: input.model,
    blocks: [
      {
        id: "preserved-tail:passthrough",
        kind: "preserved-tail",
        text: input.baseSystemPrompt,
        source: "pi",
      },
    ],
    systemPrompt: input.baseSystemPrompt,
    activeToolManifest: input.activeToolManifest,
    passthroughReason,
  };
}

type PromptedMmrModeKey = Exclude<MmrModeKey, "free">;

function isPromptedMode(mode: string): mode is PromptedMmrModeKey {
  return getMmrModePromptRecipe(mode) !== undefined;
}

/**
 * Build the ordered prompt-block surface for the current MMR mode. The
 * splice surgically replaces Pi's auto-rendered head (identity line through
 * the end of the `Pi documentation` block) with a labeled sequence of
 * blocks; flattening `blocks[].text` concatenated reproduces the
 * `systemPrompt` string byte-for-byte.
 *
 * Policy: Pi-authored blocks (`Available tools:`, `Guidelines:`,
 * `Pi documentation`) are passed through verbatim. The free mode and any
 * unrecognized base layout fall back to a single passthrough block.
 */
export function assembleActiveSurface(
  input: AssembleActiveSurfaceInput,
): MmrPromptAssemblyResult {
  const mode = input.state.mode;
  if (!isPromptedMode(mode)) return passthroughResult(input, "not-prompted-mode");

  const recipe = getMmrModePromptRecipe(mode);
  if (recipe === undefined) return passthroughResult(input, "not-prompted-mode");
  const promptBase = getMmrPromptBase(recipe.basePromptId);

  const base = input.baseSystemPrompt;
  const introStart = base.indexOf(promptBase.identityLine);
  if (introStart === -1) return passthroughResult(input, "identity-anchor-missing");

  const toolsStart = findHeaderStart(base, promptBase.toolsSectionAnchor, introStart);
  const guidelinesStart = findHeaderStart(base, promptBase.guidelinesSectionAnchor, introStart);
  const piDocsStart = findHeaderStart(base, promptBase.piDocsSectionAnchor, introStart);

  if (toolsStart === -1 || guidelinesStart === -1 || piDocsStart === -1) {
    return passthroughResult(input, "section-anchor-missing");
  }

  if (
    !(introStart < toolsStart && toolsStart < guidelinesStart && guidelinesStart < piDocsStart)
  ) {
    return passthroughResult(input, "section-order-invalid");
  }

  const toolsEnd = base.indexOf("\n\n", toolsStart);
  const guidelinesEnd = base.indexOf("\n\n", guidelinesStart);
  if (toolsEnd === -1 || guidelinesEnd === -1) return passthroughResult(input, "section-boundary-missing");

  const docsBlankIdx = base.indexOf("\n\n", piDocsStart);
  const docsDateIdx = base.indexOf(promptBase.dateTailAnchor, piDocsStart);
  const docsEndCandidates = [docsBlankIdx, docsDateIdx].filter((idx) => idx !== -1);
  const docsEnd = docsEndCandidates.length === 0 ? base.length : Math.min(...docsEndCandidates);

  // `before_agent_start` handlers are chained. Mode-derived Task workers can
  // receive the parent prompt after mmr-core already assembled it, then call
  // this function again to rebuild the active-tools block for the child. In
  // that case, strip the previous MMR-owned shared/mode blocks and preserve
  // only Pi's docs block plus the original tail; otherwise repeated assembly
  // duplicates every long MMR instruction. Today the summon-gate fragment is
  // the stable end delimiter for the MMR-owned layer; every prompted recipe is
  // required to include it until a separate internal boundary marker exists.
  const previousMmrGateStart = base.indexOf(MMR_CTHULU_SUMMON_GATE, docsEnd);
  const headEnd = previousMmrGateStart === -1
    ? docsEnd
    : previousMmrGateStart + MMR_CTHULU_SUMMON_GATE.length;

  // Preserve Pi's whole tools block — the `Available tools:` list AND Pi's
  // "In addition to the tools above..." interstitial sentence — byte-for-byte
  // (up to the `Guidelines:` header). Reconstructing the interstitial from a
  // local constant would silently emit stale text (and bypass drift detection)
  // if Pi ever changes that sentence.
  const toolsBlockText = base.slice(toolsStart, guidelinesStart);
  const guidelinesContent = base.slice(guidelinesStart, guidelinesEnd);
  const piDocumentationContent = base.slice(piDocsStart, docsEnd);

  const before = base.slice(0, introStart);
  const after = base.slice(headEnd);
  const builtinToolGuidanceText = buildBuiltinToolGuidance(
    input.activeToolNames ?? extractActiveBuiltinToolNames(toolsBlockText),
  );

  // Each fragment owns its trailing separators so that concatenating all
  // rendered blocks reproduces the systemPrompt byte-for-byte.
  const renderFragment = (fragmentId: MmrPromptFragmentId): MmrPromptBlock | null => {
    switch (fragmentId) {
      case "identity":
        return {
          id: `identity:${mode}`,
          kind: "identity",
          text: `${before}${promptBase.identityLine} <mmr_mode name="${recipe.tag}">${recipe.intro}</mmr_mode>\n\n`,
          source: "mmr-core",
        };
      case "tool-lead-in":
        return {
          id: "tool-lead-in",
          kind: "tool-lead-in",
          text: `${MMR_TOOL_USE_HEADING}\n\n${MMR_TOOL_USE_POSTURE_LINE}\n\n`,
          source: "mmr-core",
        };
      case "active-tools":
        return {
          id: "active-tools",
          kind: "active-tools",
          text: toolsBlockText,
          source: "pi",
        };
      case "active-guidelines":
        return {
          id: "active-guidelines",
          kind: "active-guidelines",
          text: `${guidelinesContent}\n\n`,
          source: "pi",
        };
      case "builtin-tool-guidance":
        return builtinToolGuidanceText
          ? {
              id: "builtin-tool-guidance",
              kind: "builtin-tool-guidance",
              text: `${builtinToolGuidanceText}\n\n`,
              source: "mmr-core",
            }
          : null;
      case "pi-docs":
        return {
          id: "pi-docs",
          kind: "pi-docs",
          text: `${piDocumentationContent}\n\n`,
          source: "pi",
        };
      case "shared-tool-guidance":
        return {
          id: "shared-tool-guidance",
          kind: "shared-tool-guidance",
          text: `${SHARED_TOOL_GUIDANCE}\n\n`,
          source: "mmr-core",
        };
      case "shared-coding-guidance":
        return {
          id: "shared-coding-guidance",
          kind: "shared-coding-guidance",
          text: `${SHARED_CODING_GUIDANCE}\n\n`,
          source: "mmr-core",
        };
      case "mode-posture":
        return {
          id: `mode-posture:${mode}`,
          kind: "mode-posture",
          text: `${recipe.postureSections}\n\n`,
          source: "mmr-core",
        };
      case "response-style":
        return {
          id: `response-style:${mode}`,
          kind: "response-style",
          text: `${MMR_RESPONSE_STYLE_HEADING}\n\n${recipe.closingLine}\n\n`,
          source: "mmr-core",
        };
      case "sunken-rite":
        return {
          id: "sunken-rite",
          kind: "sunken-rite",
          text: MMR_CTHULU_SUMMON_GATE,
          source: "mmr-core",
        };
      case "preserved-tail":
        return {
          id: "preserved-tail",
          kind: "preserved-tail",
          text: after,
          source: "pi",
        };
      default: {
        const exhaustive: never = fragmentId;
        return exhaustive;
      }
    }
  };

  const blocks = recipe.fragments
    .map((fragmentId) => renderFragment(fragmentId))
    .filter((block): block is MmrPromptBlock => block !== null);

  const systemPrompt = blocks.map((b) => b.text).join("");

  return {
    mode,
    provider: input.provider,
    model: input.model,
    blocks,
    systemPrompt,
    activeToolManifest: input.activeToolManifest,
  };
}
