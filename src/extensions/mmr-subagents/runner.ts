import { spawn as nodeSpawn } from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { isRecord } from "../mmr-core/internal/json.js";
import { extractMmrSubagentActivationFailure } from "../mmr-core/subagent-resolver.js";
import { buildMmrWorkerArgs, resolveMmrWorkerPiInvocation } from "./runner-invocation.js";
import type { MmrWorkerInvocation } from "./runner-invocation.js";
import { copyMmrWorkerTrailItem, createMmrWorkerTrailAggregator } from "./worker-trail.js";
import type { MmrWorkerTrailItem } from "./worker-trail.js";
export { buildMmrWorkerArgs, resolveMmrWorkerPiInvocation, resolveMmrWorkerPiInvocationFromEnv } from "./runner-invocation.js";
export type { MmrWorkerArgsOptions, MmrWorkerInvocation, MmrWorkerPiInvocationEnv } from "./runner-invocation.js";
export { MMR_WORKER_TRAIL_LIMIT } from "./worker-trail.js";
export type { MmrWorkerTrailItem } from "./worker-trail.js";

export const DEFAULT_MMR_WORKER_OUTPUT_BYTE_LIMIT = 50 * 1024;
export const DEFAULT_MMR_WORKER_KILL_TIMEOUT_MS = 5_000;

/**
 * Maximum size (in bytes) of the inline `Task: ...` positional argv
 * before the runner spills the prompt to a temp file and references it
 * via Pi's `@<path>` syntax instead.
 *
 * Linux caps each individual argv string at `MAX_ARG_STRLEN`, which is
 * `32 * PAGE_SIZE = 131072` bytes on 4 KiB-page systems (essentially
 * every common Linux host today). Exceeding that limit fails the
 * `execve` of the spawned Pi worker with `E2BIG`, surfaced to callers
 * as `spawn E2BIG` — which has been observed in the wild for the
 * oracle when several attached files inline near their per-file cap.
 *
 * The threshold is intentionally conservative: it must leave room for
 * the `Task: ` framing, multi-byte UTF-8 expansion, and any future
 * prompt-prefix changes, while still keeping the small-prompt path
 * (which exercises the existing `"Task: <prompt>"` argv contract
 * asserted by the runner tests) for the common case.
 */
export const MMR_WORKER_INLINE_PROMPT_BYTE_LIMIT = 96 * 1024;

export interface MmrWorkerUsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface MmrWorkerMessage {
  role?: string;
  content?: unknown;
  usage?: unknown;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

export interface MmrWorkerProgressSnapshot {
  messages: MmrWorkerMessage[];
  finalOutput: string;
  truncatedFinalOutput: string;
  usage: MmrWorkerUsageStats;
  trail: MmrWorkerTrailItem[];
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

/**
 * Minimal worker-details surface every worker-backed details type
 * exposes, regardless of whether the worker runs in-process
 * (e.g. `mmr-history` `history-reader`) or spawns a child Pi process
 * (`finder`, `oracle`, `Task`).
 *
 * Captures the parent-observable run outcome (`model`,
 * `reportedModel`, `exitCode`, `signal`, `aborted`,
 * `outputTruncated`, `ignoredJsonLines`, `usage`, `stopReason`,
 * `errorMessage`), the subagent-activation failure discriminator
 * (`subagentActivationError`), and the deny-aware, registered-tool
 * intersection the worker actually ran with (`workerTools`).
 *
 * In-process workers extend this base directly because they do not
 * spawn a child process and therefore do not expose `command`,
 * `args`, `cwd`, `stderr`, `spawnError`, or `trail`.
 * Child-process workers extend {@link MmrSpawnedSubagentWorkerDetailsBase}
 * instead so those parent-observation fields are declared once.
 *
 * The wire shape of existing `result.details` payloads is unchanged;
 * this base only deduplicates the type declaration.
 */
export interface MmrSubagentWorkerDetailsBase {
  /** Discriminator literal owned by the concrete tool (e.g. `"mmr-subagents.Task"`). */
  worker: string;
  /** Provider-qualified or bare worker model string the parent selected. */
  model?: string;
  /** Model identifier the worker process reported in its own usage stream. */
  reportedModel?: string;
  /** Context window for the selected worker model, when the parent can resolve it. */
  contextWindow?: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  aborted: boolean;
  outputTruncated: boolean;
  ignoredJsonLines: number;
  usage: MmrWorkerUsageStats;
  stopReason?: string;
  errorMessage?: string;
  /**
   * Reason from `mmr-core` when subagent activation failed closed in
   * the child Pi process (unknown profile, no model route,
   * `--model` / `--tools` mismatch). Captured verbatim from the
   * activation-failure stderr marker so callers and operators see the
   * cause without grepping stderr.
   */
  subagentActivationError?: string;
  /**
   * Parent-side view of the worker's tool surface.
   *
   * Tools that pre-resolve the worker invocation on the parent side
   * (e.g. `Task`) populate this with the resolver-computed
   * deny-aware, registered-tool intersection, i.e. the exact set the
   * worker actually ran with. Their parent and child agree by
   * construction.
   *
   * Tools that defer worker-tool resolution to the child (e.g.
   * `finder`, `oracle`) populate this with the parent's view of the
   * profile intent allowlist (e.g. `FINDER_WORKER_TOOLS`,
   * `ORACLE_WORKER_TOOLS`). The child then runs
   * `resolveMmrSubagentInvocation` against its own registered-tool
   * inventory to compute the effective set it executes with. The two
   * agree when the child's registered tools are a superset of the
   * profile's; they may differ when the child has been started with
   * a reduced tool registry (in which case a `tools.mismatch`
   * activation failure would surface through
   * `subagentActivationError`).
   *
   * In-process workers (e.g. `mmr-history.history-reader`) populate
   * this with the profile's `tools` list, which is the authoritative
   * worker tool set because no child Pi process is involved.
   *
   * In all cases this field is the parent's best public-facing
   * representation of what the worker was permitted to call. It is
   * not a substitute for runtime tool-use observability; the actual
   * tool invocations are reported through the bounded `trail` field
   * on spawned-subagent details (`finder`, `oracle`, `Task`).
   */
  workerTools: readonly string[];
}

/**
 * Worker-details base for spawned-subagent tools that run a child Pi
 * process via the shared runner (`finder`, `oracle`, `Task`, and any
 * future tool with the same execution shape). Extends
 * {@link MmrSubagentWorkerDetailsBase} with the parent-observable
 * spawn metadata (`stderr`, `command`, `args`, `cwd`), the structured
 * spawn-failure discriminator (`spawnError`), and the bounded progress
 * wire shape (`trail`).
 *
 * In-process workers (e.g. `mmr-history` `history-reader`) extend
 * {@link MmrSubagentWorkerDetailsBase} directly; they do not declare
 * these fields because they do not spawn a child Pi process and do
 * not produce a parent-side `trail` stream.
 */
export interface MmrSpawnedSubagentWorkerDetailsBase
  extends MmrSubagentWorkerDetailsBase {
  stderr: string;
  command: string;
  args: string[];
  cwd: string;
  /**
   * Structured spawn-failure discriminator. Set to the spawn error's
   * `message` when the child-process runner's `proc.on("error")` fires
   * before/while spawning the child Pi process (typically
   * `spawn ENOENT`, `EACCES`, or `E2BIG`). Absent when the worker
   * actually started. `classifyMmrWorkerOutcome` /
   * `classifyTaskOutcome` consume this field to map spawn failures
   * deterministically without inspecting `errorMessage` text.
   */
  spawnError?: string;
  /** Ordered assistant/tool trail rendered in the parent TUI when the row is expanded. */
  trail: readonly MmrWorkerTrailItem[];
}

export interface MmrWorkerResult extends MmrWorkerProgressSnapshot {
  prompt: string;
  cwd: string;
  command: string;
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  aborted: boolean;
  outputTruncated: boolean;
  ignoredJsonLines: number;
  /**
   * Reason string parsed out of the child Pi process's stderr when
   * `mmr-core` writes the activation-failure marker. Present whenever a
   * named `--mmr-subagent <name>` activation failed closed (unknown
   * profile, no model route, `--model` / `--tools` mismatch); absent
   * otherwise.
   *
   * The runner treats the marker as an unmissable failure even when Pi
   * itself exits 0, because Pi currently does not propagate extension
   * `session_start` throws into a nonzero exit code; without this
   * detection, consumers (finder, future Task) would silently consume
   * an un-policied worker run.
   */
  subagentActivationError?: string;
  /**
   * Structured spawn-failure discriminator. Set to the spawn error's
   * `message` when `proc.on("error")` fires before/while spawning the
   * child Pi process (typically `spawn ENOENT`, `EACCES`, or `E2BIG`).
   * Absent when the worker actually started.
   *
   * The runner's spawn-error path resolves the promise with a structured
   * `MmrWorkerResult` instead of throwing, so a discriminator separate
   * from `errorMessage` (which is set for many failure modes, not just
   * spawn) lets `classifyTaskOutcome` map spawn failures to
   * `status: "spawn-error"` deterministically without inspecting the
   * message text. See {@link classifyMmrWorkerOutcome} for the precedence
   * ladder that consumes this field.
   */
  spawnError?: string;
  /**
   * Did the child Pi process emit `agent_start` (i.e. enter the agent
   * loop) at least once before exiting?
   *
   * `false` when the child exited after `session` without ever firing
   * `agent_start` — typically because a sibling extension's `input`
   * event handler returned `{ action: "handled" }` and consumed the
   * prompt before any provider call could happen. This is observably
   * different from "the model produced no output" and is surfaced as
   * the dedicated `no-agent-start` outcome by
   * {@link classifyMmrWorkerOutcome}.
   *
   * Set defensively on any in-loop event (`agent_start`,
   * `turn_start`, `message_start`, `message_end`, `turn_end`,
   * `agent_end`, `tool_execution_*`, `tool_result_end`) so future Pi
   * stream-event reshuffles do not silently regress the signal.
   */
  agentStarted: boolean;
}

/**
 * Shared outcome status produced by {@link classifyMmrWorkerOutcome}.
 * Concrete tools may narrow this to a tool-specific status union
 * (e.g. {@link import("./task.js").TaskStatus}) by handling additional
 * pre-classification states such as `validation-error`.
 *
 * Precedence (top wins):
 *  1. `spawn-error`      — runner failed before/while spawning the child.
 *  2. `activation-error` — child wrote the mmr-core activation-failure marker.
 *  3. `aborted`          — parent abort signal arrived.
 *  4. `worker-error`     — signal-killed without usable final text, or
 *                          nonzero exit (see `partialOutputPolicy`).
 *  5. `no-agent-start`   — clean exit with no usable final text AND the
 *                          child never emitted `agent_start`. This is the
 *                          signature of a sibling input-event handler
 *                          (sibling extension) consuming the prompt before
 *                          the model is consulted; surfacing it as a
 *                          distinct outcome lets consumers replace the
 *                          cheerful "no results" message with a diagnostic
 *                          that points operators at extension stderr.
 *  6. `empty-output`     — clean exit with no usable final text but the
 *                          agent loop did run.
 *  7. `success`          — otherwise.
 */
export type MmrWorkerOutcomeStatus =
  | "success"
  | "spawn-error"
  | "activation-error"
  | "aborted"
  | "worker-error"
  | "no-agent-start"
  | "empty-output";

/**
 * Policy controlling how nonzero exits are classified when usable final
 * text is present:
 *
 *  - `"fail-on-nonzero"` — nonzero exit is always `worker-error`,
 *    regardless of output. Used by finder, oracle, and history-reader,
 *    which treat any nonzero exit as a failed worker run because their
 *    output is consumed verbatim by the parent.
 *  - `"prefer-usable-output"` — nonzero exit with usable final text is
 *    `success`; nonzero exit without usable text is `worker-error`.
 *    Used by `Task`, whose worker may exit nonzero after emitting a
 *    usable final answer (spec §9.4).
 */
export interface ClassifyMmrWorkerOutcomeOptions {
  partialOutputPolicy: "fail-on-nonzero" | "prefer-usable-output";
}

/**
 * Predicate shared with consumers that want to mirror the classifier's
 * notion of “usable final text.” The truncated form wins when present
 * so partial responses still count.
 */
export function hasUsableMmrWorkerFinalOutput(
  result: Pick<MmrWorkerResult, "finalOutput" | "truncatedFinalOutput">,
): boolean {
  const text =
    result.truncatedFinalOutput && result.truncatedFinalOutput.length > 0
      ? result.truncatedFinalOutput
      : (result.finalOutput ?? "");
  return text.trim().length > 0;
}

/**
 * Deterministic precedence-ordered classifier for `MmrWorkerResult`
 * outcomes. Replaces the per-tool ad-hoc precedence each subagent had
 * to spell out independently. Consumers that need additional
 * pre-classification states (Task's `validation-error`) wrap this
 * function and short-circuit before calling it.
 *
 * The classifier never inspects free-form `errorMessage` text; only
 * structured discriminators (`spawnError`, `subagentActivationError`,
 * `aborted`, `signal`, `exitCode`, `agentStarted`) and final-output
 * usability are read.
 *
 * `agentStarted` is optional and defaults to `true` for backward
 * compatibility with callers that did not previously thread it through.
 * Production callers (the spawned-worker runner) always pass the
 * observed value; older test fixtures and ad-hoc callers therefore stay
 * on the pre-existing `empty-output` path until they opt into the new
 * signal.
 */
export function classifyMmrWorkerOutcome(
  result: Pick<
    MmrWorkerResult,
    | "spawnError"
    | "subagentActivationError"
    | "aborted"
    | "signal"
    | "exitCode"
    | "finalOutput"
    | "truncatedFinalOutput"
  > & { agentStarted?: boolean },
  options: ClassifyMmrWorkerOutcomeOptions,
): MmrWorkerOutcomeStatus {
  if (result.spawnError) return "spawn-error";
  if (result.subagentActivationError) return "activation-error";
  if (result.aborted) return "aborted";
  const usable = hasUsableMmrWorkerFinalOutput(result);
  if (result.signal !== null && !usable) return "worker-error";
  if (result.exitCode !== null && result.exitCode !== 0) {
    if (options.partialOutputPolicy === "fail-on-nonzero") return "worker-error";
    if (!usable) return "worker-error";
  }
  if (usable) return "success";
  if (result.agentStarted === false) return "no-agent-start";
  return "empty-output";
}

/**
 * Subagent worker invocation options.
 *
 * Required {@link profileName} activates the named `mmr-core` subagent
 * profile in the child Pi process via `--mmr-subagent <name>`. The
 * profile is authoritative at activation time; explicit `model` /
 * `tools` should mirror the profile route and exist for observability
 * and Pi-side parsing (mmr-core fails closed on mismatch). Optional
 * `parentMode` lets mode-derived workers validate mode-specific child
 * routes without inferring from model ids.
 */
export interface RunMmrSubagentWorkerOptions {
  /** Required subagent profile name passed as `--mmr-subagent <name>`. */
  profileName: string;
  /** Parent mode for mode-derived workers, passed as `--mmr-parent-mode`. */
  parentMode?: string;
  /** Bounded task prompt sent as the final positional prompt to `pi -p`. */
  prompt: string;
  /** Working directory for the isolated Pi worker process. */
  cwd: string;
  /** Optional worker model route. Omitted workers inherit Pi's default model selection. */
  model?: string;
  /** Concrete Pi tool allowlist passed through `--tools`. */
  tools?: readonly string[];
  /** Optional system prompt written to a temporary file. Delivered to the
   * child Pi via `--append-system-prompt` (default) or `--system-prompt`
   * depending on {@link systemPromptDelivery}. */
  systemPrompt?: string;
  /**
   * How the prompt file is delivered to the child Pi:
   *  - `"append"` (default): `--append-system-prompt <file>` so the worker
   *    inherits Pi's default coding-assistant head and appends the prompt.
   *  - `"replace"`: `--system-prompt <file>` so the worker uses the prompt
   *    file as the base, plus `--no-context-files --no-skills` so Pi does
   *    not extend it with project context or skills. Required by the Task
   *    tool so the assembled worker prompt is the only model-visible
   *    system prompt.
   */
  systemPromptDelivery?: "append" | "replace";
  /** Parent cancellation signal; aborting sends SIGTERM and then SIGKILL if needed. */
  signal?: AbortSignal;
  /** Maximum bytes returned in `truncatedFinalOutput`; `finalOutput` remains complete in details. */
  outputByteLimit?: number;
  /** Grace period between SIGTERM and SIGKILL after abort. */
  killTimeoutMs?: number;
  /** Progress callback invoked after parsed message/tool-result events. */
  onUpdate?: (snapshot: MmrWorkerProgressSnapshot) => void;
}

export interface MmrWorkerProcess {
  stdout: Readable;
  stderr: Readable;
  killed?: boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

export type MmrWorkerSpawn = (command: string, args: readonly string[], options: SpawnOptions) => MmrWorkerProcess;

export interface MmrWorkerRunnerDeps {
  spawn?: MmrWorkerSpawn;
  resolveInvocation?: (args: string[]) => MmrWorkerInvocation;
  tmpDir?: string;
}

interface PromptFileHandle {
  dir: string;
  filePath: string;
}

export function emptyMmrWorkerUsageStats(): MmrWorkerUsageStats {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  };
}

// Internal alias kept for the existing callsites in this file.
function emptyUsage(): MmrWorkerUsageStats {
  return emptyMmrWorkerUsageStats();
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function collectUsage(message: MmrWorkerMessage, usage: MmrWorkerUsageStats): void {
  if (message.role !== "assistant") return;
  usage.turns += 1;
  if (!isRecord(message.usage)) return;
  usage.input += readNumber(message.usage.input);
  usage.output += readNumber(message.usage.output);
  usage.cacheRead += readNumber(message.usage.cacheRead);
  usage.cacheWrite += readNumber(message.usage.cacheWrite);
  usage.contextTokens = readNumber(message.usage.totalTokens) || usage.contextTokens;
  const cost = message.usage.cost;
  if (isRecord(cost)) usage.cost += readNumber(cost.total);
}

export function getMmrWorkerFinalOutput(messages: readonly MmrWorkerMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const content = Array.isArray(message.content) ? message.content : [];
    for (const part of content) {
      if (isRecord(part) && part.type === "text" && typeof part.text === "string") return part.text;
    }
  }
  return "";
}

export function truncateMmrWorkerOutput(output: string, byteLimit = DEFAULT_MMR_WORKER_OUTPUT_BYTE_LIMIT): {
  text: string;
  truncated: boolean;
} {
  const limit = Math.max(0, Math.floor(byteLimit));
  const byteLength = Buffer.byteLength(output, "utf8");
  if (byteLength <= limit) return { text: output, truncated: false };

  let truncated = output.slice(0, limit);
  while (Buffer.byteLength(truncated, "utf8") > limit) truncated = truncated.slice(0, -1);
  const omitted = byteLength - Buffer.byteLength(truncated, "utf8");
  return {
    text: `${truncated}\n\n[Output truncated: ${omitted} bytes omitted. Full output preserved in worker details.]`,
    truncated: true,
  };
}

async function writeSystemPromptFile(systemPrompt: string, deps: Pick<MmrWorkerRunnerDeps, "tmpDir">): Promise<PromptFileHandle> {
  const dir = await mkdtemp(path.join(deps.tmpDir ?? tmpdir(), "pi-mmr-subagent-"));
  const filePath = path.join(dir, "system-prompt.md");
  await writeFile(filePath, systemPrompt, { encoding: "utf8", mode: 0o600 });
  return { dir, filePath };
}

async function writeUserPromptFile(prompt: string, deps: Pick<MmrWorkerRunnerDeps, "tmpDir">): Promise<PromptFileHandle> {
  const dir = await mkdtemp(path.join(deps.tmpDir ?? tmpdir(), "pi-mmr-subagent-"));
  const filePath = path.join(dir, "user-prompt.md");
  await writeFile(filePath, prompt, { encoding: "utf8", mode: 0o600 });
  return { dir, filePath };
}

async function cleanupPromptFile(handle: PromptFileHandle | undefined): Promise<void> {
  if (!handle) return;
  await rm(handle.dir, { recursive: true, force: true });
}

function makeSnapshot(
  messages: MmrWorkerMessage[],
  usage: MmrWorkerUsageStats,
  trail: readonly MmrWorkerTrailItem[],
  byteLimit: number,
  fields: Pick<MmrWorkerProgressSnapshot, "model" | "stopReason" | "errorMessage">,
): MmrWorkerProgressSnapshot {
  const finalOutput = getMmrWorkerFinalOutput(messages);
  const truncated = truncateMmrWorkerOutput(finalOutput, byteLimit);
  return {
    messages: [...messages],
    finalOutput,
    truncatedFinalOutput: truncated.text,
    usage: { ...usage },
    trail: trail.map(copyMmrWorkerTrailItem),
    ...fields,
  };
}

function toWorkerMessage(value: unknown): MmrWorkerMessage | undefined {
  if (!isRecord(value)) return undefined;
  return value as MmrWorkerMessage;
}

/**
 * Canonical subagent worker entry. Spawns an isolated `pi --mode json -p
 * --no-session` child that activates the named `mmr-core` subagent
 * profile via `--mmr-subagent <name>`.
 *
 * Fails closed when `profileName` is empty: a worker invocation with no
 * profile would bypass `mmr-core`'s subagent activation guard and could
 * silently inherit the parent's locked-mode posture, so this is treated
 * as a programming error rather than a soft fallback.
 */
export async function runMmrSubagentWorker(
  options: RunMmrSubagentWorkerOptions,
  deps: MmrWorkerRunnerDeps = {},
): Promise<MmrWorkerResult> {
  const profileName = typeof options.profileName === "string" ? options.profileName.trim() : "";
  if (profileName.length === 0) {
    throw new Error(
      "runMmrSubagentWorker requires a non-empty profileName; pass the mmr-core subagent profile to activate.",
    );
  }
  const spawnImpl = deps.spawn ?? (nodeSpawn as unknown as MmrWorkerSpawn);
  const resolveInvocation = deps.resolveInvocation ?? resolveMmrWorkerPiInvocation;
  const outputByteLimit = options.outputByteLimit ?? DEFAULT_MMR_WORKER_OUTPUT_BYTE_LIMIT;
  const killTimeoutMs = options.killTimeoutMs ?? DEFAULT_MMR_WORKER_KILL_TIMEOUT_MS;
  const messages: MmrWorkerMessage[] = [];
  const usage = emptyUsage();
  const workerTrail = createMmrWorkerTrailAggregator();
  let stderr = "";
  let ignoredJsonLines = 0;
  let model: string | undefined;
  let stopReason: string | undefined;
  let errorMessage: string | undefined;
  let aborted = false;
  // Tracked to populate `MmrWorkerResult.agentStarted` so
  // `classifyMmrWorkerOutcome` can distinguish "worker entered the loop
  // and produced nothing" (empty-output) from "worker exited before the
  // agent loop began" (no-agent-start). The latter is the signature of
  // a sibling input-event handler swallowing the prompt; see the
  // outcome ladder docstring on `MmrWorkerOutcomeStatus`.
  let agentStarted = false;
  let promptFile: PromptFileHandle | undefined;
  let userPromptFile: PromptFileHandle | undefined;
  let args: string[] = [];
  let command: string;

  const emitUpdate = () => {
    options.onUpdate?.(makeSnapshot(messages, usage, workerTrail.snapshot(), outputByteLimit, { model, stopReason, errorMessage }));
  };

  try {
    const systemPrompt = options.systemPrompt?.trim();
    if (systemPrompt) promptFile = await writeSystemPromptFile(systemPrompt, deps);
    // Spill the user prompt to a temp file (and reference it via Pi's
    // `@<path>` syntax) when the inline `Task: ...` argv would exceed
    // Linux's per-arg `MAX_ARG_STRLEN`, which would otherwise fail the
    // spawn with `E2BIG`. Measured as a UTF-8 byte length so the cap
    // matches what the kernel actually counts.
    const inlinePromptBytes = Buffer.byteLength(`Task: ${options.prompt}`, "utf8");
    if (inlinePromptBytes > MMR_WORKER_INLINE_PROMPT_BYTE_LIMIT) {
      userPromptFile = await writeUserPromptFile(`Task: ${options.prompt}`, deps);
    }
    args = buildMmrWorkerArgs(options, promptFile?.filePath, userPromptFile?.filePath);
    const invocation = resolveInvocation(args);
    command = invocation.command;
    args = invocation.args;

    const proc = spawnImpl(command, args, {
      cwd: options.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let killTimer: NodeJS.Timeout | undefined;
    let stdoutBuffer = "";
    let childClosed = false;

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        ignoredJsonLines += 1;
        return;
      }
      if (!isRecord(event)) return;
      // Mark the agent loop as observed on any in-loop event. `agent_start`
      // is the canonical signal; the rest are defensive in case Pi reshuffles
      // its stream-event order in a future release (these events imply
      // `agent_start` already fired and never appear without it).
      if (
        event.type === "agent_start" ||
        event.type === "agent_end" ||
        event.type === "turn_start" ||
        event.type === "turn_end" ||
        event.type === "message_start" ||
        event.type === "message_end" ||
        event.type === "message_update" ||
        event.type === "tool_execution_start" ||
        event.type === "tool_execution_update" ||
        event.type === "tool_execution_end" ||
        event.type === "tool_result_end"
      ) {
        agentStarted = true;
      }
      if (event.type === "message_end") {
        const message = toWorkerMessage(event.message);
        if (!message) return;
        messages.push(message);
        collectUsage(message, usage);
        if (message.role === "assistant") {
          model = model ?? readString(message.model);
          stopReason = readString(message.stopReason) ?? stopReason;
          errorMessage = readString(message.errorMessage) ?? errorMessage;
        }
        workerTrail.captureMessage(message);
        emitUpdate();
        return;
      }
      if (event.type === "tool_result_end") {
        const message = toWorkerMessage(event.message);
        if (!message) return;
        messages.push(message);
        workerTrail.captureToolResult(message);
        emitUpdate();
        return;
      }
      if (event.type === "tool_execution_start") {
        if (workerTrail.startTool(event)) emitUpdate();
        return;
      }
      if (event.type === "tool_execution_update") {
        if (workerTrail.updateTool(event)) emitUpdate();
        return;
      }
      if (event.type === "tool_execution_end") {
        if (workerTrail.endTool(event)) emitUpdate();
      }
    };

    const finish = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; spawnError?: Error }>((resolve) => {
      let settled = false;
      const settle = (result: { exitCode: number | null; signal: NodeJS.Signals | null; spawnError?: Error }) => {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        resolve(result);
      };

      proc.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk.toString();
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      });
      proc.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      proc.on("close", (code, signal) => {
        childClosed = true;
        if (stdoutBuffer.trim()) processLine(stdoutBuffer);
        settle({ exitCode: code, signal });
      });
      proc.on("error", (error) => {
        childClosed = true;
        errorMessage = error.message;
        settle({ exitCode: 1, signal: null, spawnError: error });
      });

      const abortWorker = () => {
        aborted = true;
        errorMessage = "Subagent worker was aborted.";
        proc.kill("SIGTERM");
        // `proc.killed` flips true as soon as `kill()` successfully delivers
        // the signal, not when the child actually exits. Gate SIGKILL on
        // whether the `close` event has fired instead, otherwise a child that
        // ignores SIGTERM stays alive forever.
        killTimer = setTimeout(() => {
          if (!childClosed) proc.kill("SIGKILL");
        }, killTimeoutMs);
      };

      if (options.signal?.aborted) abortWorker();
      else options.signal?.addEventListener("abort", abortWorker, { once: true });
    });

    const spawnErrorMessage = finish.spawnError?.message;
    if (spawnErrorMessage) errorMessage = spawnErrorMessage;
    // Detect mmr-core's activation-failure marker on stderr. Must be
    // checked after stderr is fully drained (i.e. after the `close`
    // event has settled) so a marker that crossed a chunk boundary is
    // still seen. Treat marker presence as a hard failure even when Pi
    // exits 0, and surface the reason via both the structured
    // `subagentActivationError` field and `errorMessage` so existing
    // consumers that only inspect `errorMessage` still see the cause.
    const subagentActivationError = extractMmrSubagentActivationFailure(stderr);
    if (subagentActivationError) {
      errorMessage = `subagent activation failed: ${subagentActivationError}`;
    }
    const snapshot = makeSnapshot(messages, usage, workerTrail.snapshot(), outputByteLimit, { model, stopReason, errorMessage });
    const truncation = truncateMmrWorkerOutput(snapshot.finalOutput, outputByteLimit);
    return {
      ...snapshot,
      truncatedFinalOutput: truncation.text,
      prompt: options.prompt,
      cwd: options.cwd,
      command,
      args,
      exitCode: finish.exitCode,
      signal: finish.signal,
      stderr,
      aborted,
      outputTruncated: truncation.truncated,
      ignoredJsonLines,
      agentStarted,
      ...(subagentActivationError ? { subagentActivationError } : {}),
      ...(spawnErrorMessage ? { spawnError: spawnErrorMessage } : {}),
    };
  } finally {
    await cleanupPromptFile(promptFile);
    await cleanupPromptFile(userPromptFile);
  }
}

/**
 * Stable, framework-owned name for the progress snapshot a
 * {@link MmrSubagentRunner} surfaces through {@link MmrSubagentRunOptions.onProgress}.
 *
 * Aliased to {@link MmrWorkerProgressSnapshot} so the field set stays
 * narrow today (callers already read these fields) while leaving room
 * to project a different shape later without rewriting tool callsites.
 */
export type MmrSubagentRunProgress = MmrWorkerProgressSnapshot;

/**
 * Stable worker-runner name for a subagent run's final result.
 *
 * Aliased to {@link MmrWorkerResult} for now: every consumer
 * (finder/oracle) already reads its full field set (including
 * `command` and `args` exercised by the runner tests). The alias
 * lets the runner interface land without breaking those callsites,
 * and future narrowing can happen behind the same public name.
 */
export type MmrSubagentWorkerRunResult = MmrWorkerResult;

/**
 * Generic subagent run options. Mirrors {@link RunMmrSubagentWorkerOptions}
 * but renames `onUpdate` to the framework-owned `onProgress` so future
 * runners (in-process, host-mediated, etc.) can share one option shape
 * across implementations.
 */
export interface MmrSubagentRunOptions {
  profileName: string;
  parentMode?: string;
  prompt: string;
  cwd: string;
  model?: string;
  tools?: readonly string[];
  systemPrompt?: string;
  /** See {@link RunMmrSubagentWorkerOptions.systemPromptDelivery}. */
  systemPromptDelivery?: "append" | "replace";
  signal?: AbortSignal;
  outputByteLimit?: number;
  /** Optional grace period between SIGTERM and SIGKILL on cancellation. */
  killTimeoutMs?: number;
  /** Progress callback invoked after parsed message/tool-result events. */
  onProgress?: (snapshot: MmrSubagentRunProgress) => void;
}

/**
 * Generic subagent runner interface. Tool implementations depend on this
 * instead of the child-CLI worker function so alternate runners (e.g. a
 * future in-process host seam) can drop in without rewriting callers.
 */
export interface MmrSubagentRunner {
  run(options: MmrSubagentRunOptions): Promise<MmrSubagentWorkerRunResult>;
}

function toRunMmrSubagentWorkerOptions(
  options: MmrSubagentRunOptions,
): RunMmrSubagentWorkerOptions {
  const mapped: RunMmrSubagentWorkerOptions = {
    profileName: options.profileName,
    prompt: options.prompt,
    cwd: options.cwd,
  };
  if (options.parentMode !== undefined) mapped.parentMode = options.parentMode;
  if (options.model !== undefined) mapped.model = options.model;
  if (options.tools !== undefined) mapped.tools = options.tools;
  if (options.systemPrompt !== undefined) mapped.systemPrompt = options.systemPrompt;
  if (options.systemPromptDelivery !== undefined) mapped.systemPromptDelivery = options.systemPromptDelivery;
  if (options.signal !== undefined) mapped.signal = options.signal;
  if (options.outputByteLimit !== undefined) mapped.outputByteLimit = options.outputByteLimit;
  if (options.killTimeoutMs !== undefined) mapped.killTimeoutMs = options.killTimeoutMs;
  if (options.onProgress) mapped.onUpdate = options.onProgress;
  return mapped;
}

/**
 * Build a {@link MmrSubagentRunner} backed by {@link runMmrSubagentWorker}
 * (i.e. an isolated `pi --mode json` subprocess that activates the named
 * subagent profile through `--mmr-subagent`).
 *
 * Optional {@link MmrWorkerRunnerDeps} are forwarded verbatim so tests can
 * inject a fake spawn or a custom invocation resolver.
 */
export function createChildCliMmrSubagentRunner(
  deps?: MmrWorkerRunnerDeps,
): MmrSubagentRunner {
  return createMmrSubagentRunnerFromRunWorker(runMmrSubagentWorker, deps);
}

/**
 * Build a {@link MmrSubagentRunner} from a caller-supplied `runWorker`
 * function with the same signature as {@link runMmrSubagentWorker}.
 *
 * Concrete subagent tools (`finder`, `oracle`, `Task`) accept a
 * `runWorker` test-injection dep so tests can stub the child-CLI
 * worker without spawning a real Pi process. This adapter centralizes
 * the `MmrSubagentRunOptions` → `RunMmrSubagentWorkerOptions` mapping
 * so every test seam goes through the same option translation as
 * production (in particular `systemPromptDelivery`, which earlier
 * per-tool adapters silently dropped).
 */
export function createMmrSubagentRunnerFromRunWorker(
  runWorker: typeof runMmrSubagentWorker,
  deps?: MmrWorkerRunnerDeps,
): MmrSubagentRunner {
  return {
    run(options) {
      const mapped = toRunMmrSubagentWorkerOptions(options);
      return deps ? runWorker(mapped, deps) : runWorker(mapped);
    },
  };
}
