import type { MmrModeKey, MmrPromptBlockKind } from "./types.js";
import {
  MMR_MODE_PROMPT_TEMPLATES as AUTHORED_MODE_PROMPT_TEMPLATES,
  type MmrModeBlockTemplate,
} from "./prompt-content.js";

export const MMR_IDENTITY_LINE =
  "You are an expert coding assistant operating inside pi, a coding agent harness.";

export const MMR_TOOL_USE_HEADING = "## Tool use";

export const MMR_TOOL_USE_POSTURE_LINE =
  "Use context first; reach for a tool when it would change your answer — never guess what a tool can tell you. Run independent read-only calls in parallel; never parallelize edits to the same file. Don't re-read content you already have.";

export const MMR_ADDITIONAL_TOOLS_LINE =
  "In addition to the tools above, you may have access to other custom tools depending on the project.";

export const MMR_RESPONSE_STYLE_HEADING = "## Response style";

type PromptedMmrModeKey = Exclude<MmrModeKey, "open" | "free">;

export type MmrPromptBaseId = "pi-native-default-v1";

export interface MmrPromptBaseDefinition {
  id: MmrPromptBaseId;
  /**
   * Anchor emitted by Pi's native default prompt. MMR replaces this head
   * only after Pi has already assembled tools, guidelines, docs, context,
   * skills, append prompts, date, and cwd.
   */
  identityLine: string;
  /** Section anchors for the Pi-rendered prompt layout this base supports. */
  toolsSectionAnchor: string;
  guidelinesSectionAnchor: string;
  piDocsSectionAnchor: string;
  dateTailAnchor: string;
  /** Human-facing summary for diagnostics/tests; never rendered to the model. */
  summary: string;
}

export type MmrPromptFragmentId =
  | "identity"
  | "tool-lead-in"
  | "active-tools"
  | "active-guidelines"
  | "builtin-tool-guidance"
  | "using-workers"
  | "pi-docs"
  | "shared-tool-guidance"
  | "autonomy"
  | "discovery-discipline"
  | "pragmatism"
  | "engineering-judgment"
  | "verification"
  | "careful-actions"
  | "diagrams"
  | "file-links"
  | "collaboration"
  | "mode-posture"
  | "response-style"
  | "preserved-tail";

export interface MmrPromptFragmentDefinition {
  id: MmrPromptFragmentId;
  blockKind: MmrPromptBlockKind;
  source: "mmr-core" | "pi";
  /** True when the text is extracted from Pi's already-rendered prompt. */
  piNative?: true;
  /** True when the renderer may omit the fragment for this turn. */
  optional?: true;
  /** Human-facing summary for tests/debugging; never rendered to the model. */
  summary: string;
}

export interface MmrModePromptRecipe extends MmrModeBlockTemplate {
  mode: PromptedMmrModeKey;
  basePromptId: MmrPromptBaseId;
  fragments: readonly MmrPromptFragmentId[];
}

export const MMR_PROMPT_BASES = {
  "pi-native-default-v1": {
    id: "pi-native-default-v1",
    identityLine: MMR_IDENTITY_LINE,
    toolsSectionAnchor: "\n\nAvailable tools:\n",
    guidelinesSectionAnchor: "\n\nGuidelines:\n",
    piDocsSectionAnchor: "\n\nPi documentation (",
    dateTailAnchor: "\nCurrent date:",
    summary:
      "Pi's native default coding-agent prompt, consumed after Pi renders tools, guidelines, docs, append prompts, context files, skills, date, and cwd.",
  },
} satisfies Record<MmrPromptBaseId, MmrPromptBaseDefinition>;

export const MMR_DEFAULT_PROMPT_FRAGMENT_SEQUENCE = [
  "identity",
  "autonomy",
  "discovery-discipline",
  "pragmatism",
  "verification",
  "careful-actions",
  "mode-posture",
  "collaboration",
  "response-style",
  "tool-lead-in",
  "active-tools",
  "active-guidelines",
  "builtin-tool-guidance",
  "using-workers",
  "pi-docs",
  "shared-tool-guidance",
  "diagrams",
  "file-links",
  "preserved-tail",
] as const satisfies readonly MmrPromptFragmentId[];

/**
 * Deep reorders the body to the authoritative deep-template sequence
 * (autonomy, pragmatism, discovery, engineering judgment, verification) and is
 * the only mode that renders the deep-only `engineering-judgment` fragment.
 */
export const MMR_DEEP_PROMPT_FRAGMENT_SEQUENCE = [
  "identity",
  "autonomy",
  "pragmatism",
  "discovery-discipline",
  "engineering-judgment",
  "verification",
  "careful-actions",
  "mode-posture",
  "collaboration",
  "response-style",
  "tool-lead-in",
  "active-tools",
  "active-guidelines",
  "builtin-tool-guidance",
  "using-workers",
  "pi-docs",
  "shared-tool-guidance",
  "diagrams",
  "file-links",
  "preserved-tail",
] as const satisfies readonly MmrPromptFragmentId[];

/**
 * Rush trims the diagrams fragment from the shared coding guidance. Rush
 * optimizes for latency and token economy with terse output, so the
 * multi-line box-drawing example is the lowest-value shared section for it.
 * Every other shared coding fragment (autonomy, discovery, pragmatism,
 * verification, careful actions, file links, collaboration) is retained.
 */
export const MMR_RUSH_PROMPT_FRAGMENT_SEQUENCE = MMR_DEFAULT_PROMPT_FRAGMENT_SEQUENCE.filter(
  (fragmentId) => fragmentId !== "diagrams",
) as readonly MmrPromptFragmentId[];

/**
 * Forces every registry entry to keep its key, `id`, and `blockKind` identical,
 * so the duplicated fragment-id vocabulary across `prompt-content.ts`,
 * `prompt-registry.ts`, `types.ts`, and `prompt-assembly.ts` cannot drift
 * silently (a mismatched key/id/blockKind fails `tsc`).
 */
type MmrPromptFragmentDefinitionMap = {
  [K in MmrPromptFragmentId]: Omit<MmrPromptFragmentDefinition, "id" | "blockKind"> & {
    id: K;
    blockKind: Extract<MmrPromptBlockKind, K>;
  };
};

export const MMR_PROMPT_FRAGMENTS = {
  identity: {
    id: "identity",
    blockKind: "identity",
    source: "mmr-core",
    summary: "MMR role line plus mode tag and mode-specific intro.",
  },
  "tool-lead-in": {
    id: "tool-lead-in",
    blockKind: "tool-lead-in",
    source: "mmr-core",
    summary: "Short MMR-owned tool-use posture that precedes Pi's tool inventory.",
  },
  "active-tools": {
    id: "active-tools",
    blockKind: "active-tools",
    source: "pi",
    piNative: true,
    summary: "Pi's native Available tools block, passed through byte-for-byte.",
  },
  "active-guidelines": {
    id: "active-guidelines",
    blockKind: "active-guidelines",
    source: "pi",
    piNative: true,
    summary: "Pi's native Guidelines block, passed through byte-for-byte.",
  },
  "builtin-tool-guidance": {
    id: "builtin-tool-guidance",
    blockKind: "builtin-tool-guidance",
    source: "mmr-core",
    optional: true,
    summary: "MMR-owned augmentation for active Pi built-in tools; omitted when no curated built-in is active.",
  },
  "using-workers": {
    id: "using-workers",
    blockKind: "using-workers",
    source: "mmr-core",
    optional: true,
    summary: "MMR-owned cross-worker policy block (delegation, blocking vs background, fan-out, result delivery); omitted when no worker tool is active.",
  },
  "pi-docs": {
    id: "pi-docs",
    blockKind: "pi-docs",
    source: "pi",
    piNative: true,
    summary: "Pi's native documentation path guidance block, passed through byte-for-byte.",
  },
  "shared-tool-guidance": {
    id: "shared-tool-guidance",
    blockKind: "shared-tool-guidance",
    source: "mmr-core",
    summary: "Shared pi-mmr tool-execution policy for all prompted locked modes.",
  },
  autonomy: {
    id: "autonomy",
    blockKind: "autonomy",
    source: "mmr-core",
    summary: "Shared autonomy-and-persistence guidance: definition of done, default-to-action, leave others' changes alone.",
  },
  "discovery-discipline": {
    id: "discovery-discipline",
    blockKind: "discovery-discipline",
    source: "mmr-core",
    summary: "Shared discovery-discipline guidance: read to resolve a specific uncertainty, then stop.",
  },
  pragmatism: {
    id: "pragmatism",
    blockKind: "pragmatism",
    source: "mmr-core",
    summary: "Shared pragmatism-and-scope guidance: smallest correct change, avoid one-use abstractions.",
  },
  "engineering-judgment": {
    id: "engineering-judgment",
    blockKind: "engineering-judgment",
    source: "mmr-core",
    summary: "Deep-only engineering-judgment guidance: choose conservatively when implementation details are open, scale test coverage with blast radius.",
  },
  verification: {
    id: "verification",
    blockKind: "verification",
    source: "mmr-core",
    summary: "Shared verification guidance: scale checks to risk, report honestly, never fake green.",
  },
  "careful-actions": {
    id: "careful-actions",
    blockKind: "careful-actions",
    source: "mmr-core",
    summary: "Shared careful-actions guidance: confirm before destructive, hard-to-reverse, or externally visible actions.",
  },
  diagrams: {
    id: "diagrams",
    blockKind: "diagrams",
    source: "mmr-core",
    summary: "Shared diagrams guidance: raw box-drawing diagrams, no Mermaid, no diagram code fences.",
  },
  "file-links": {
    id: "file-links",
    blockKind: "file-links",
    source: "mmr-core",
    summary: "Shared file-links guidance: fluent Markdown file:// links, URL-encode specials.",
  },
  collaboration: {
    id: "collaboration",
    blockKind: "collaboration",
    source: "mmr-core",
    summary: "Shared working-with-the-user guidance: newest message refines the spec, honor non-conflicting requests.",
  },
  "mode-posture": {
    id: "mode-posture",
    blockKind: "mode-posture",
    source: "mmr-core",
    summary: "Mode-specific posture section selected by the active mode recipe.",
  },
  "response-style": {
    id: "response-style",
    blockKind: "response-style",
    source: "mmr-core",
    summary: "Mode-specific response-style closing under the shared response-style heading.",
  },
  "preserved-tail": {
    id: "preserved-tail",
    blockKind: "preserved-tail",
    source: "pi",
    piNative: true,
    summary: "Everything after the replaced Pi head: append prompt tail, project context, skills, date, cwd, and later extension content.",
  },
} satisfies MmrPromptFragmentDefinitionMap;

function recipe(
  mode: PromptedMmrModeKey,
  fragments: readonly MmrPromptFragmentId[] = MMR_DEFAULT_PROMPT_FRAGMENT_SEQUENCE,
): MmrModePromptRecipe {
  const template = AUTHORED_MODE_PROMPT_TEMPLATES[mode];
  return {
    mode,
    basePromptId: "pi-native-default-v1",
    tag: template.tag,
    intro: template.intro,
    postureSections: template.postureSections,
    closingLine: template.closingLine,
    fragments,
  };
}

export const MMR_MODE_PROMPT_RECIPES = {
  smart: recipe("smart"),
  smartGPT: recipe("smartGPT"),
  smartSonnet: recipe("smartSonnet"),
  rush: recipe("rush", MMR_RUSH_PROMPT_FRAGMENT_SEQUENCE),
  test: recipe("test", MMR_RUSH_PROMPT_FRAGMENT_SEQUENCE),
  large: recipe("large"),
  deep: recipe("deep", MMR_DEEP_PROMPT_FRAGMENT_SEQUENCE),
} satisfies Record<PromptedMmrModeKey, MmrModePromptRecipe>;

function templateFromRecipe(recipe: MmrModePromptRecipe): MmrModeBlockTemplate {
  return {
    tag: recipe.tag,
    intro: recipe.intro,
    postureSections: recipe.postureSections,
    closingLine: recipe.closingLine,
  };
}

export const MMR_MODE_PROMPT_TEMPLATES = {
  smart: templateFromRecipe(MMR_MODE_PROMPT_RECIPES.smart),
  smartGPT: templateFromRecipe(MMR_MODE_PROMPT_RECIPES.smartGPT),
  smartSonnet: templateFromRecipe(MMR_MODE_PROMPT_RECIPES.smartSonnet),
  rush: templateFromRecipe(MMR_MODE_PROMPT_RECIPES.rush),
  test: templateFromRecipe(MMR_MODE_PROMPT_RECIPES.test),
  large: templateFromRecipe(MMR_MODE_PROMPT_RECIPES.large),
  deep: templateFromRecipe(MMR_MODE_PROMPT_RECIPES.deep),
} satisfies Record<PromptedMmrModeKey, MmrModeBlockTemplate>;

export function getMmrModePromptRecipe(mode: string): MmrModePromptRecipe | undefined {
  return Object.prototype.hasOwnProperty.call(MMR_MODE_PROMPT_RECIPES, mode)
    ? MMR_MODE_PROMPT_RECIPES[mode as PromptedMmrModeKey]
    : undefined;
}

export function getMmrPromptBase(id: MmrPromptBaseId): MmrPromptBaseDefinition {
  return MMR_PROMPT_BASES[id];
}
