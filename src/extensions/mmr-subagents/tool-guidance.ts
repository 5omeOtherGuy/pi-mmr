/**
 * Canonical, model-visible guidance shared by the subagent invocation surface.
 *
 * `pi-mmr` exposes the same "run a worker" capability two ways: blocking worker
 * tools (`Task`, `finder`, `librarian`, `oracle`) that return their result
 * inline, and background orchestration tools (`start_task`, `task_poll`,
 * `task_wait`, `task_cancel`) that run a worker while the parent keeps working.
 * The runtime split is intentional; the risk is the model-visible wording
 * drifting between tools. These constants are the single source of truth for
 * the blocking-vs-background decision, folded into each tool's `description`
 * and `promptGuidelines`. The decision is deliberately two-sided so a generic
 * "use a subagent" intent does not get over-routed to background work.
 *
 * Plain string/array constants only — the exact model-visible wording must stay
 * greppable. This module must not import any tool module (avoid import cycles);
 * tool modules import from here.
 */

/** Task is blocking; route fan-out/background runs to start_task(agent:"Task"). */
export const TASK_BACKGROUND_GUIDANCE =
  'Task is blocking: it returns the worker result inline and does not create a background worker. To run a Task worker in the background, or to fan out several workers while you keep working, use start_task with agent: "Task".';

/** finder is blocking; background via start_task(agent:"finder"). */
export const FINDER_BACKGROUND_GUIDANCE =
  'finder is blocking: it returns the search result inline. To run finder in the background while you keep working, use start_task with agent: "finder".';

/** librarian is blocking; background via start_task(agent:"librarian"). */
export const LIBRARIAN_BACKGROUND_GUIDANCE =
  'librarian is blocking: it returns the research result inline. To run librarian in the background while you keep working, use start_task with agent: "librarian".';

/** oracle can never be backgrounded. */
export const ORACLE_ALWAYS_BLOCKING_GUIDANCE =
  "oracle is always blocking: it cannot run as a background agent through start_task, so call it only when you can wait for its analysis before continuing.";

/**
 * Two-sided selection rule phrased for the start_task surface. Keeps the literal
 * "blocking Task/finder/librarian" phrasing so the model-visible guidance names
 * the blocking alternatives explicitly.
 */
export const START_TASK_SELECTION_GUIDANCE =
  'If you cannot proceed without the result, use the blocking Task/finder/librarian tools; otherwise use start_task so the work runs while you keep working. Choosing a worker ("use a subagent" or "delegate") does not by itself mean background — only background it when you do not need the result before your next step, or the user explicitly asks for background, fan-out, parallel, or asynchronous workers. oracle is always blocking and cannot be a background agent.';

/** Concrete, copyable start_task agent examples for each background worker. */
export const START_TASK_AGENT_EXAMPLES: readonly string[] = [
  'Background a code search: start_task({ agent: "finder", params: { query: "..." } }).',
  'Background remote-repository research: start_task({ agent: "librarian", params: { query: "...", context: "..." } }).',
  'Background a bounded implementation or investigation: start_task({ agent: "Task", params: { prompt: "...", description: "..." } }).',
] as const;
