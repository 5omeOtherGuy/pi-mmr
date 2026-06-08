import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

const REGISTRY_MODULE = "extensions/mmr-subagents/async-task-registry.ts";

after(cleanupLoadedSource);

function makeWorkerResult(overrides = {}) {
  return {
    messages: [],
    finalOutput: "ok",
    truncatedFinalOutput: "ok",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 1, turns: 1 },
    prompt: "",
    cwd: "",
    command: "pi",
    args: [],
    exitCode: 0,
    signal: null,
    stderr: "",
    aborted: false,
    outputTruncated: false,
    ignoredJsonLines: 0,
    agentStarted: true,
    trail: [],
    ...overrides,
  };
}

/** Controllable run thunk: capture signal/onProgress and resolve on demand. */
function makeDeferredRun() {
  let resolveFn;
  let rejectFn;
  const captured = {};
  const run = ({ signal, onProgress }) => {
    captured.signal = signal;
    captured.onProgress = onProgress;
    return new Promise((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
  };
  return { run, captured, resolve: (r) => resolveFn(r), reject: (e) => rejectFn(e) };
}

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function startArgs(overrides = {}) {
  return {
    sessionKey: "sess-A",
    originToolCallId: overrides.originToolCallId ?? "call-1",
    description: "do a thing",
    prompt: "prompt body",
    cwd: "/repo",
    resolvedModel: "prov/model",
    workerTools: ["read", "bash"],
    deliveryOptIn: overrides.deliveryOptIn ?? (overrides.groupId !== undefined ? false : overrides.notify !== undefined),
    ...overrides,
  };
}

describe("async-task-registry singleton", () => {
  it("returns the same process singleton and a distinct fresh instance", async () => {
    const mod = await importSource(REGISTRY_MODULE);
    const a = mod.getMmrAsyncTaskRegistry();
    const b = mod.getMmrAsyncTaskRegistry();
    assert.equal(a, b, "getMmrAsyncTaskRegistry must return the process singleton");
    const fresh = mod.createMmrAsyncTaskRegistry();
    assert.notEqual(a, fresh, "createMmrAsyncTaskRegistry must build an isolated instance");
  });
});

describe("async-task-registry lifecycle", () => {
  it("defaults to ten concurrently running background task agents per session", async () => {
    const mod = await importSource(REGISTRY_MODULE);
    assert.equal(mod.DEFAULT_ASYNC_TASK_MAX_RUNNING_PER_SESSION, 10);
  });

  it("starts a task, surfaces progress, and stores a succeeded terminal result", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    let clock = 1000;
    const reg = createMmrAsyncTaskRegistry({ nowMs: () => clock, idFactory: () => "task_x" });
    const d = makeDeferredRun();
    const started = reg.startTask(startArgs({ run: d.run }));
    assert.equal(started.ok, true);
    assert.equal(started.deduplicated, false);
    assert.equal(started.snapshot.taskId, "task_x");
    assert.equal(started.snapshot.status, "running");
    assert.equal(started.snapshot.freshness, "healthy");

    // Progress update is reflected in the snapshot.
    clock = 1500;
    d.captured.onProgress(makeWorkerResult({ finalOutput: "partial", truncatedFinalOutput: "partial" }));
    let snap = reg.getTask("sess-A", "task_x");
    assert.equal(snap.latestProgress.finalOutput, "partial");
    assert.equal(snap.lastProgressAtMs, 1500);

    clock = 2000;
    d.resolve(makeWorkerResult({ finalOutput: "all done", truncatedFinalOutput: "all done" }));
    await flush();
    snap = reg.getTask("sess-A", "task_x");
    assert.equal(snap.status, "succeeded");
    assert.equal(snap.freshness, "terminal");
    assert.equal(snap.finalResult.finalOutput, "all done");
    assert.equal(snap.completedAtMs, 2000);
    assert.equal(snap.runtimeMs, 1000);
  });

  it("stores a partial terminal outcome separately from lifecycle status", async () => {
    const { createMmrAsyncTaskRegistry, toPublicAsyncTaskSnapshot } = await importSource(REGISTRY_MODULE);
    const reg = createMmrAsyncTaskRegistry({ idFactory: () => "t" });
    const d = makeDeferredRun();
    reg.startTask(startArgs({ run: d.run }));
    d.resolve(makeWorkerResult({ outputTruncated: true, finalOutput: "full answer", truncatedFinalOutput: "clipped answer" }));
    await flush();

    const snap = reg.getTask("sess-A", "t");
    assert.equal(snap.status, "succeeded", "partial is result quality, not a lifecycle status");
    assert.equal(snap.terminalOutcome, "partial");
    assert.equal(reg.listTasks("sess-A").finished[0].terminalOutcome, "partial");
    assert.equal(toPublicAsyncTaskSnapshot(snap).terminalOutcome, "partial");
  });

  it("uses precomputed terminal outcomes for tool-result runs only", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    let n = 0;
    const reg = createMmrAsyncTaskRegistry({ idFactory: () => `tool-${n++}` });
    const done = { content: [{ type: "text", text: "done" }], details: { status: "success" } };

    reg.startTask(startArgs({ originToolCallId: "with", run: async () => ({ toolResult: done, terminalOutcome: "partial" }) }));
    await flush();
    assert.equal(reg.getTask("sess-A", "tool-0").terminalOutcome, "partial");

    reg.startTask(startArgs({ originToolCallId: "without", run: async () => ({ toolResult: done }) }));
    await flush();
    assert.equal(reg.getTask("sess-A", "tool-1").terminalOutcome, undefined);
  });

  it("projects cheap progress metadata into the board for the background widget", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    let clock = 1000;
    const reg = createMmrAsyncTaskRegistry({ nowMs: () => clock, idFactory: () => "task_x" });
    const d = makeDeferredRun();
    reg.startTask(startArgs({ run: d.run, contextWindow: 200_000 }));

    clock = 66_000;
    d.captured.onProgress(makeWorkerResult({
      usage: { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 50_000, turns: 2 },
      model: "openai/gpt-5.5",
      trail: [
        { type: "tool", toolCallId: "tool-1", toolName: "read", status: "completed" },
        { type: "tool", toolCallId: "tool-2", toolName: "bash", status: "running" },
      ],
    }));

    const entry = reg.listTasks("sess-A").active[0];
    assert.equal(entry.runtimeMs, 65_000);
    assert.equal(entry.resolvedModel, "openai/gpt-5.5");
    assert.equal(entry.contextWindow, 200_000);
    assert.deepEqual(entry.usage, { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 50_000, turns: 2 });
    assert.equal(entry.latestToolName, "bash");
    assert.equal(entry.latestToolStatus, "running");
    assert.equal(entry.toolCount, 2);
  });

  it("does NOT bind the worker to any external signal; the registry owns the AbortController", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    const reg = createMmrAsyncTaskRegistry();
    const d = makeDeferredRun();
    reg.startTask(startArgs({ run: d.run }));
    assert.ok(d.captured.signal instanceof AbortSignal);
    assert.equal(d.captured.signal.aborted, false);
    d.resolve(makeWorkerResult());
    await flush();
  });

  it("maps a runner rejection to a failed terminal status", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    const reg = createMmrAsyncTaskRegistry();
    const d = makeDeferredRun();
    reg.startTask(startArgs({ run: d.run }));
    d.reject(new Error("boom"));
    await flush();
    const snap = reg.getTask("sess-A", "call-1-task");
    const found = reg.listTasks("sess-A").finished[0];
    assert.equal(found.status, "failed");
    assert.match(found.errorMessage, /boom/);
    void snap;
  });

  it("maps spawn/activation errors and non-zero exits to failed", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    const reg = createMmrAsyncTaskRegistry({ idFactory: () => "t" });
    const d = makeDeferredRun();
    reg.startTask(startArgs({ run: d.run }));
    d.resolve(makeWorkerResult({ spawnError: "spawn ENOENT", exitCode: null }));
    await flush();
    const snap = reg.getTask("sess-A", "t");
    assert.equal(snap.status, "failed");
    assert.match(snap.errorMessage, /ENOENT/);
  });
});

describe("async-task-registry cancellation", () => {
  it("cancels a running task, aborts the controller, and marks it cancelled", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    const reg = createMmrAsyncTaskRegistry({ idFactory: () => "t", cancelDeadAfterMs: 50 });
    const d = makeDeferredRun();
    reg.startTask(startArgs({ run: d.run }));

    const cancelPromise = reg.cancelTask({ sessionKey: "sess-A", taskId: "t", reason: "obsolete" });
    // The registry aborted its own controller; the worker observes it.
    assert.equal(d.captured.signal.aborted, true);
    // The worker now settles as aborted.
    d.resolve(makeWorkerResult({ aborted: true, signal: "SIGTERM", exitCode: null }));
    const snap = await cancelPromise;
    await flush();
    assert.equal(snap.status, "cancelled");
    assert.equal(reg.getTask("sess-A", "t").status, "cancelled");
  });

  it("does not auto-deliver a result returned by cancelTask", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    const calls = [];
    const reg = createMmrAsyncTaskRegistry({ idFactory: () => "t", cancelDeadAfterMs: 50 });
    const d = makeDeferredRun();
    reg.startTask(startArgs({ run: d.run, notify: (snap) => calls.push(snap.taskId) }));

    const cancelPromise = reg.cancelTask({ sessionKey: "sess-A", taskId: "t", reason: "obsolete" });
    d.resolve(makeWorkerResult({ aborted: true, signal: "SIGTERM", exitCode: null }));
    const snap = await cancelPromise;
    await flush();

    assert.equal(snap.status, "cancelled");
    assert.deepEqual(calls, [], "task_cancel consumed the terminal result, so automatic delivery is stale");
    assert.equal(reg.getTask("sess-A", "t").completionPush, "observed");
  });

  it("is idempotent: cancelling a terminal task returns its terminal snapshot", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    const reg = createMmrAsyncTaskRegistry({ idFactory: () => "t" });
    const d = makeDeferredRun();
    reg.startTask(startArgs({ run: d.run }));
    d.resolve(makeWorkerResult());
    await flush();
    const snap = await reg.cancelTask({ sessionKey: "sess-A", taskId: "t" });
    assert.equal(snap.status, "succeeded");
  });

  it("late success after a cancel request does not overwrite the cancellation", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    const reg = createMmrAsyncTaskRegistry({ idFactory: () => "t", cancelDeadAfterMs: 50 });
    const d = makeDeferredRun();
    reg.startTask(startArgs({ run: d.run }));
    const cancelPromise = reg.cancelTask({ sessionKey: "sess-A", taskId: "t" });
    assert.equal(d.captured.signal.aborted, true);
    // Worker eventually returns a non-aborted success: cancellation must still win.
    d.resolve(makeWorkerResult({ aborted: false, exitCode: 0 }));
    const snap = await cancelPromise;
    await flush();
    assert.equal(snap.status, "cancelled");
    assert.equal(reg.getTask("sess-A", "t").status, "cancelled");
  });

  it("manual cancellation wins when the worker rejects during abort", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    const reg = createMmrAsyncTaskRegistry({ idFactory: () => "t", cancelDeadAfterMs: 50 });
    const d = makeDeferredRun();
    reg.startTask(startArgs({ run: d.run }));
    const cancelPromise = reg.cancelTask({ sessionKey: "sess-A", taskId: "t" });
    d.reject(new Error("abort surfaced as rejection"));
    const snap = await cancelPromise;
    await flush();
    assert.equal(snap.status, "cancelled");
    assert.equal(reg.getTask("sess-A", "t").status, "cancelled");
  });

  it("finalizes an abort-ignoring cancellation as failed/dead and frees the concurrency cap", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    let n = 0;
    const reg = createMmrAsyncTaskRegistry({
      idFactory: () => `t${n++}`,
      maxRunningPerSession: 1,
      cancelDeadAfterMs: 20,
    });
    const d = makeDeferredRun();
    assert.equal(reg.startTask(startArgs({ run: d.run, originToolCallId: "c0" })).ok, true);
    const snap = await reg.cancelTask({ sessionKey: "sess-A", taskId: "t0" });
    assert.equal(snap.status, "failed");
    assert.equal(snap.terminalFreshness, "dead");
    const next = makeDeferredRun();
    const started = reg.startTask(startArgs({ run: next.run, originToolCallId: "c1" }));
    assert.equal(started.ok, true, "dead cancelled tasks must not consume the running cap");
    next.resolve(makeWorkerResult());
    d.resolve(makeWorkerResult({ aborted: false, exitCode: 0, finalOutput: "late" }));
    await flush();
    assert.equal(reg.getTask("sess-A", "t0").status, "failed", "late success must be ignored after dead finalization");
  });
});

describe("async-task-registry caps, idempotency, and isolation", () => {
  it("rejects starts past the per-session concurrency cap without spawning", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    let n = 0;
    const reg = createMmrAsyncTaskRegistry({ maxRunningPerSession: 2, idFactory: () => `t${n++}` });
    const runs = [makeDeferredRun(), makeDeferredRun(), makeDeferredRun()];
    assert.equal(reg.startTask(startArgs({ run: runs[0].run, originToolCallId: "c0" })).ok, true);
    assert.equal(reg.startTask(startArgs({ run: runs[1].run, originToolCallId: "c1" })).ok, true);
    const third = reg.startTask(startArgs({ run: runs[2].run, originToolCallId: "c2" }));
    assert.equal(third.ok, false);
    assert.equal(third.reason, "concurrency-cap");
    assert.equal(third.cap, 2);
    assert.equal(runs[2].captured.signal, undefined, "capped start must not invoke the runner");
    runs[0].resolve(makeWorkerResult());
    runs[1].resolve(makeWorkerResult());
    await flush();
  });

  it("deduplicates a retried start with the same originToolCallId", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    let n = 0;
    const reg = createMmrAsyncTaskRegistry({ idFactory: () => `t${n++}` });
    const d = makeDeferredRun();
    const first = reg.startTask(startArgs({ run: d.run, originToolCallId: "same" }));
    const second = reg.startTask(startArgs({ run: makeDeferredRun().run, originToolCallId: "same" }));
    assert.equal(second.ok, true);
    assert.equal(second.deduplicated, true);
    assert.equal(second.snapshot.taskId, first.snapshot.taskId);
    assert.equal(reg.listTasks("sess-A").active.length, 1);
    d.resolve(makeWorkerResult());
    await flush();
  });

  it("keeps records partitioned per session", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    let n = 0;
    const reg = createMmrAsyncTaskRegistry({ idFactory: () => `t${n++}` });
    const a = makeDeferredRun();
    const b = makeDeferredRun();
    reg.startTask(startArgs({ run: a.run, sessionKey: "sess-A", originToolCallId: "a" }));
    reg.startTask(startArgs({ run: b.run, sessionKey: "sess-B", originToolCallId: "b" }));
    assert.equal(reg.listTasks("sess-A").counts.active, 1);
    assert.equal(reg.listTasks("sess-B").counts.active, 1);
    assert.equal(reg.getTask("sess-A", "t1"), undefined, "session A must not see session B's task");
    a.resolve(makeWorkerResult());
    b.resolve(makeWorkerResult());
    await flush();
  });

  it("ignores progress after a terminal transition (late-write guard)", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    const reg = createMmrAsyncTaskRegistry({ idFactory: () => "t" });
    const d = makeDeferredRun();
    reg.startTask(startArgs({ run: d.run }));
    const onProgress = d.captured.onProgress;
    d.resolve(makeWorkerResult({ finalOutput: "final" }));
    await flush();
    onProgress(makeWorkerResult({ finalOutput: "late ghost" }));
    const snap = reg.getTask("sess-A", "t");
    assert.equal(snap.status, "succeeded");
    assert.notEqual(snap.latestProgress?.finalOutput, "late ghost");
  });
});

describe("async-task-registry freshness, TTL, watchdog, shutdown", () => {
  it("classifies a silent run as stalled (advisory) without killing it", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    let clock = 0;
    const reg = createMmrAsyncTaskRegistry({
      nowMs: () => clock,
      idFactory: () => "t",
      stalledAfterMs: 100,
      maxRuntimeMs: 10_000,
    });
    const d = makeDeferredRun();
    reg.startTask(startArgs({ run: d.run }));
    clock = 250;
    const snap = reg.getTask("sess-A", "t");
    assert.equal(snap.status, "running");
    assert.equal(snap.freshness, "stalled");
    assert.equal(d.captured.signal.aborted, false, "stalled must not abort the worker");
    d.resolve(makeWorkerResult());
    await flush();
  });

  it("watchdog aborts a runaway task and finalizes it as failed/dead, not silent delete", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    let clock = 0;
    const reg = createMmrAsyncTaskRegistry({ nowMs: () => clock, idFactory: () => "t", maxRuntimeMs: 1000 });
    const d = makeDeferredRun();
    reg.startTask(startArgs({ run: d.run }));
    clock = 2000;
    reg.prune("sess-A");
    assert.equal(d.captured.signal.aborted, true, "watchdog must abort the controller");
    assert.ok(reg.getTask("sess-A", "t"), "watchdog must not silently delete the record");
    d.resolve(makeWorkerResult({ aborted: true, exitCode: null }));
    await flush();
    const snap = reg.getTask("sess-A", "t");
    assert.equal(snap.status, "failed");
    assert.equal(snap.terminalFreshness, "dead");
    assert.equal(snap.terminalOutcome, "failed");
  });

  it("watchdog expiry remains failed/dead when the worker rejects during abort", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    let clock = 0;
    const reg = createMmrAsyncTaskRegistry({ nowMs: () => clock, idFactory: () => "t", maxRuntimeMs: 1000 });
    const d = makeDeferredRun();
    reg.startTask(startArgs({ run: d.run }));
    clock = 2000;
    reg.prune("sess-A");
    d.reject(new Error("abort surfaced as rejection"));
    await flush();
    const snap = reg.getTask("sess-A", "t");
    assert.equal(snap.status, "failed");
    assert.equal(snap.terminalFreshness, "dead");
    assert.match(snap.errorMessage, /maximum runtime/);
  });

  it("prunes unobserved terminal records after the long TTL, observed ones after the short TTL", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    let clock = 0;
    const reg = createMmrAsyncTaskRegistry({
      nowMs: () => clock,
      idFactory: () => "t",
      terminalTtlMs: 1000,
      observedTerminalTtlMs: 100,
    });
    const d = makeDeferredRun();
    reg.startTask(startArgs({ run: d.run }));
    clock = 10;
    d.resolve(makeWorkerResult());
    await flush();
    // Not observed: survives until the long TTL.
    clock = 500;
    assert.ok(reg.listTasks("sess-A").finished.length === 1);
    // Observe it (direct poll), then the short TTL applies.
    reg.getTask("sess-A", "t");
    clock = 650;
    assert.equal(reg.listTasks("sess-A").finished.length, 0, "observed terminal record should prune after short TTL");
  });

  it("shuts a session down: aborts active controllers and clears records", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    const reg = createMmrAsyncTaskRegistry({ idFactory: () => "t" });
    const d = makeDeferredRun();
    reg.startTask(startArgs({ run: d.run }));
    reg.shutdownSession("sess-A", "quit");
    assert.equal(d.captured.signal.aborted, true);
    assert.equal(reg.getTask("sess-A", "t"), undefined);
    d.resolve(makeWorkerResult({ aborted: true, exitCode: null }));
    await flush();
  });
});

describe("async-task-registry wait + completion push", () => {
  it("waitForTask resolves on completion and never aborts on timeout", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    const reg = createMmrAsyncTaskRegistry({ idFactory: () => "t" });
    const d = makeDeferredRun();
    reg.startTask(startArgs({ run: d.run }));

    // Timeout path: returns timedOut, does not abort.
    const timedOut = await reg.waitForTask({ sessionKey: "sess-A", taskId: "t", timeoutMs: 5 });
    assert.equal(timedOut.timedOut, true);
    assert.equal(timedOut.snapshot.status, "running");
    assert.equal(d.captured.signal.aborted, false);

    // Completion path: resolves promptly once the worker settles.
    const waitPromise = reg.waitForTask({ sessionKey: "sess-A", taskId: "t", timeoutMs: 5000 });
    d.resolve(makeWorkerResult({ finalOutput: "done" }));
    const settled = await waitPromise;
    assert.equal(settled.timedOut, false);
    assert.equal(settled.snapshot.status, "succeeded");

    const missing = await reg.waitForTask({ sessionKey: "sess-A", taskId: "nope", timeoutMs: 1 });
    assert.equal(missing.found, false);
  });

  it("fires the completion notifier exactly once on terminal transition", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    const reg = createMmrAsyncTaskRegistry({ idFactory: () => "t" });
    const d = makeDeferredRun();
    const calls = [];
    reg.startTask(startArgs({ run: d.run, notify: (snap) => calls.push(snap) }));
    d.resolve(makeWorkerResult({ finalOutput: "done" }));
    await flush();
    // Subsequent polls/cancels must not re-fire the notifier.
    reg.getTask("sess-A", "t");
    await reg.cancelTask({ sessionKey: "sess-A", taskId: "t" });
    await flush();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].status, "succeeded");
    assert.equal(reg.getTask("sess-A", "t").completionPush, "observed");
  });

  it("suppresses the completion push when a blocked waitForTask observes the result", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    const reg = createMmrAsyncTaskRegistry({ idFactory: () => "t" });
    const d = makeDeferredRun();
    const calls = [];
    reg.startTask(startArgs({ run: d.run, notify: (snap) => calls.push(snap) }));
    // Parent is actively blocked in waitForTask: it WILL observe the terminal
    // result, so an additional push would only duplicate a result in hand.
    const waitPromise = reg.waitForTask({ sessionKey: "sess-A", taskId: "t", timeoutMs: 5000 });
    d.resolve(makeWorkerResult({ finalOutput: "done" }));
    const settled = await waitPromise;
    await flush();
    assert.equal(settled.snapshot.status, "succeeded");
    assert.equal(calls.length, 0, "a result observed by a blocked wait must not also push");
    assert.equal(reg.getTask("sess-A", "t").completionPush, "observed");
  });

  it("still pushes when a wait times out before the task settles", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    const reg = createMmrAsyncTaskRegistry({ idFactory: () => "t" });
    const d = makeDeferredRun();
    const calls = [];
    reg.startTask(startArgs({ run: d.run, notify: (snap) => calls.push(snap.taskId) }));
    // A timed-out wait leaves no active observer, so the push must still fire.
    const timedOut = await reg.waitForTask({ sessionKey: "sess-A", taskId: "t", timeoutMs: 5 });
    assert.equal(timedOut.timedOut, true);
    d.resolve(makeWorkerResult({ finalOutput: "done" }));
    await flush();
    assert.deepEqual(calls, ["t"], "a timed-out wait left no observer, so the push must still fire");
    assert.equal(reg.listTasks("sess-A").finished[0].completionPush, "announced");
  });

  it("does not enable completion push when no notifier is provided", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    const reg = createMmrAsyncTaskRegistry({ idFactory: () => "t" });
    const d = makeDeferredRun();
    const started = reg.startTask(startArgs({ run: d.run }));
    assert.equal(started.snapshot.completionPush, "disabled");
    d.resolve(makeWorkerResult());
    await flush();
    assert.equal(reg.getTask("sess-A", "t").completionPush, "disabled");
  });

  it("marks the completion push failed (no retry) when the notifier rejects", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    const reg = createMmrAsyncTaskRegistry({ idFactory: () => "t" });
    const d = makeDeferredRun();
    let notifyCalls = 0;
    reg.startTask(startArgs({
      run: d.run,
      notify: async () => {
        notifyCalls += 1;
        throw new Error("push boom");
      },
    }));
    // A timed-out wait leaves no observer, so the push fires and then rejects.
    const timedOut = await reg.waitForTask({ sessionKey: "sess-A", taskId: "t", timeoutMs: 5 });
    assert.equal(timedOut.timedOut, true);
    d.resolve(makeWorkerResult({ finalOutput: "done" }));
    await flush();
    // Read via listTasks (getTask marks the item observed) to see the push outcome.
    assert.equal(reg.listTasks("sess-A").finished[0].completionPush, "failed");
    // A failed push must never be retried: exactly one notifier invocation.
    await flush();
    assert.equal(notifyCalls, 1, "a rejected push must not be retried");
  });
});

describe("async-task-registry audit regressions", () => {
  it("actively aborts a runaway task via the max-runtime watchdog without any poll/prune", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    const reg = createMmrAsyncTaskRegistry({ idFactory: () => "t", maxRuntimeMs: 20 });
    const d = makeDeferredRun();
    reg.startTask(startArgs({ run: d.run }));
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(d.captured.signal.aborted, true, "watchdog timer must abort with no external poll");
    d.resolve(makeWorkerResult({ aborted: true, exitCode: null }));
    await flush();
    const snap = reg.getTask("sess-A", "t");
    assert.equal(snap.status, "failed");
    assert.equal(snap.terminalFreshness, "dead");
  });

  it("session shutdown invalidates a late finalize/notify and clears the tool-call index", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    let n = 0;
    const reg = createMmrAsyncTaskRegistry({ idFactory: () => `t${n++}` });
    const d = makeDeferredRun();
    const calls = [];
    reg.startTask(startArgs({ run: d.run, originToolCallId: "dup", notify: (s) => calls.push(s) }));
    reg.shutdownSession("sess-A", "quit");
    // Worker resolves AFTER shutdown: must not notify or resurrect state.
    d.resolve(makeWorkerResult({ finalOutput: "ghost" }));
    await flush();
    assert.equal(calls.length, 0, "no completion push may fire after shutdown");
    assert.equal(reg.getTask("sess-A", "t0"), undefined);
    // Index was cleared: the same originToolCallId starts a fresh task.
    const d2 = makeDeferredRun();
    const again = reg.startTask(startArgs({ run: d2.run, originToolCallId: "dup" }));
    assert.equal(again.deduplicated, false, "shutdown must clear the tool-call idempotency index");
    d2.resolve(makeWorkerResult());
    await flush();
  });

  it("waitForTask resolves with a cancelled snapshot after session shutdown", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    const reg = createMmrAsyncTaskRegistry({ idFactory: () => "t" });
    const d = makeDeferredRun();
    reg.startTask(startArgs({ run: d.run }));
    const waitP = reg.waitForTask({ sessionKey: "sess-A", taskId: "t", timeoutMs: 5000 });
    reg.shutdownSession("sess-A", "quit");
    const res = await waitP;
    assert.equal(res.found, true);
    assert.equal(res.timedOut, false);
    assert.equal(res.snapshot.status, "cancelled");
    d.resolve(makeWorkerResult({ aborted: true, exitCode: null }));
    await flush();
  });
});

describe("async-task-registry worker groups", () => {
  it("mints group ids and lets multiple startTask calls attach without idempotency collapse", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    let taskN = 0;
    const reg = createMmrAsyncTaskRegistry({ idFactory: () => `t${taskN++}`, groupIdFactory: () => "group_abc123" });
    const group = reg.openGroup({ sessionKey: "sess-A", deliveryOptIn: false });
    assert.equal(group.groupId, "group_abc123");

    const first = makeDeferredRun();
    const second = makeDeferredRun();
    const a = reg.startTask(startArgs({ run: first.run, originToolCallId: "c0", groupId: group.groupId }));
    const b = reg.startTask(startArgs({ run: second.run, originToolCallId: "c1", groupId: group.groupId }));

    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.notEqual(a.snapshot.taskId, b.snapshot.taskId);
    assert.equal(a.snapshot.groupId, group.groupId);
    assert.equal(b.snapshot.groupId, group.groupId);
    const snapshot = reg.getGroup("sess-A", group.groupId);
    assert.equal(snapshot.status, "running");
    assert.deepEqual(snapshot.taskIds, ["t0", "t1"]);
    first.resolve(makeWorkerResult());
    second.resolve(makeWorkerResult());
    await flush();
  });

  it("computes group status precedence over child lifecycle and terminal outcomes", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    let n = 0;
    const reg = createMmrAsyncTaskRegistry({ idFactory: () => `t${n++}` });
    const groupId = "group_c0ffee";
    const runs = [makeDeferredRun(), makeDeferredRun(), makeDeferredRun()];
    for (let i = 0; i < runs.length; i += 1) {
      reg.startTask(startArgs({ run: runs[i].run, originToolCallId: `c${i}`, groupId }));
    }

    runs[0].resolve(makeWorkerResult());
    runs[1].resolve(makeWorkerResult({ outputTruncated: true }));
    await flush();
    assert.equal(reg.getGroup("sess-A", groupId).status, "running", "non-terminal children dominate");

    runs[2].resolve(makeWorkerResult());
    await flush();
    const partialGroup = reg.getGroup("sess-A", groupId);
    assert.equal(partialGroup.status, "partial", "partial beats completed after all children are terminal");
    assert.deepEqual(
      partialGroup.counts,
      { running: 0, succeeded: 2, failed: 0, cancelled: 0, partial: 1, total: 3 },
      "partial children must not also count as succeeded",
    );

    const failed = makeDeferredRun();
    reg.startTask(startArgs({ run: failed.run, originToolCallId: "failed", groupId: "group_badbad" }));
    failed.resolve(makeWorkerResult({ exitCode: 1, finalOutput: "", truncatedFinalOutput: "" }));
    await flush();
    assert.equal(reg.getGroup("sess-A", "group_badbad").status, "failed");
  });

  it("waits for all group children and observes only the terminal group", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    let clock = 0;
    let n = 0;
    const reg = createMmrAsyncTaskRegistry({
      nowMs: () => clock,
      idFactory: () => `t${n++}`,
      terminalTtlMs: 1000,
      observedTerminalTtlMs: 100,
    });
    const groupId = "group_dedede";
    const first = makeDeferredRun();
    const second = makeDeferredRun();
    reg.startTask(startArgs({ run: first.run, originToolCallId: "c0", groupId }));
    reg.startTask(startArgs({ run: second.run, originToolCallId: "c1", groupId }));

    clock = 10;
    first.resolve(makeWorkerResult());
    await flush();
    const timedOut = await reg.waitForGroup({ sessionKey: "sess-A", groupId, timeoutMs: 5 });
    assert.equal(timedOut.timedOut, true);
    assert.equal(second.captured.signal.aborted, false, "group wait timeout must not cancel children");
    clock = 200;
    assert.equal(reg.listTasks("sess-A").finished.length, 1, "timed-out group wait must not shorten child TTL");

    clock = 250;
    second.resolve(makeWorkerResult());
    await flush();
    const settled = await reg.waitForGroup({ sessionKey: "sess-A", groupId, timeoutMs: 5 });
    assert.equal(settled.timedOut, false);
    assert.equal(settled.snapshot.status, "completed");
    clock = 400;
    assert.equal(reg.listTasks("sess-A").finished.length, 2, "terminal group wait must not mark child outputs observed");
  });

  it("cancels every non-terminal child in a group", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    let n = 0;
    const reg = createMmrAsyncTaskRegistry({ idFactory: () => `t${n++}`, cancelDeadAfterMs: 30 });
    const groupId = "group_f00baa";
    const first = makeDeferredRun();
    const second = makeDeferredRun();
    reg.startTask(startArgs({ run: first.run, originToolCallId: "c0", groupId }));
    reg.startTask(startArgs({ run: second.run, originToolCallId: "c1", groupId }));

    const cancelled = reg.cancelGroup({ sessionKey: "sess-A", groupId, reason: "obsolete group" });
    assert.equal(first.captured.signal.aborted, true);
    assert.equal(second.captured.signal.aborted, true);
    first.resolve(makeWorkerResult({ aborted: true, signal: "SIGTERM", exitCode: null }));
    second.resolve(makeWorkerResult({ aborted: true, signal: "SIGTERM", exitCode: null }));
    const result = await cancelled;
    assert.equal(result.status, "cancelled");
  });

  it("uses one grouped completion push instead of child pushes", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    let n = 0;
    const calls = [];
    const reg = createMmrAsyncTaskRegistry({ idFactory: () => `t${n++}`, maxCompletionPushesPerSession: 1 });
    const group = reg.openGroup({ sessionKey: "sess-A", groupId: "group_beaded", deliveryOptIn: true, notify: (snap) => calls.push(snap.groupId) });
    const first = makeDeferredRun();
    const second = makeDeferredRun();
    reg.startTask(startArgs({ run: first.run, originToolCallId: "c0", groupId: group.groupId, notify: (snap) => calls.push(snap.taskId) }));
    reg.startTask(startArgs({ run: second.run, originToolCallId: "c1", groupId: group.groupId, notify: (snap) => calls.push(snap.taskId) }));

    first.resolve(makeWorkerResult());
    second.resolve(makeWorkerResult());
    await flush();
    assert.deepEqual(calls, ["group_beaded"]);
    assert.equal(reg.getGroup("sess-A", "group_beaded").completionPush, "announced");
    assert.equal(reg.getTask("sess-A", "t0").completionPush, "disabled");
    assert.equal(reg.getTask("sess-A", "t1").completionPush, "disabled");
  });

  it("marks the grouped completion push failed (no retry) when the group notifier rejects", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    let n = 0;
    let notifyCalls = 0;
    const reg = createMmrAsyncTaskRegistry({ idFactory: () => `t${n++}` });
    const group = reg.openGroup({
      sessionKey: "sess-A",
      groupId: "group_beaded",
      deliveryOptIn: true,
      notify: async () => {
        notifyCalls += 1;
        throw new Error("group push boom");
      },
    });
    const first = makeDeferredRun();
    const second = makeDeferredRun();
    reg.startTask(startArgs({ run: first.run, originToolCallId: "c0", groupId: group.groupId }));
    reg.startTask(startArgs({ run: second.run, originToolCallId: "c1", groupId: group.groupId }));

    first.resolve(makeWorkerResult());
    second.resolve(makeWorkerResult());
    await flush();
    assert.equal(reg.getGroup("sess-A", "group_beaded").completionPush, "failed");
    // A rejected group push must not be retried on subsequent reads.
    reg.getGroup("sess-A", "group_beaded");
    await flush();
    assert.equal(notifyCalls, 1, "a rejected group push must not be retried");
  });

  it("stores an explicit group label and emits it in the group snapshot", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    const reg = createMmrAsyncTaskRegistry({ groupIdFactory: () => "group_abc123" });
    const group = reg.openGroup({ sessionKey: "sess-A", deliveryOptIn: false, label: "Explore order services" });
    assert.equal(group.label, "Explore order services");
    assert.equal(reg.getGroup("sess-A", "group_abc123").label, "Explore order services");
  });

  it("keeps the first label set-once when the same group id is reopened", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    const reg = createMmrAsyncTaskRegistry();
    reg.openGroup({ sessionKey: "sess-A", groupId: "group_abc123", deliveryOptIn: false, label: "First" });
    const second = reg.openGroup({ sessionKey: "sess-A", groupId: "group_abc123", deliveryOptIn: false, label: "Second" });
    assert.equal(second.label, "First", "a later opener must not clobber the first label");
    assert.equal(reg.getGroup("sess-A", "group_abc123").label, "First");
  });

  it("falls back to the earliest-created child description when no label is set", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    let clock = 1000;
    const reg = createMmrAsyncTaskRegistry({ nowMs: () => clock, idFactory: () => `t${clock}` });
    const group = reg.openGroup({ sessionKey: "sess-A", groupId: "group_abc123", deliveryOptIn: false });
    assert.equal(group.label, undefined, "no label and no children yet means no resolved label");

    const first = makeDeferredRun();
    const second = makeDeferredRun();
    clock = 1000;
    reg.startTask(startArgs({ run: first.run, originToolCallId: "c0", groupId: "group_abc123", description: "earliest wins" }));
    clock = 2000;
    reg.startTask(startArgs({ run: second.run, originToolCallId: "c1", groupId: "group_abc123", description: "later loses" }));

    assert.equal(reg.getGroup("sess-A", "group_abc123").label, "earliest wins");
    first.resolve(makeWorkerResult());
    second.resolve(makeWorkerResult());
    await flush();
  });

  it("caps an over-long explicit label at ASYNC_TASK_GROUP_LABEL_MAX_LEN", async () => {
    const { createMmrAsyncTaskRegistry, ASYNC_TASK_GROUP_LABEL_MAX_LEN } = await importSource(REGISTRY_MODULE);
    assert.equal(ASYNC_TASK_GROUP_LABEL_MAX_LEN, 120);
    const reg = createMmrAsyncTaskRegistry({ groupIdFactory: () => "group_abc123" });
    const group = reg.openGroup({ sessionKey: "sess-A", deliveryOptIn: false, label: "x".repeat(200) });
    assert.equal(group.label.length, ASYNC_TASK_GROUP_LABEL_MAX_LEN);
  });
});

describe("toPublicAsyncTaskSnapshot", () => {
  it("projects a lean public view that omits prompt text and the full worker result", async () => {
    const { createMmrAsyncTaskRegistry, toPublicAsyncTaskSnapshot } =
      await importSource(REGISTRY_MODULE);
    const reg = createMmrAsyncTaskRegistry({ idFactory: () => "t" });
    const d = makeDeferredRun();
    reg.startTask(startArgs({ run: d.run, prompt: "SECRET PROMPT", description: "demo" }));
    d.resolve(makeWorkerResult({ finalOutput: "done", stderr: "noisy stderr" }));
    await flush();
    const internal = reg.getTask("sess-A", "t");
    assert.equal(internal.prompt, "SECRET PROMPT");
    assert.ok(internal.finalResult, "internal snapshot keeps the full worker result");

    const pub = toPublicAsyncTaskSnapshot(internal);
    // Identity/status/timing survive.
    assert.equal(pub.taskId, "t");
    assert.equal(pub.status, "succeeded");
    assert.equal(pub.description, "demo");
    assert.equal(typeof pub.runtimeMs, "number");
    // Light indicators, not payloads.
    assert.equal(pub.promptChars, "SECRET PROMPT".length);
    assert.equal(pub.hasFinalResult, true);
    assert.equal(pub.terminalOutcome, "success");
    // Sensitive / heavy fields are stripped.
    for (const key of ["prompt", "finalResult", "latestProgress", "cwd", "workerTools", "resolvedModel", "contextWindow"]) {
      assert.equal(key in pub, false, `public snapshot must not expose ${key}`);
    }
  });
});

describe("async-task-registry completion-push budget", () => {
  it("suppresses pushes once the per-session budget is exhausted", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    let n = 0;
    const reg = createMmrAsyncTaskRegistry({ idFactory: () => `t${n++}`, maxCompletionPushesPerSession: 1 });
    const calls = [];

    const d0 = makeDeferredRun();
    reg.startTask(startArgs({ run: d0.run, originToolCallId: "c0", notify: (s) => calls.push(s.taskId) }));
    d0.resolve(makeWorkerResult());
    await flush();
    assert.deepEqual(calls, ["t0"], "first push fires");
    assert.equal(reg.listTasks("sess-A").finished.find((e) => e.taskId === "t0")?.completionPush, "announced");

    const d1 = makeDeferredRun();
    reg.startTask(startArgs({ run: d1.run, originToolCallId: "c1", notify: (s) => calls.push(s.taskId) }));
    d1.resolve(makeWorkerResult());
    await flush();
    assert.deepEqual(calls, ["t0"], "second push is suppressed (budget exhausted)");
    assert.equal(reg.listTasks("sess-A").finished.find((e) => e.taskId === "t1")?.completionPush, "suppressed");
  });

  it("resets the per-session push budget on shutdown", async () => {
    const { createMmrAsyncTaskRegistry } = await importSource(REGISTRY_MODULE);
    let n = 0;
    const reg = createMmrAsyncTaskRegistry({ idFactory: () => `t${n++}`, maxCompletionPushesPerSession: 1 });
    const calls = [];

    const d0 = makeDeferredRun();
    reg.startTask(startArgs({ run: d0.run, originToolCallId: "c0", notify: (s) => calls.push(s.taskId) }));
    d0.resolve(makeWorkerResult());
    await flush();
    assert.equal(reg.listTasks("sess-A").finished.find((e) => e.taskId === "t0")?.completionPush, "announced");

    reg.shutdownSession("sess-A", "quit");

    const d1 = makeDeferredRun();
    reg.startTask(startArgs({ run: d1.run, originToolCallId: "c1", notify: (s) => calls.push(s.taskId) }));
    d1.resolve(makeWorkerResult());
    await flush();
    assert.deepEqual(calls, ["t0", "t1"], "budget cleared on shutdown so a fresh task can push again");
    assert.equal(reg.listTasks("sess-A").finished.find((e) => e.taskId === "t1")?.completionPush, "announced");
  });
});
