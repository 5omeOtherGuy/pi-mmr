/**
 * Pure, Pi-independent helpers for the mmr-debug capture extension.
 *
 * These functions extract the model-visible system prompt, tool names, and
 * assistant output from provider payloads / agent messages whose exact shape
 * varies by provider API. They are deliberately Pi-free so they can be unit
 * tested deterministically without a live provider or the host SDK.
 *
 * Provider payload shapes handled:
 *   - OpenAI Codex / Responses variant : `instructions` (string)
 *   - Anthropic Messages API           : `system` (string | text-block[])
 *   - OpenAI Responses public          : system text lives inside `input[]`
 *                                         messages with role `system`/`developer`
 */

export type MmrDebugSystemPromptSource = "instructions" | "system" | "input";

export interface MmrDebugSystemPrompt {
  source: MmrDebugSystemPromptSource;
  text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Flatten a provider content value into plain text.
 *
 * Content is either a bare string or an array of blocks. Text-bearing blocks
 * expose their text on `text` (Anthropic, OpenAI Responses input) or `content`
 * (some nested shapes); non-text blocks (tool_use, image, etc.) contribute
 * nothing so the result stays focused on human-readable prompt/output text.
 */
export function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (!isRecord(block)) continue;
    if (typeof block.text === "string") {
      parts.push(block.text);
    } else if (typeof block.content === "string") {
      parts.push(block.content);
    }
  }
  return parts.join("");
}

/**
 * Extract the assembled system prompt that the provider request carries.
 *
 * Returns `undefined` when no recognizable system text is present so the caller
 * can record the absence rather than an empty string. Precedence follows the
 * provider shapes most-specific-first: a dedicated `instructions`/`system`
 * field wins over reconstructing it from `input[]` role messages.
 */
export function extractSystemPrompt(payload: unknown): MmrDebugSystemPrompt | undefined {
  if (!isRecord(payload)) return undefined;

  if (typeof payload.instructions === "string") {
    return { source: "instructions", text: payload.instructions };
  }

  if (typeof payload.system === "string") {
    return { source: "system", text: payload.system };
  }
  if (Array.isArray(payload.system)) {
    const text = stringifyContent(payload.system);
    if (text.length > 0) return { source: "system", text };
  }

  if (Array.isArray(payload.input)) {
    const parts: string[] = [];
    for (const item of payload.input) {
      if (!isRecord(item)) continue;
      const role = typeof item.role === "string" ? item.role : "";
      if (role !== "system" && role !== "developer") continue;
      const text = stringifyContent(item.content);
      if (text.length > 0) parts.push(text);
    }
    if (parts.length > 0) return { source: "input", text: parts.join("\n\n") };
  }

  return undefined;
}

/**
 * Extract the tool names advertised in a provider request payload.
 *
 * Handles the Anthropic shape (`{ name }`) and the OpenAI function-tool shape
 * (`{ function: { name } }`). Order is preserved so callers can diff the
 * advertised tool surface across turns.
 */
export function extractToolNames(payload: unknown): string[] {
  if (!isRecord(payload) || !Array.isArray(payload.tools)) return [];
  const names: string[] = [];
  for (const tool of payload.tools) {
    if (!isRecord(tool)) continue;
    if (typeof tool.name === "string") {
      names.push(tool.name);
    } else if (isRecord(tool.function) && typeof tool.function.name === "string") {
      names.push(tool.function.name);
    }
  }
  return names;
}

export interface MmrDebugMessageSummary {
  role: string;
  text: string;
  stopReason?: string;
}

/**
 * Summarize a finalized agent message into role + flattened text (+ stop
 * reason when present). Used to record what the model actually produced.
 */
export function extractMessageSummary(message: unknown): MmrDebugMessageSummary | undefined {
  if (!isRecord(message)) return undefined;
  const role = typeof message.role === "string" ? message.role : "unknown";
  const summary: MmrDebugMessageSummary = {
    role,
    text: stringifyContent(message.content),
  };
  if (typeof message.stopReason === "string") summary.stopReason = message.stopReason;
  return summary;
}
