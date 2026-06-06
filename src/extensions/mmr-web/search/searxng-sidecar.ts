/**
 * Managed SearXNG sidecar for `mmr-web` (opt-in).
 *
 * When the user opts in by setting `mmrWeb.searxngManaged=true` AND
 * `mmrWeb.searxngStartCommand` in their settings file, `mmr-web`
 * will spawn a local SearXNG instance on demand before the first
 * `web_search` call, poll it until ready, and stop it after an idle
 * period or on `session_shutdown`. On Pi 0.77.0+ `session_shutdown` also
 * fires on `SIGTERM`/`SIGHUP` exits, so signal-terminated sessions stop the
 * sidecar instead of leaking it.
 *
 * Safety invariants:
 *
 * - Start/stop commands are NEVER read from environment variables or
 *   model input. They come from settings-file-only fields, validated
 *   to be non-empty arrays of strings, and passed to
 *   `child_process.spawn` with `shell: false` so the OS does not
 *   interpret any shell metacharacters.
 * - The sidecar is per-process. Multiple Pi processes against the
 *   same project do not coordinate cross-process; each maintains its
 *   own lifecycle and may each spawn an instance. This keeps the
 *   model simple and avoids cross-process file-lock complexity for
 *   the MVP.
 * - The sidecar is gated on `searxngManaged === true`. Setting just
 *   `searxngStartCommand` without enabling the gate is a no-op.
 * - Stop is best-effort. If the user-provided stop command fails the
 *   sidecar still sends SIGTERM to the start child when that process is
 *   still alive. Detached process managers such as `docker compose up -d`
 *   should configure a stop command because their start child exits quickly.
 *
 * Not in MVP scope (see ROADMAP for follow-ups):
 *
 * - Cross-process coordination via on-disk lock.
 * - Restart on unexpected crash.
 * - Live re-read of the settings file.
 */

import type { ChildProcess, SpawnOptions } from "node:child_process";

/**
 * Subset of `child_process` the sidecar uses. Declared locally so tests
 * inject a deterministic spawn stub without monkey-patching globals.
 */
export interface SidecarSpawn {
  (command: string, args: ReadonlyArray<string>, options: SpawnOptions): ChildProcess;
}

/** Per-process timer reference used so tests can swap in fake timers. */
export type SidecarTimer = {
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now: () => number;
};

const REAL_TIMER: SidecarTimer = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/**
 * Describe a spawn command for error messages WITHOUT leaking its arguments.
 * Surfaces only the program name (argv[0]) and an argument count, matching the
 * "set (N args)" arg-count style used by the `mmr-web` config view, so error
 * output never echoes back full command lines that may carry sensitive paths,
 * tokens, or flags.
 */
function describeCommandForError(command: ReadonlyArray<string>): string {
  const program = command[0] ?? "(unset)";
  const argCount = Math.max(0, command.length - 1);
  return `"${program}" (${argCount} args)`;
}

export interface SidecarSettings {
  managed: boolean;
  /** Command array; must be non-empty for managed=true to actually spawn. */
  startCommand?: ReadonlyArray<string>;
  stopCommand?: ReadonlyArray<string>;
  /** Service URL the user already configured for searches. */
  url?: string;
  /** Optional override for the health-poll URL. */
  healthUrl?: string;
  /** Idle-stop window. 0 disables the idle timer. */
  idleTimeoutMs: number;
  /** Max wait for SearXNG to pass health before failing the search. */
  startTimeoutMs: number;
}

export interface SidecarRuntimeOptions {
  /** Test seam: alternate spawn implementation. */
  spawn?: SidecarSpawn;
  /** Test seam: alternate fetch for the health check. */
  fetchImpl?: typeof fetch;
  /** Test seam: alternate timer source. */
  timer?: SidecarTimer;
  /** Test seam: cwd passed to spawn (defaults to process.cwd()). */
  cwd?: string;
}

/** Internal sidecar state. */
interface SidecarState {
  /** Child process from the most recent start command, if it is still tracked. */
  child?: ChildProcess;
  startPromise?: Promise<void>;
  /**
   * Monotonic token identifying the in-flight start. Captured locally when a
   * start claims ownership of `startPromise` so the finally block can clear
   * `startPromise` only when no newer start (or a `stop()`/new `ensureRunning`)
   * has replaced it, without comparing promise references directly.
   */
  startGeneration: number;
  idleTimer?: unknown;
  /** Settings snapshot from the last ensureRunning() call. */
  settings?: SidecarSettings;
  options?: SidecarRuntimeOptions;
  /** True once the service passed health at least once and needs teardown. */
  started: boolean;
  /** Whether stop has already been issued (idempotency guard). */
  stopped: boolean;
}

const state: SidecarState = { started: false, stopped: false, startGeneration: 0 };

/** Reset the per-process singleton. Test seam only. */
export function __resetSearxngSidecarStateForTests(): void {
  state.child = undefined;
  state.startPromise = undefined;
  if (state.idleTimer !== undefined) {
    (state.options?.timer ?? REAL_TIMER).clearTimeout(state.idleTimer);
  }
  state.idleTimer = undefined;
  state.settings = undefined;
  state.options = undefined;
  state.started = false;
  state.stopped = false;
}

/** Inspect the current sidecar status. Test seam. */
export function __getSearxngSidecarStateForTests(): {
  running: boolean;
  hasIdleTimer: boolean;
  pid?: number;
} {
  return {
    running: state.started && !state.stopped,
    hasIdleTimer: state.idleTimer !== undefined,
    pid: state.child?.pid,
  };
}

function defaultHealthUrl(s: SidecarSettings): string | undefined {
  if (s.healthUrl) return s.healthUrl;
  if (!s.url) return undefined;
  // Use the SearXNG JSON search endpoint as a readiness probe with a tiny
  // query. SearXNG returns 200+JSON when ready and the bare `/` route may
  // return 302 to a UI page, so the search route is more deterministic.
  const base = s.url.endsWith("/") ? s.url.slice(0, -1) : s.url;
  return `${base}/search?q=ping&format=json`;
}

async function pollHealth(
  url: string,
  fetchImpl: typeof fetch,
  startTimeoutMs: number,
  timer: SidecarTimer,
): Promise<void> {
  const deadline = timer.now() + startTimeoutMs;
  let attempt = 0;
  let lastError: unknown;
  while (timer.now() < deadline) {
    attempt += 1;
    const probeBudget = Math.max(500, Math.min(3000, deadline - timer.now()));
    try {
      const probeSignal = AbortSignal.timeout(probeBudget);
      const response = await fetchImpl(url, { method: "GET", signal: probeSignal });
      if (response.ok) {
        // Drain body so the socket can be reused.
        try { await response.text(); } catch { /* ignore */ }
        return;
      }
      lastError = new Error(`HTTP ${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
    }
    // Exponential backoff capped at 1s per attempt; first wait is ~100ms.
    const wait = Math.min(1000, 100 * 2 ** Math.min(attempt - 1, 4));
    const remaining = deadline - timer.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolve) => {
      timer.setTimeout(() => resolve(), Math.min(wait, remaining));
    });
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `Managed SearXNG did not pass health check at ${url} within ${startTimeoutMs}ms${reason ? `: ${reason}` : ""}.`,
  );
}

function scheduleIdleStop(settings: SidecarSettings, options: SidecarRuntimeOptions): void {
  const timer = options.timer ?? REAL_TIMER;
  if (state.idleTimer !== undefined) timer.clearTimeout(state.idleTimer);
  state.idleTimer = undefined;
  if (settings.idleTimeoutMs <= 0) return;
  state.idleTimer = timer.setTimeout(() => {
    void shutdownSearxngSidecar({ reason: "idle" });
  }, settings.idleTimeoutMs);
}

/**
 * Ensure the managed SearXNG sidecar is running and healthy.
 *
 * - No-op when `managed=false`, when `startCommand` is missing/empty, or
 *   when `url` is unset (caller should resolve to a non-SearXNG backend).
 * - Spawns once across concurrent callers via an in-flight Promise.
 * - Resets the idle timer on every successful call.
 *
 * Throws an actionable error when the spawn fails or the health check
 * times out within `searxngStartTimeoutMs`.
 */
export async function ensureSearxngSidecarRunning(
  settings: SidecarSettings,
  options: SidecarRuntimeOptions = {},
): Promise<void> {
  if (!settings.managed) return;
  if (!settings.url) return;
  if (!settings.startCommand || settings.startCommand.length === 0) {
    throw new Error(
      "Managed SearXNG is enabled (mmrWeb.searxngManaged=true) but mmrWeb.searxngStartCommand is unset. Add a non-empty array of strings to your settings file, for example: [\"docker\", \"compose\", \"-f\", \"./searxng.yml\", \"up\", \"-d\"].",
    );
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const timer = options.timer ?? REAL_TIMER;
  const healthUrl = defaultHealthUrl(settings);
  if (!healthUrl) {
    throw new Error("Managed SearXNG is enabled but no service URL is configured (mmrWeb.searxngUrl).");
  }

  // Already started and healthy: just refresh the idle timer. The start
  // process may have exited normally (for example `docker compose up -d`),
  // so service liveness is tracked separately from the child handle.
  if (state.started && !state.stopped) {
    state.settings = settings;
    state.options = options;
    scheduleIdleStop(settings, options);
    return;
  }

  // Spawn already in flight: wait for it, then refresh idle timer.
  if (state.startPromise) {
    await state.startPromise;
    state.settings = settings;
    state.options = options;
    scheduleIdleStop(settings, options);
    return;
  }

  state.started = false;
  state.stopped = false;
  state.settings = settings;
  state.options = options;

  const startPromise = (async () => {
    const spawnImpl = options.spawn ?? (await import("node:child_process")).spawn;
    const [cmd, ...args] = settings.startCommand!;
    let child: ChildProcess;
    try {
      child = spawnImpl(cmd!, args, {
        stdio: "ignore",
        detached: false,
        shell: false,
        cwd: options.cwd ?? process.cwd(),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to spawn managed SearXNG start command ${describeCommandForError(settings.startCommand!)}: ${reason}.`,
      );
    }
    // Keep the child handle even after it exits. Detached start commands
    // such as `docker compose up -d` exit normally while the managed service
    // keeps running; shutdown still needs the stored settings/handle so it
    // can run the stop command and, when relevant, SIGTERM a still-live child.
    child.once("exit", () => {
      // Intentionally no-op; Node updates child.exitCode for us.
    });
    state.child = child;

    try {
      await pollHealth(healthUrl, fetchImpl, settings.startTimeoutMs, timer);
      state.started = true;
    } catch (error) {
      // Health check failed: tear down the spawned child so the next
      // ensureRunning() retries cleanly.
      try {
        if (child.exitCode === null && child.killed === false) child.kill("SIGTERM");
      } catch { /* ignore */ }
      state.child = undefined;
      state.started = false;
      throw error;
    }
  })();

  const startGeneration = (state.startGeneration += 1);
  state.startPromise = startPromise;
  try {
    await startPromise;
    scheduleIdleStop(settings, options);
  } finally {
    // Clear only if this start still owns `startPromise`; a concurrent stop()
    // or a newer ensureRunning() bumps `startGeneration`, so a stale finally
    // must not clobber the replacement.
    if (state.startGeneration === startGeneration) state.startPromise = undefined;
  }
}

/**
 * Reset the idle stop timer. Call this after a successful use of the
 * managed SearXNG instance so the idle window slides forward.
 */
export function noteSearxngSidecarUse(): void {
  if (!state.settings || !state.options) return;
  if (!state.started || state.stopped) return;
  scheduleIdleStop(state.settings, state.options);
}

/**
 * Stop the managed SearXNG sidecar.
 *
 * Called on idle-timer fire (`reason: "idle"`), on `session_shutdown`
 * (`reason: "shutdown"`), and any time the caller wants to force a stop.
 * Idempotent: a second call is a no-op.
 *
 * Stop strategy:
 *   1. If `stopCommand` is set, spawn it with `shell: false` and wait a
 *      short bounded window for the spawned process to exit.
 *   2. If `stopCommand` is unset or its child does not exit promptly,
 *      send SIGTERM to the original start child when that process is still
 *      alive.
 *
 * Errors are swallowed: shutdown must not throw out into Pi's session
 * lifecycle handlers.
 */
export async function shutdownSearxngSidecar(
  opts: { reason?: "idle" | "shutdown" | "manual" } = {},
): Promise<void> {
  if (state.stopped) return;
  state.stopped = true;
  const settings = state.settings;
  const options = state.options ?? {};
  const timer = options.timer ?? REAL_TIMER;
  if (state.idleTimer !== undefined) timer.clearTimeout(state.idleTimer);
  state.idleTimer = undefined;
  const child = state.child;
  const wasStarted = state.started;
  state.child = undefined;
  state.startPromise = undefined;
  state.started = false;
  if (!wasStarted && !child) return;
  // 1) Run the user stop command (best-effort, bounded).
  //
  // The bounded wait uses a real, unref'd Node timer rather than the
  // test-injected `timer` because tests routinely use a fake timer for
  // the idle window but never advance it past the defensive 10-second
  // stop-wait cap. A real unref'd timer lets node:test exit cleanly
  // while still bounding the wait in production, and the test stub
  // can emit `exit` on the spawned stop child via `setImmediate` to
  // resolve the wait immediately.
  if (settings?.stopCommand && settings.stopCommand.length > 0) {
    try {
      const spawnImpl = options.spawn ?? (await import("node:child_process")).spawn;
      const [cmd, ...args] = settings.stopCommand;
      const stop = spawnImpl(cmd!, args, {
        stdio: "ignore",
        detached: false,
        shell: false,
        cwd: options.cwd ?? process.cwd(),
      });
      await new Promise<void>((resolve) => {
        let resolved = false;
        const done = () => {
          if (resolved) return;
          resolved = true;
          resolve();
        };
        const stopTimeoutMs = 10_000;
        const t = setTimeout(done, stopTimeoutMs);
        if (typeof (t as { unref?: () => void }).unref === "function") {
          (t as { unref: () => void }).unref();
        }
        stop.once("exit", () => {
          clearTimeout(t);
          done();
        });
        stop.once("error", () => {
          clearTimeout(t);
          done();
        });
      });
    } catch {
      // Swallow: fall through to SIGTERM fallback.
    }
  }
  // 2) Fallback: SIGTERM the original child if it is still alive.
  try {
    if (child && child.exitCode === null && child.killed === false) {
      child.kill("SIGTERM");
    }
  } catch {
    // Swallow.
  }
  void opts;
}
