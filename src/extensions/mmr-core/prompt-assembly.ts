import {
  buildBuiltinToolGuidance,
  extractActiveBuiltinToolNames,
} from "./builtin-tool-guidance.js";
import { SHARED_CODING_GUIDANCE, SHARED_TOOL_GUIDANCE } from "./prompt-modules.js";
import { MMR_CTHULU_SUMMON_GATE, MMR_MODE_PROMPT_TEMPLATES } from "./prompt-templates.js";
import type {
  MmrActiveToolManifestEntry,
  MmrModeKey,
  MmrModeState,
  MmrPromptAssemblyResult,
  MmrPromptBlock,
} from "./types.js";

/**
 * Public mmr-core constants reused by the splice. Kept here so other modules
 * (debug renderer, tests) can reference them without re-deriving from
 * prompt.ts internals.
 */
export const MMR_IDENTITY_LINE =
  "You are an expert coding assistant operating inside pi, a coding agent harness.";

export const MMR_TOOL_USE_HEADING = "## Tool use";

export const MMR_TOOL_USE_POSTURE_LINE =
  "Use context first; reach for a tool only when it would change your answer. Run independent read-only calls in parallel; never parallelize edits to the same file. Avoid repeated reads of the same content.";

export const MMR_ADDITIONAL_TOOLS_LINE =
  "In addition to the tools above, you may have access to other custom tools depending on the project.";

export const MMR_RESPONSE_STYLE_HEADING = "## Response style";

/** Structural anchors for Pi's auto-emitted sections. See prompt.ts notes. */
const TOOLS_SECTION_ANCHOR = "\n\nAvailable tools:\n";
const GUIDELINES_SECTION_ANCHOR = "\n\nGuidelines:\n";
const PI_DOCS_SECTION_ANCHOR = "\n\nPi documentation (";
const DATE_TAIL_ANCHOR = "\nCurrent date:";

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
  /** Optional provider/model identifiers forwarded to the result. */
  provider?: string;
  model?: string;
}

function passthroughResult(input: AssembleActiveSurfaceInput): MmrPromptAssemblyResult {
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
  };
}

type PromptedMmrModeKey = Exclude<MmrModeKey, "free">;

function isPromptedMode(mode: string): mode is PromptedMmrModeKey {
  return mode in MMR_MODE_PROMPT_TEMPLATES;
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
  if (!isPromptedMode(mode)) return passthroughResult(input);

  const base = input.baseSystemPrompt;
  const introStart = base.indexOf(MMR_IDENTITY_LINE);
  if (introStart === -1) return passthroughResult(input);

  const toolsStart = findHeaderStart(base, TOOLS_SECTION_ANCHOR, introStart);
  const guidelinesStart = findHeaderStart(base, GUIDELINES_SECTION_ANCHOR, introStart);
  const piDocsStart = findHeaderStart(base, PI_DOCS_SECTION_ANCHOR, introStart);

  if (toolsStart === -1 || guidelinesStart === -1 || piDocsStart === -1) {
    return passthroughResult(input);
  }

  if (
    !(introStart < toolsStart && toolsStart < guidelinesStart && guidelinesStart < piDocsStart)
  ) {
    return passthroughResult(input);
  }

  const toolsEnd = base.indexOf("\n\n", toolsStart);
  const guidelinesEnd = base.indexOf("\n\n", guidelinesStart);
  if (toolsEnd === -1 || guidelinesEnd === -1) return passthroughResult(input);

  const docsBlankIdx = base.indexOf("\n\n", piDocsStart);
  const docsDateIdx = base.indexOf(DATE_TAIL_ANCHOR, piDocsStart);
  const docsEndCandidates = [docsBlankIdx, docsDateIdx].filter((idx) => idx !== -1);
  const docsEnd = docsEndCandidates.length === 0 ? base.length : Math.min(...docsEndCandidates);

  // `before_agent_start` handlers are chained. Mode-derived Task workers can
  // receive the parent prompt after mmr-core already assembled it, then call
  // this function again to rebuild the active-tools block for the child. In
  // that case, strip the previous MMR-owned shared/mode blocks and preserve
  // only Pi's docs block plus the original tail; otherwise repeated assembly
  // duplicates every long MMR instruction.
  const previousMmrGateStart = base.indexOf(MMR_CTHULU_SUMMON_GATE, docsEnd);
  const headEnd = previousMmrGateStart === -1
    ? docsEnd
    : previousMmrGateStart + MMR_CTHULU_SUMMON_GATE.length;

  const toolsContent = base.slice(toolsStart, toolsEnd);
  const guidelinesContent = base.slice(guidelinesStart, guidelinesEnd);
  const piDocumentationContent = base.slice(piDocsStart, docsEnd);

  const template = MMR_MODE_PROMPT_TEMPLATES[mode];
  const before = base.slice(0, introStart);
  const after = base.slice(headEnd);

  // Each block's text includes its own trailing separators so that
  // concatenating all blocks reproduces the systemPrompt byte-for-byte.
  const identityBlock: MmrPromptBlock = {
    id: `identity:${mode}`,
    kind: "identity",
    text: `${before}${MMR_IDENTITY_LINE} <mmr_mode name="${template.tag}">${template.intro}</mmr_mode>\n\n`,
    source: "mmr-core",
  };

  const toolLeadInBlock: MmrPromptBlock = {
    id: "tool-lead-in",
    kind: "tool-lead-in",
    text: `${MMR_TOOL_USE_HEADING}\n\n${MMR_TOOL_USE_POSTURE_LINE}\n\n`,
    source: "mmr-core",
  };

  const activeToolsBlock: MmrPromptBlock = {
    id: "active-tools",
    kind: "active-tools",
    text: `${toolsContent}\n\n${MMR_ADDITIONAL_TOOLS_LINE}\n\n`,
    source: "pi",
  };

  const activeGuidelinesBlock: MmrPromptBlock = {
    id: "active-guidelines",
    kind: "active-guidelines",
    text: `${guidelinesContent}\n\n`,
    source: "pi",
  };

  const builtinToolGuidanceText = buildBuiltinToolGuidance(
    extractActiveBuiltinToolNames(toolsContent),
  );
  const builtinToolGuidanceBlock: MmrPromptBlock | null = builtinToolGuidanceText
    ? {
        id: "builtin-tool-guidance",
        kind: "builtin-tool-guidance",
        text: `${builtinToolGuidanceText}\n\n`,
        source: "mmr-core",
      }
    : null;

  const piDocsBlock: MmrPromptBlock = {
    id: "pi-docs",
    kind: "pi-docs",
    text: `${piDocumentationContent}\n\n`,
    source: "pi",
  };

  const sharedToolGuidanceBlock: MmrPromptBlock = {
    id: "shared-tool-guidance",
    kind: "shared-tool-guidance",
    text: `${SHARED_TOOL_GUIDANCE}\n\n`,
    source: "mmr-core",
  };

  const sharedCodingGuidanceBlock: MmrPromptBlock = {
    id: "shared-coding-guidance",
    kind: "shared-coding-guidance",
    text: `${SHARED_CODING_GUIDANCE}\n\n`,
    source: "mmr-core",
  };

  const modePostureBlock: MmrPromptBlock = {
    id: `mode-posture:${mode}`,
    kind: "mode-posture",
    text: `${template.postureSections}\n\n${MMR_RESPONSE_STYLE_HEADING}\n\n${template.closingLine}\n\n${MMR_CTHULU_SUMMON_GATE}`,
    source: "mmr-core",
  };

  const preservedTailBlock: MmrPromptBlock = {
    id: "preserved-tail",
    kind: "preserved-tail",
    text: after,
    source: "pi",
  };

  const blocks: MmrPromptBlock[] = [
    identityBlock,
    toolLeadInBlock,
    activeToolsBlock,
    activeGuidelinesBlock,
    ...(builtinToolGuidanceBlock ? [builtinToolGuidanceBlock] : []),
    piDocsBlock,
    sharedToolGuidanceBlock,
    sharedCodingGuidanceBlock,
    modePostureBlock,
    preservedTailBlock,
  ];

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
