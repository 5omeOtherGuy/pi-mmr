import { homedir } from "node:os";
import { Container, Text } from "@earendil-works/pi-tui";
import { isRecord } from "../mmr-core/internal/json.js";
import type { MmrWorkerTrailItem } from "./runner.js";
import {
  compactOneLine,
  type BackgroundTaskDetails,
  type RenderContextLike,
  type SubagentProgressDetails,
  type SubagentTheme,
} from "./subagent-render-format.js";

function readStringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
}

export function operationLabel(
  toolName: string,
  details: SubagentProgressDetails | undefined,
  context: RenderContextLike | undefined,
): string | undefined {
  const args = context?.args;
  const fromArgs = toolName === "Task"
    ? readStringField(args, "description") ?? readStringField(args, "prompt")
    : toolName === "oracle"
      ? readStringField(args, "task")
      : readStringField(args, "query");
  return fromArgs
    ?? details?.description
    ?? details?.task
    ?? details?.query
    ?? details?.prompt;
}

export function expandedOperationLabel(
  toolName: string,
  details: SubagentProgressDetails | undefined,
  context: RenderContextLike | undefined,
): string | undefined {
  const args = context?.args;
  if (toolName === "Task") return readStringField(args, "prompt") ?? details?.prompt ?? operationLabel(toolName, details, context);
  if (toolName === "oracle") return readStringField(args, "task") ?? details?.task ?? operationLabel(toolName, details, context);
  return readStringField(args, "query") ?? details?.query ?? operationLabel(toolName, details, context);
}

export function operationLabelFromArgs(toolName: string, args: unknown): string | undefined {
  if (toolName === "Task") return readStringField(args, "description") ?? readStringField(args, "prompt");
  if (toolName === "oracle") return readStringField(args, "task");
  return readStringField(args, "query");
}

function normalizeStartTaskAgent(raw: unknown): string | undefined {
  if (raw === undefined) return "Task";
  if (typeof raw !== "string") return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "task" || normalized === "task-subagent") return "Task";
  if (normalized === "finder") return "finder";
  if (normalized === "librarian") return "librarian";
  return undefined;
}

function startTaskParamsFromArgs(args: unknown, agent: string): unknown {
  if (!isRecord(args)) return undefined;
  if (args.params !== undefined) return args.params;
  if (agent === "Task") {
    return { prompt: args.prompt, description: args.description };
  }
  const prompt = readStringField(args, "prompt");
  return prompt ? { query: prompt } : undefined;
}

function startTaskPromptFromArgs(args: unknown, agent: string): string | undefined {
  const params = startTaskParamsFromArgs(args, agent);
  if (agent === "Task") return readStringField(params, "prompt") ?? readStringField(args, "prompt");
  return readStringField(params, "query") ?? readStringField(args, "prompt");
}

function startTaskDescriptionFromArgs(args: unknown, agent: string, prompt: string | undefined): string | undefined {
  const params = startTaskParamsFromArgs(args, agent);
  return readStringField(args, "description")
    ?? (agent === "Task" ? readStringField(params, "description") : undefined)
    ?? `${agent}: ${prompt ? compactOneLine(prompt, 80) : "background run"}`;
}

export function startTaskDisplayFromArgs(args: unknown): { details: BackgroundTaskDetails; collapsed?: string; expanded?: string } | undefined {
  if (!isRecord(args)) return undefined;
  const agent = normalizeStartTaskAgent(args.agent);
  if (!agent) return undefined;
  const expanded = startTaskPromptFromArgs(args, agent);
  const collapsed = startTaskDescriptionFromArgs(args, agent, expanded);
  return {
    details: {
      worker: "mmr-subagents.async-task",
      tool: "start_task",
      agent,
      status: "running",
      description: collapsed,
      ...(expanded !== undefined ? { prompt: expanded } : {}),
    },
    collapsed,
    expanded,
  };
}

function parseArgsPreview(preview: string | undefined): unknown {
  if (!preview) return undefined;
  try {
    return JSON.parse(preview);
  } catch {
    return undefined;
  }
}

function unescapeJsonStringFragment(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value.replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  }
}

function readPreviewStringField(preview: string | undefined, key: string): string | undefined {
  if (!preview) return undefined;
  const match = new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)`).exec(preview);
  const value = match?.[1];
  if (value === undefined) return undefined;
  const decoded = unescapeJsonStringFragment(value).trim();
  return decoded.length > 0 ? decoded : undefined;
}

function readPreviewNumberField(preview: string | undefined, key: string): number | undefined {
  if (!preview) return undefined;
  const match = new RegExp(`"${key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`).exec(preview);
  if (!match?.[1]) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

function readPreviewBooleanField(preview: string | undefined, key: string): boolean | undefined {
  if (!preview) return undefined;
  const match = new RegExp(`"${key}"\\s*:\\s*(true|false)`).exec(preview);
  if (!match?.[1]) return undefined;
  return match[1] === "true";
}

function addStringArg(args: Record<string, unknown>, key: string, value: string | undefined): void {
  if (value !== undefined) args[key] = value;
}

function addNumberArg(args: Record<string, unknown>, key: string, value: number | undefined): void {
  if (value !== undefined) args[key] = value;
}

function addBooleanArg(args: Record<string, unknown>, key: string, value: boolean | undefined): void {
  if (value !== undefined) args[key] = value;
}

function extractedArgsFromPreview(toolName: string, preview: string | undefined): Record<string, unknown> | undefined {
  if (!preview) return undefined;
  const args: Record<string, unknown> = {};
  if (toolName === "read") {
    addStringArg(args, "path", readPreviewStringField(preview, "path") ?? readPreviewStringField(preview, "file_path"));
    addNumberArg(args, "offset", readPreviewNumberField(preview, "offset"));
    addNumberArg(args, "limit", readPreviewNumberField(preview, "limit"));
  } else if (toolName === "grep") {
    addStringArg(args, "pattern", readPreviewStringField(preview, "pattern"));
    addStringArg(args, "path", readPreviewStringField(preview, "path"));
    addStringArg(args, "glob", readPreviewStringField(preview, "glob"));
    addBooleanArg(args, "ignoreCase", readPreviewBooleanField(preview, "ignoreCase"));
    addBooleanArg(args, "literal", readPreviewBooleanField(preview, "literal"));
    addNumberArg(args, "context", readPreviewNumberField(preview, "context"));
    addNumberArg(args, "limit", readPreviewNumberField(preview, "limit"));
  } else if (toolName === "find") {
    addStringArg(args, "path", readPreviewStringField(preview, "path"));
    addStringArg(args, "pattern", readPreviewStringField(preview, "pattern"));
  } else if (toolName === "bash") {
    addStringArg(args, "command", readPreviewStringField(preview, "command"));
  } else if (toolName === "ls") {
    addStringArg(args, "path", readPreviewStringField(preview, "path"));
  }
  return Object.keys(args).length > 0 ? args : undefined;
}

export function structuredArgsFromPreview(toolName: string, preview: string | undefined): Record<string, unknown> | undefined {
  const parsed = parseArgsPreview(preview);
  if (isRecord(parsed)) return parsed;
  return extractedArgsFromPreview(toolName, preview);
}

function shortenPath(filePath: string): string {
  const home = homedir();
  if (home && filePath === home) return "~";
  if (home && filePath.startsWith(`${home}/`)) return `~${filePath.slice(home.length)}`;
  return filePath;
}

function formatLineRange(args: Record<string, unknown>): string {
  const offset = typeof args.offset === "number" && Number.isFinite(args.offset) ? Math.max(1, Math.floor(args.offset)) : undefined;
  const limit = typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.max(1, Math.floor(args.limit)) : undefined;
  if (offset === undefined && limit === undefined) return "";
  const start = offset ?? 1;
  const end = limit !== undefined ? start + limit - 1 : undefined;
  return end !== undefined && end !== start ? `:${start}-${end}` : `:${start}`;
}

function quoteForDisplay(value: string): string {
  return /\s/.test(value) ? JSON.stringify(value) : value;
}

export function formatToolArguments(item: Extract<MmrWorkerTrailItem, { type: "tool" }>): string {
  // Prefer structured args if available; fall back to parsing preview for legacy trails
  const parsed = isRecord(item.args) ? item.args : structuredArgsFromPreview(item.toolName, item.argsPreview);
  if (isRecord(parsed)) {
    if (item.toolName === "read") {
      const rawPath = readStringField(parsed, "path") ?? readStringField(parsed, "file_path");
      return rawPath ? `${shortenPath(rawPath)}${formatLineRange(parsed)}` : (item.argsPreview ?? "");
    }
    if (item.toolName === "bash") {
      return readStringField(parsed, "command") ?? item.argsPreview ?? "";
    }
    if (item.toolName === "grep") {
      const pattern = readStringField(parsed, "pattern");
      const path = readStringField(parsed, "path") ?? readStringField(parsed, "include");
      return [pattern ? quoteForDisplay(pattern) : undefined, path ? shortenPath(path) : undefined]
        .filter((part): part is string => part !== undefined && part.length > 0)
        .join(" ");
    }
    if (item.toolName === "find") {
      const path = readStringField(parsed, "path");
      const pattern = readStringField(parsed, "pattern");
      return [path ? shortenPath(path) : undefined, pattern ? quoteForDisplay(pattern) : undefined]
        .filter((part): part is string => part !== undefined && part.length > 0)
        .join(" ");
    }
  }
  return item.argsPreview ?? "";
}

function imageAttachmentText(count: number | undefined): string | undefined {
  if (!count || count <= 0) return undefined;
  return `${count} image${count === 1 ? "" : "s"} attached`;
}

export function addImageAttachmentNote(
  container: Container,
  count: number | undefined,
  theme: SubagentTheme,
  paddingX = 1,
): void {
  const images = imageAttachmentText(count);
  if (images) container.addChild(new Text(theme.fg("muted", images), paddingX, 0));
}

function normalizedForMatch(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function stripWorkerPromptPrefixes(value: string): string {
  let stripped = value.trim();
  while (/^Task:\s*/i.test(stripped)) {
    stripped = stripped.replace(/^Task:\s*/i, "");
  }
  return stripped;
}

export function workerPromptFromArgs(
  toolName: string,
  details: SubagentProgressDetails | undefined,
  context: RenderContextLike | undefined,
): string | undefined {
  const args = context?.args;
  if (toolName === "Task") return readStringField(args, "prompt") ?? details?.prompt;
  if (toolName === "oracle") return readStringField(args, "task") ?? details?.task;
  return readStringField(args, "query") ?? details?.query;
}

export function isWorkerPromptEcho(text: string, workerPrompt: string | undefined): boolean {
  const prompt = normalizedForMatch(stripWorkerPromptPrefixes(workerPrompt ?? ""));
  if (!prompt) return false;
  const candidate = normalizedForMatch(stripWorkerPromptPrefixes(text));
  if (candidate === prompt) return true;
  return candidate.startsWith(`${prompt} Context:`) || candidate.startsWith(`${prompt} Attached files:`);
}

function isDuplicateFinalOutput(text: string, output: string): boolean {
  const trailText = normalizedForMatch(text);
  const finalText = normalizedForMatch(output);
  if (!trailText || !finalText) return false;
  if (trailText === finalText) return true;
  return trailText.endsWith("…") && finalText.startsWith(trailText.slice(0, -1).trim());
}

export function finalAssistantTrailIndex(trail: readonly MmrWorkerTrailItem[], output: string): number | undefined {
  if (!output.trim()) return undefined;
  for (let index = trail.length - 1; index >= 0; index -= 1) {
    const item = trail[index];
    if (item?.type !== "assistant") continue;
    return isDuplicateFinalOutput(item.text, output) ? index : undefined;
  }
  return undefined;
}
