import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { SessionManager, type SessionInfo, type SessionManager as SessionManagerType } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { registerMmrOwnedTool } from "../mmr-core/owned-tools.js";
import type { LoadedMmrCoreSettings } from "../mmr-core/settings.js";
import { checkMmrToolParams } from "../mmr-core/tool-params.js";
import type { MmrSubagentRunner } from "../mmr-subagents/runner.js";
import {
  runHistoryReaderAnalysis,
  type HistoryAnalysisMode,
  type HistoryReaderWorkerDetails,
} from "./analysis-worker.js";
import type { MmrHistorySettings } from "./config.js";
import { createGitIdentityResolver } from "./git-identity.js";
import { formatSessionReadResult, readSessionForGoal, type SessionReadResult } from "./read-session.js";
import { projectRefFromCwd, redactText } from "./redaction.js";
import {
  resolveSessionById,
  searchSessionsWithDiagnostics,
  type QueryDiagnostic,
  type SessionCatalogDeps,
  type SessionSearchMatch,
} from "./session-catalog.js";
import { createSessionIndex, type SessionIndex } from "./session-index.js";
import {
  renderMmrHistoryCall,
  renderMmrHistoryResult,
} from "./progress-rendering.js";

export interface MmrHistoryToolDeps extends SessionCatalogDeps {
  getSettings(): MmrHistorySettings;
  /**
   * Optional shared {@link SessionIndex}. The default-deps factory
   * constructs one so the index's TTL cache engages across repeated
   * `find_session` / `read_session` calls in the same process.
   */
  sessionIndex?: SessionIndex;
  analysisRunner?: MmrSubagentRunner;
  loadCoreSettings?: (cwd: string) => Pick<LoadedMmrCoreSettings, "settings">;
}

/**
 * Scope marker on `find_session` result details. Surfaced as a string
 * literal rather than a boolean so consumers can future-proof against a
 * later scope expansion (e.g. per-host indexes) without changing the
 * field type.
 */
export type FindSessionScope = "all_sessions";

export interface FindSessionDetails {
  query: string;
  resultCount: number;
  scope: FindSessionScope;
  matches: SessionSearchMatch[];
  queryDiagnostics: QueryDiagnostic[];
  /** Soft warnings for deprecated input keys; empty in the common case. */
  warnings?: string[];
}

export interface ReadSessionDetails extends SessionReadResult {
  scope: FindSessionScope;
  /** Opaque 8-char hex hash of the matched session's project cwd. */
  projectRef: string;
  analysisUsed: HistoryAnalysisMode;
  analysisFallbackReason?: string;
  worker?: HistoryReaderWorkerDetails;
  /** Soft warnings for deprecated input keys; empty in the common case. */
  warnings?: string[];
}

export const FIND_SESSION_PARAMETERS_SCHEMA = Type.Object(
  {
    query: Type.String({
      description:
        "Search query for local Pi sessions across every project cwd Pi has recorded on disk. Supports bare keywords, quoted phrases, id:, name:, after:, before:, file:, and repo: filters. file: and repo: are evaluated per session against that session's own cwd and git remote, not against the active workspace. Unknown filters and filters that cannot be evaluated against any candidate session are reported in queryDiagnostics. Results carry an opaque projectRef per match; raw session file paths and project roots are never surfaced.",
    }),
    limit: Type.Optional(
      Type.Number({
        description: "Maximum number of sessions to return. Defaults to the mmr-history configured limit and is capped by the extension.",
      }),
    ),
  },
  { additionalProperties: false },
);

export const READ_SESSION_PARAMETERS_SCHEMA = Type.Object(
  {
    sessionId: Type.Optional(
      Type.String({
        description: "Canonical Pi session identifier, @session-id reference, or unique session-id prefix from find_session results; required (or provide legacy threadID for one slice). Raw session file paths are not accepted.",
      }),
    ),
    goal: Type.String({
      description: "A clear description of what information to extract from the session. Be specific about the plan, files, decisions, or errors you need.",
    }),
    model: Type.Optional(
      Type.String({
        description: "Optional per-call worker model route for the history-reader subagent, such as provider/model-id. Ignored when the worker cannot be reached and the call falls back to deterministic lexical extraction.",
      }),
    ),
  },
  { additionalProperties: false },
);

const READ_SESSION_COMPAT_PARAMETERS_SCHEMA = Type.Object(
  {
    sessionId: Type.Optional(Type.String()),
    threadID: Type.Optional(Type.String()),
    goal: Type.String(),
    model: Type.Optional(Type.String()),
    analysis: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const findSessionParameters = FIND_SESSION_PARAMETERS_SCHEMA;
export const readSessionParameters = READ_SESSION_PARAMETERS_SCHEMA;

type ReadSessionCompatParams = Static<typeof READ_SESSION_COMPAT_PARAMETERS_SCHEMA>;

export const FIND_SESSION_DESCRIPTION = `Find prior Pi sessions across every local project on disk using a small query DSL.

Use this when the user asks about prior Pi conversations, sessions, or work history — including history from another project on the same machine. Do not use this for git commit history, blame, or who changed a file; use git commands for those questions.

Supported query syntax: bare keywords and quoted phrases for text search; id:<prefix>; name:<text>; after:<YYYY-MM-DD|7d|2w>; before:<YYYY-MM-DD|7d|2w>; file:<partial-path> (matches against structured tool-call evidence only — read/edit/write/apply_patch — interpreted per-session relative to that session's own cwd); repo:<value> where <value> is one of host/owner/repo, owner/repo, or the credential-stripped remote URL (matched against each candidate session's git remote, not just the active workspace). Matching is case-insensitive. Unknown filters are reported as \`unsupported\`; filters that cannot be evaluated against any candidate session are reported as \`non_applicable\`. Results carry an opaque \`projectRef\` per match; raw session file paths and project roots are never surfaced.`;

export const READ_SESSION_DESCRIPTION = `Read a prior Pi session and extract content relevant to a stated goal.

Use this after find_session returns a relevant session, or when the user gives a Pi session id/prefix and asks to reuse a plan, decisions, files, errors, or implementation approach from that session — including a session from another project. Do not use this when the needed context is already in the current conversation. Raw session file paths are not accepted.

The tool sends a deterministically redacted session packet to the in-process \`history-reader\` subagent, which has no tool allowlist. If the worker route is unauthenticated, missing, cancelled, or empty, the tool falls back to redacted lexical extraction and sets \`details.analysisFallbackReason\`.`;

export const FIND_SESSION_PROMPT_SNIPPET = "Search local Pi sessions across every project on disk by keywords, id/name filters, date filters, file:, and repo:";
export const READ_SESSION_PROMPT_SNIPPET = "Read any local Pi session by id/prefix and return goal-focused excerpts from the redacted history-reader worker (with lexical fallback)";

function coerceObject(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

function coerceQuery(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

function coerceLimit(raw: unknown, settings: MmrHistorySettings): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return settings.maxResults;
  return Math.max(1, Math.min(Math.trunc(raw), settings.maxResults));
}

function coerceOptionalModel(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

function trimString(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * Pull the Pi-native read_session params out of the request and
 * collect deprecation warnings in a deterministic order. `sessionId`
 * is the canonical field; legacy `threadID` is still accepted for one
 * slice but always logs a deprecation warning when present, even when
 * `sessionId` is also supplied and takes precedence.
 */
function coerceReadSessionParams(raw: ReadSessionCompatParams): {
  sessionId: string;
  goal: string;
  model: string | undefined;
  warnings: string[];
} {
  const sessionId = trimString(raw.sessionId);
  const threadID = trimString(raw.threadID);
  const goal = trimString(raw.goal);
  const model = coerceOptionalModel(raw.model);
  const warnings: string[] = [];
  if ("analysis" in raw) {
    warnings.push("'analysis' is no longer accepted; read_session always tries the history-reader worker first and falls back to lexical extraction on failure.");
  }
  if (threadID) {
    warnings.push("'threadID' is deprecated; pass 'sessionId' instead.");
  }
  return { sessionId: sessionId || threadID, goal, model, warnings };
}

function formatDiagnosticsLines(diagnostics: readonly QueryDiagnostic[]): string[] {
  const applied = diagnostics.filter((d) => d.status === "applied").map((d) => d.filter);
  const unsupported = diagnostics.filter((d) => d.status === "unsupported").map((d) => d.filter);
  const nonApplicable = diagnostics.filter((d) => d.status === "non_applicable").map((d) => d.filter);
  const invalid = diagnostics.filter((d) => d.status === "invalid").map((d) => d.filter);
  const lines: string[] = [];
  if (applied.length > 0) lines.push(`Applied filters: ${applied.join(", ")}`);
  if (unsupported.length > 0) lines.push(`Unsupported filters: ${unsupported.join(", ")}`);
  if (nonApplicable.length > 0) lines.push(`Non-applicable filters: ${nonApplicable.join(", ")}`);
  if (invalid.length > 0) lines.push(`Invalid date filters ignored: ${invalid.join(", ")}`);
  return lines;
}

function formatFindSessionResults(
  query: string,
  matches: readonly SessionSearchMatch[],
  diagnostics: readonly QueryDiagnostic[],
): string {
  const lines = [`# Session search results for: ${redactText(query)}`];
  const diagnosticLines = formatDiagnosticsLines(diagnostics);
  if (diagnosticLines.length > 0) lines.push(...diagnosticLines);
  lines.push("");
  if (matches.length === 0) {
    lines.push("No local Pi session matched the query.");
    return lines.join("\n");
  }
  matches.forEach((match, index) => {
    lines.push(`## ${index + 1}. ${match.name ?? "(unnamed session)"}`);
    lines.push(`Session: ${match.sessionId}`);
    if (match.projectRef) lines.push(`Project: ${match.projectRef}`);
    lines.push(`Modified: ${match.modifiedAt}`);
    lines.push(`Messages: ${match.messageCount}`);
    if (match.matchedTerms.length > 0) lines.push(`Matched terms: ${match.matchedTerms.join(", ")}`);
    if (match.unsupportedFilters.length > 0) lines.push(`Unsupported filters ignored: ${match.unsupportedFilters.join(", ")}`);
    if (match.preview) {
      lines.push("");
      lines.push(match.preview);
    }
    lines.push("");
  });
  return lines.join("\n").trimEnd();
}

export function createDefaultMmrHistoryToolDeps(getSettings: () => MmrHistorySettings): MmrHistoryToolDeps {
  const listSessions = (): Promise<SessionInfo[]> => SessionManager.listAll();
  const openSession = (path: string): SessionManagerType => SessionManager.open(path);
  // Single shared index so the built-in TTL cache actually engages
  // across repeated calls; without this, every tool invocation built
  // a fresh index and the cache never survived past one call.
  const sessionIndex = createSessionIndex({ listSessions, openSession });
  return {
    getSettings,
    listSessions,
    openSession,
    sessionIndex,
    gitIdentity: createGitIdentityResolver(),
  };
}

function lexicalReadDetails(info: SessionInfo, result: SessionReadResult, fallbackReason: string | undefined, warnings: readonly string[]): ReadSessionDetails {
  return {
    ...result,
    scope: "all_sessions",
    projectRef: projectRefFromCwd(info.cwd || ""),
    analysisUsed: "lexical",
    // Worker-side fallback reasons are already routed through
    // `redactText`, but defense-in-depth: redact again here so a
    // future caller wiring in a different worker path still cannot
    // surface a raw error string on `details.analysisFallbackReason`.
    // Idempotent.
    ...(fallbackReason ? { analysisFallbackReason: redactText(fallbackReason) } : {}),
    ...(warnings.length > 0 ? { warnings: [...warnings] } : {}),
  };
}

function workerReadDetails(info: SessionInfo, worker: HistoryReaderWorkerDetails, warnings: readonly string[]): ReadSessionDetails {
  return {
    sessionId: info.id,
    name: info.name ? redactText(info.name) : undefined,
    messageCount: info.messageCount,
    excerptCount: 0,
    truncated: worker.outputTruncated,
    matchedTerms: [],
    excerpts: [],
    scope: "all_sessions",
    projectRef: projectRefFromCwd(info.cwd || ""),
    analysisUsed: "worker",
    worker,
    ...(warnings.length > 0 ? { warnings: [...warnings] } : {}),
  };
}

function readLexical(info: SessionInfo, manager: SessionManagerType, goal: string, settings: MmrHistorySettings, fallbackReason: string | undefined, warnings: readonly string[]): AgentToolResult<ReadSessionDetails> {
  const result = readSessionForGoal(info, manager, goal, settings.maxExcerptBytes);
  return {
    content: [{ type: "text", text: formatSessionReadResult(result, goal) }],
    details: lexicalReadDetails(info, result, fallbackReason, warnings),
  };
}

/**
 * Worker-first read. Always attempts `runHistoryReaderAnalysis` and
 * falls back to deterministic lexical extraction (with the same
 * deterministic redaction applied) only when the worker reports
 * failure: no auth/route, cancelled, empty output, packet too large,
 * runner exception, etc. Pure dispatch; the worker decides
 * fallback-vs-success.
 */
async function readWithWorkerThenLexical(
  deps: MmrHistoryToolDeps,
  settings: MmrHistorySettings,
  info: SessionInfo,
  manager: SessionManagerType,
  goal: string,
  explicitModel: string | undefined,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
  warnings: readonly string[],
): Promise<AgentToolResult<ReadSessionDetails>> {
  const workerResult = await runHistoryReaderAnalysis({
    info,
    manager,
    goal,
    cwd: ctx.cwd,
    explicitModel,
    ctx,
    signal,
    runner: deps.analysisRunner,
    loadCoreSettings: deps.loadCoreSettings,
  });
  if (!workerResult.ok) return readLexical(info, manager, goal, settings, workerResult.fallbackReason, warnings);
  return {
    content: [{ type: "text", text: workerResult.text }],
    details: workerReadDetails(info, workerResult.details, warnings),
  };
}

const FIND_SESSION_TOOL_NAME = "find_session";
const READ_SESSION_TOOL_NAME = "read_session";

export function createFindSessionTool(deps: MmrHistoryToolDeps): ToolDefinition {
  return {
    name: FIND_SESSION_TOOL_NAME,
    label: FIND_SESSION_TOOL_NAME,
    description: FIND_SESSION_DESCRIPTION,
    promptSnippet: FIND_SESSION_PROMPT_SNIPPET,
    parameters: findSessionParameters,
    renderCall(args, theme) {
      return renderMmrHistoryCall(FIND_SESSION_TOOL_NAME, args, theme);
    },
    renderResult(result, options, theme, context) {
      return renderMmrHistoryResult(FIND_SESSION_TOOL_NAME, result, options, theme, context);
    },
    async execute(_toolCallId, rawParams, _signal, _onUpdate, _ctx): Promise<AgentToolResult<FindSessionDetails>> {
      const settings = deps.getSettings();
      if (!settings.enabled) throw new Error("find_session is unavailable: set MMR_HISTORY_ENABLE=true to enable global local Pi session lookup.");
      const params = coerceObject(rawParams);
      const query = coerceQuery(params.query);
      if (!query) throw new Error("find_session requires a non-empty query.");
      if (Number.isFinite(params.limit) || params.limit === undefined) {
        checkMmrToolParams(FIND_SESSION_TOOL_NAME, FIND_SESSION_PARAMETERS_SCHEMA, params);
      }
      const limit = coerceLimit(params.limit, settings);
      const { matches, queryDiagnostics } = await searchSessionsWithDiagnostics(deps, query, {
        limit,
        index: deps.sessionIndex,
      });
      const details: FindSessionDetails = {
        // The raw query is a user-typed string that may carry secrets,
        // home paths, or other sensitive substrings. The structured
        // details surface is consumed by other tools/agents, so redact
        // before storing. The formatted text body already redacts via
        // `formatFindSessionResults`.
        query: redactText(query),
        resultCount: matches.length,
        scope: "all_sessions",
        matches,
        queryDiagnostics,
      };
      return {
        content: [{ type: "text", text: formatFindSessionResults(query, matches, queryDiagnostics) }],
        details,
      };
    },
  } satisfies ToolDefinition;
}

export function createReadSessionTool(deps: MmrHistoryToolDeps): ToolDefinition {
  return {
    name: READ_SESSION_TOOL_NAME,
    label: READ_SESSION_TOOL_NAME,
    description: READ_SESSION_DESCRIPTION,
    promptSnippet: READ_SESSION_PROMPT_SNIPPET,
    parameters: readSessionParameters,
    renderCall(args, theme) {
      return renderMmrHistoryCall(READ_SESSION_TOOL_NAME, args, theme);
    },
    renderResult(result, options, theme, context) {
      return renderMmrHistoryResult(READ_SESSION_TOOL_NAME, result, options, theme, context);
    },
    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx): Promise<AgentToolResult<ReadSessionDetails>> {
      const settings = deps.getSettings();
      if (!settings.enabled) throw new Error("read_session is unavailable: set MMR_HISTORY_ENABLE=true to enable global local Pi session lookup.");
      const params = coerceObject(rawParams);
      const { sessionId, goal, model: explicitModel, warnings } = coerceReadSessionParams(params as ReadSessionCompatParams);
      if (!sessionId) throw new Error("read_session requires a sessionId.");
      if (!goal) throw new Error("read_session requires a non-empty goal.");
      checkMmrToolParams(READ_SESSION_TOOL_NAME, READ_SESSION_COMPAT_PARAMETERS_SCHEMA, params);
      const resolved = await resolveSessionById(deps, sessionId, deps.sessionIndex);
      if (!resolved) throw new Error(`No local Pi session matched '${sessionId}'. Use find_session first.`);
      if (resolved.ambiguous) throw new Error(`Session id prefix '${sessionId}' is ambiguous: ${resolved.candidateIds.join(", ")}`);
      const manager = deps.openSession(resolved.info.path);
      return readWithWorkerThenLexical(deps, settings, resolved.info, manager, goal, explicitModel, signal, ctx, warnings);
    },
  } satisfies ToolDefinition;
}

export function registerMmrHistoryTools(pi: ExtensionAPI, deps: MmrHistoryToolDeps): void {
  const settings = deps.getSettings();
  for (const name of [FIND_SESSION_TOOL_NAME, READ_SESSION_TOOL_NAME]) registerMmrOwnedTool(name);
  if (!settings.enabled) return;
  pi.registerTool(createFindSessionTool(deps));
  pi.registerTool(createReadSessionTool(deps));
}
