import {
  buildBuiltinToolGuidance,
  extractActiveBuiltinToolNames,
} from "./builtin-tool-guidance.js";
import {
  buildUsingWorkersGuidance,
  extractActiveWorkerToolNames,
} from "./worker-tool-guidance.js";
import {
  DEEP_ENGINEERING_JUDGMENT,
  resolveModeCodingGuidanceFragment,
  SHARED_CODING_GUIDANCE_FRAGMENTS,
  SHARED_TOOL_GUIDANCE,
} from "./prompt-content.js";
import {
  getMmrModePromptRecipe,
  getMmrPromptBase,
  MMR_MODE_PROMPT_RECIPES,
  MMR_RESPONSE_STYLE_HEADING,
  MMR_TOOL_USE_HEADING,
  MMR_TOOL_USE_POSTURE_LINE,
  type MmrModePromptRecipe,
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

const MMR_TAIL_SEPARATOR = "\n\n";

function renderMmrOwnedTailFragment(
  fragmentId: MmrPromptFragmentId,
  previousRecipe: MmrModePromptRecipe,
): string | undefined {
  switch (fragmentId) {
    case "shared-tool-guidance":
      return SHARED_TOOL_GUIDANCE;
    case "autonomy":
    case "discovery-discipline":
    case "pragmatism":
    case "verification":
    case "careful-actions":
    case "diagrams":
    case "file-links":
    case "collaboration":
      return resolveModeCodingGuidanceFragment(previousRecipe.mode, fragmentId);
    case "engineering-judgment":
      return DEEP_ENGINEERING_JUDGMENT;
    case "mode-posture":
      return previousRecipe.postureSections === "" ? undefined : previousRecipe.postureSections;
    case "response-style":
      return `${MMR_RESPONSE_STYLE_HEADING}\n\n${previousRecipe.closingLine}`;
    case "identity":
    case "tool-lead-in":
    case "active-tools":
    case "active-guidelines":
    case "builtin-tool-guidance":
    case "using-workers":
    case "pi-docs":
    case "preserved-tail":
      return undefined;
    default: {
      const exhaustive: never = fragmentId;
      return exhaustive;
    }
  }
}

function renderPostPiDocsMmrTail(previousRecipe: MmrModePromptRecipe): string {
  const piDocsIndex = previousRecipe.fragments.indexOf("pi-docs");
  if (piDocsIndex === -1) return "";
  const tailFragments = previousRecipe.fragments.slice(piDocsIndex + 1);
  const ownedTail = tailFragments
    .map((fragmentId) => renderMmrOwnedTailFragment(fragmentId, previousRecipe))
    .filter((fragmentText): fragmentText is string => fragmentText !== undefined)
    .join("\n\n");
  let lastOwnedTailFragment: MmrPromptFragmentId | undefined;
  for (let i = tailFragments.length - 1; i >= 0; i -= 1) {
    const fragmentId = tailFragments[i];
    if (fragmentId === undefined) continue;
    if (renderMmrOwnedTailFragment(fragmentId, previousRecipe) === undefined) continue;
    lastOwnedTailFragment = fragmentId;
    break;
  }
  return lastOwnedTailFragment === undefined || lastOwnedTailFragment === "response-style"
    ? ownedTail
    : `${ownedTail}\n\n`;
}

function renderPostureFirstMmrTail(previousRecipe: MmrModePromptRecipe): string {
  const tailFragments: MmrPromptFragmentId[] = ["shared-tool-guidance"];
  if (previousRecipe.fragments.includes("diagrams")) tailFragments.push("diagrams");
  tailFragments.push("file-links", "collaboration", "response-style");
  return tailFragments
    .map((fragmentId) => renderMmrOwnedTailFragment(fragmentId, previousRecipe))
    .filter((fragmentText): fragmentText is string => fragmentText !== undefined)
    .join("\n\n");
}

function renderLegacyMmrTail(previousRecipe: MmrModePromptRecipe): string {
  const codingGuidance = previousRecipe.fragments
    .filter((fragmentId) => Object.hasOwn(SHARED_CODING_GUIDANCE_FRAGMENTS, fragmentId))
    .map((fragmentId) => SHARED_CODING_GUIDANCE_FRAGMENTS[fragmentId as keyof typeof SHARED_CODING_GUIDANCE_FRAGMENTS])
    .join("\n\n");
  return `${SHARED_TOOL_GUIDANCE}\n\n${codingGuidance}\n\n${previousRecipe.postureSections}\n\n${MMR_RESPONSE_STYLE_HEADING}\n\n${previousRecipe.closingLine}`;
}

/**
 * Exact-text reconstruction of MMR-owned blocks that sit immediately after
 * Pi's docs block for every known mode template. Used to detect and strip a
 * previously-injected MMR tail when `assembleActiveSurface` re-runs on an
 * already-assembled prompt, so the blocks are replaced rather than duplicated.
 * Mode-independent: the parent prompt fed into a re-assembly may have been
 * produced for a different mode (e.g. a `deep` parent aliased to a `smart` Task
 * base). Includes the legacy all-posture tail shape so already-captured parent
 * prompts from older `pi-mmr` versions still strip cleanly.
 */
const PREVIOUS_MMR_TAILS: readonly string[] = [
  ...new Set(
    Object.values(MMR_MODE_PROMPT_RECIPES)
      .flatMap((previousRecipe) => [
        renderPostPiDocsMmrTail(previousRecipe),
        renderPostureFirstMmrTail(previousRecipe),
        renderLegacyMmrTail(previousRecipe),
      ])
      .filter((tail) => tail.length > 0),
  ),
].sort((a, b) => b.length - a.length);

/**
 * Locate the end of a previously-injected MMR tail that sits immediately
 * after Pi's docs block. Returns the byte offset just past the prior mode's
 * closing line (the start of Pi's preserved tail), or `undefined` when the
 * base prompt has not already been MMR-assembled. Matches by exact tail
 * text so a preserved Pi tail that merely contains a heading like
 * `## Response style` cannot trigger a false strip.
 */
function findPreviousMmrTailEnd(base: string, docsEnd: number): number | undefined {
  if (!base.startsWith(MMR_TAIL_SEPARATOR, docsEnd)) return undefined;
  const tailStart = docsEnd + MMR_TAIL_SEPARATOR.length;
  for (const previousTail of PREVIOUS_MMR_TAILS) {
    if (!base.startsWith(previousTail, tailStart)) continue;
    const end = tailStart + previousTail.length;
    // Pi's preserved tail is either empty or starts at a newline boundary
    // (`\n\n...` normal tail, or `\nCurrent date:` minimal Pi tail).
    if (end === base.length || base[end] === "\n") return end;
  }
  return undefined;
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

type PromptedMmrModeKey = Exclude<MmrModeKey, "open" | "free">;

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
  // duplicates every long MMR instruction. With the easter-egg fragment
  // removed, `response-style` is the last MMR-owned fragment before Pi's
  // preserved tail, so the previously-injected MMR tail is detected by an
  // exact structural match (see `findPreviousMmrTailEnd`).
  const headEnd = findPreviousMmrTailEnd(base, docsEnd) ?? docsEnd;

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
  const usingWorkersText = buildUsingWorkersGuidance(
    input.activeToolNames ?? extractActiveWorkerToolNames(toolsBlockText),
  );

  // Each fragment owns its trailing separators so that concatenating all
  // rendered blocks reproduces the systemPrompt byte-for-byte.
  const renderFragment = (fragmentId: MmrPromptFragmentId, index: number): MmrPromptBlock | null => {
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
      case "using-workers":
        return usingWorkersText
          ? {
              id: "using-workers",
              kind: "using-workers",
              text: `${usingWorkersText}\n\n`,
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
      case "autonomy":
      case "discovery-discipline":
      case "pragmatism":
      case "verification":
      case "careful-actions":
      case "diagrams":
      case "file-links":
      case "collaboration":
        return {
          id: fragmentId,
          kind: fragmentId,
          text: `${resolveModeCodingGuidanceFragment(mode, fragmentId)}\n\n`,
          source: "mmr-core",
        };
      case "engineering-judgment":
        return {
          id: "engineering-judgment",
          kind: "engineering-judgment",
          text: `${DEEP_ENGINEERING_JUDGMENT}\n\n`,
          source: "mmr-core",
        };
      case "mode-posture":
        return recipe.postureSections === ""
          ? null
          : {
              id: `mode-posture:${mode}`,
              kind: "mode-posture",
              text: `${recipe.postureSections}\n\n`,
              source: "mmr-core",
            };
      case "response-style": {
        const isBeforePreservedTail = recipe.fragments[index + 1] === "preserved-tail";
        return {
          id: `response-style:${mode}`,
          kind: "response-style",
          text: `${MMR_RESPONSE_STYLE_HEADING}\n\n${recipe.closingLine}${isBeforePreservedTail ? "" : "\n\n"}`,
          source: "mmr-core",
        };
      }
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
    .map((fragmentId, index) => renderFragment(fragmentId, index))
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
