/**
 * Worker tool guidance.
 *
 * One home for the model-visible worker-policy text shared by the subagent
 * invocation surface, plus the `## Using workers` system-prompt block that
 * states the cross-worker rules ONCE.
 *
 * pi-mmr exposes the same "run a worker" capability two ways: worker tools
 * (`Task`, `finder`, `librarian`, `oracle`) run blocking by default and
 * accept `background: true`, and the orchestration tools (`task_poll`,
 * `task_wait`, `task_cancel`, plus the deprecated `start_task` alias) manage
 * background runs. The cross-worker policies — when to delegate at all,
 * blocking vs background, fan-out discipline, result delivery — used to be
 * folded into every tool's `promptGuidelines`, which rendered them as a long
 * undifferentiated bullet list and repeated text the model already receives
 * in each tool's schema description. They now render once, here, in an
 * MMR-owned block inserted after `## Built-in tool guidance`; each worker
 * tool keeps a single routing guideline plus its full schema description.
 *
 * Layering: this module lives in mmr-core (prompt assembly renders the
 * block) and must not import any tool module; mmr-workers imports from here.
 * Plain string constants only — the exact model-visible wording must stay
 * greppable.
 *
 * Adding a worker tool (for example a future code-review worker): register
 * its name in the sets below and, when it has cross-worker policy text, add
 * a `UsingWorkersPart` gated on its name. Everything else (routing
 * guideline, schema description, subagent profile) stays in the tool's own
 * module.
 */

/** Worker tools that delegate work to a subagent. */
const WORKER_DELEGATION_TOOL_NAMES = ["Task", "finder", "librarian", "oracle"] as const;

/** Worker surfaces that can run in the background (`oracle` cannot). */
const BACKGROUND_CAPABLE_TOOL_NAMES = ["Task", "finder", "librarian", "start_task"] as const;

/** Background orchestration tools. */
const BACKGROUND_ORCHESTRATION_TOOL_NAMES = [
  "start_task",
  "task_poll",
  "task_wait",
  "task_cancel",
] as const;

/** Every tool name that participates in the `## Using workers` block. */
const USING_WORKERS_TOOL_NAMES: readonly string[] = [
  ...WORKER_DELEGATION_TOOL_NAMES,
  ...BACKGROUND_ORCHESTRATION_TOOL_NAMES,
];

/** Task is blocking by default; background runs via `background: true`. */
export const TASK_BACKGROUND_GUIDANCE =
  "Task is blocking by default: it returns the worker result inline. Pass background: true to run the worker as a background task while you keep working.";

/** finder is blocking by default; background runs via `background: true`. */
export const FINDER_BACKGROUND_GUIDANCE =
  "finder is blocking by default: it returns the search result inline. Pass background: true to run the search as a background task while you keep working.";

/** librarian is blocking by default; background runs via `background: true`. */
export const LIBRARIAN_BACKGROUND_GUIDANCE =
  "librarian is blocking by default: it returns the research result inline. Pass background: true to run the research as a background task while you keep working.";

/** oracle can never be backgrounded. */
export const ORACLE_ALWAYS_BLOCKING_GUIDANCE =
  "oracle is always blocking: it cannot run as a background task, so call it only when you can wait for its analysis before continuing.";

/**
 * Two-sided blocking-vs-background selection rule. Deliberately two-sided so
 * a generic "use a subagent" intent does not get over-routed to background
 * work.
 */
export const WORKER_BACKGROUND_SELECTION_GUIDANCE =
  'If you cannot proceed without the result, run the worker blocking (the default); otherwise pass background: true so the work runs while you keep working. Choosing a worker ("use a subagent" or "delegate") does not by itself mean background — only background it when you do not need the result before your next step, or the user explicitly asks for background, fan-out, parallel, or asynchronous workers.';

/**
 * Fan-out discipline for worker groups on the worker-tool surface. The UI
 * renders a spawned group as a single live card (rows flip in place) and the
 * eventual settlement card, so per-spawn narration is redundant noise. Keep
 * the literal "do not narrate" phrasing so the model-visible guidance is
 * greppable.
 */
export const WORKER_GROUP_FANOUT_GUIDANCE =
  "To fan out several workers at once, issue the worker calls as parallel tool calls in one turn, each with background: true and the same group key; the group renders as one live card and settles once. Keep setup silent: do not narrate spawns or group transitions, and go straight to your next action — the live card is the status surface and updates itself as workers run. Keep code-writing single-threaded unless the workers' file targets are clearly disjoint; prefer parallel workers for read-only investigation, review, or verification.";

/**
 * Result-delivery semantics for background runs. Stated once here; the
 * orchestration tools keep only a one-line routing guideline each.
 */
export const WORKER_RESULT_DELIVERY_GUIDANCE =
  "Completed background work is delivered automatically (notify is on by default): during an active agent loop it appears at the start of a later model step, and when idle it may wake the session — do not poll only to discover whether a single task completed. Use task_poll or task_wait for fleet orchestration: checking a group, collecting child results with task_poll({ task_id }), or waiting briefly (a task_wait timeout is not a failure and does not stop the worker). Treat a terminal result as consumed: do not re-poll the same task, and if a completion notice arrives for a task or group whose terminal result is already in the transcript, treat it as stale — do not call tools or rewrite your answer because of it. After a group settles, do not re-emit the card, its rows, or its counts; read only the specific child outputs you need.";

export const MMR_USING_WORKERS_HEADING = "## Using workers";

const WORKER_DELEGATION_CORE_GUIDANCE = [
  "Do not start a worker for work you can complete directly in a single response (editing one file, running one search, refactoring a function you can already see). Workers do not see your conversation: include everything the worker needs in its prompt — the goal, scope, relevant file paths, coding conventions, and how to verify its work.",
  "Avoid duplicating work a worker is already doing. When a worker finishes, inspect its output and summarize its result for the user; the user cannot see worker output directly.",
].join("\n\n");

interface UsingWorkersPart {
  /** Emit the paragraph when any of these tools is active. */
  readonly requiresAnyOf: readonly string[];
  readonly text: string;
}

/**
 * Ordered paragraphs of the `## Using workers` block. Each part gates on the
 * active tool set so the block never instructs about inactive tools.
 */
const USING_WORKERS_PARTS: readonly UsingWorkersPart[] = [
  {
    requiresAnyOf: USING_WORKERS_TOOL_NAMES,
    text: WORKER_DELEGATION_CORE_GUIDANCE,
  },
  {
    requiresAnyOf: BACKGROUND_CAPABLE_TOOL_NAMES,
    text: WORKER_BACKGROUND_SELECTION_GUIDANCE,
  },
  {
    requiresAnyOf: ["oracle"],
    text: ORACLE_ALWAYS_BLOCKING_GUIDANCE,
  },
  {
    requiresAnyOf: BACKGROUND_CAPABLE_TOOL_NAMES,
    text: WORKER_GROUP_FANOUT_GUIDANCE,
  },
  {
    requiresAnyOf: ["task_poll", "task_wait"],
    text: WORKER_RESULT_DELIVERY_GUIDANCE,
  },
  {
    requiresAnyOf: ["task_cancel"],
    text: "Use task_cancel to stop a duplicate, obsolete, or wrongly-scoped background task or group.",
  },
];

/**
 * Render the `## Using workers` block restricted to the given active tool
 * names. Returns `null` when no worker tool is active so the caller can skip
 * emitting an empty block.
 *
 * The oracle-only case intentionally renders the delegation core (zero-shot
 * worker, summarize for the user) without any background policy: oracle can
 * never run in the background.
 */
export function buildUsingWorkersGuidance(
  activeToolNames: readonly string[],
): string | null {
  const active = new Set(activeToolNames);
  if (!USING_WORKERS_TOOL_NAMES.some((name) => active.has(name))) return null;
  const oracleNeedsBlockingNote =
    active.has("oracle") && BACKGROUND_CAPABLE_TOOL_NAMES.some((name) => active.has(name));
  const paragraphs = USING_WORKERS_PARTS.filter((part) => {
    if (part.text === ORACLE_ALWAYS_BLOCKING_GUIDANCE) return oracleNeedsBlockingNote;
    return part.requiresAnyOf.some((name) => active.has(name));
  }).map((part) => part.text);
  return `${MMR_USING_WORKERS_HEADING}\n\n${paragraphs.join("\n\n")}`;
}

/**
 * Extract worker tool names that appear in a Pi-authored `Available tools:`
 * block body. Returns the subset that participates in the
 * `## Using workers` block; other names are ignored. Unlike Pi's built-in
 * tools, worker tool names can be capitalized (`Task`), so the line pattern
 * accepts both cases.
 */
export function extractActiveWorkerToolNames(
  availableToolsBlock: string,
): string[] {
  const known: ReadonlySet<string> = new Set(USING_WORKERS_TOOL_NAMES);
  const found: string[] = [];
  for (const line of availableToolsBlock.split("\n")) {
    const m = /^- ([A-Za-z_][A-Za-z0-9_]*):/.exec(line);
    if (!m) continue;
    const name = m[1];
    if (known.has(name) && !found.includes(name)) found.push(name);
  }
  return found;
}
