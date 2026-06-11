import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const repoRoot = path.resolve(import.meta.dirname, "..");
const asyncTasksExtensionPath = "./src/extensions/mmr-workers/index.ts";

async function readPackageJson() {
  return JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
}

describe("mmr-workers merged extension", () => {
  it("is registered as a Pi package extension after mmr-core", async () => {
    const pkg = await readPackageJson();
    const indexOfCore = pkg.pi.extensions.indexOf("./src/extensions/mmr-core/index.ts");
    const indexOfWorkers = pkg.pi.extensions.indexOf(asyncTasksExtensionPath);
    assert.notEqual(indexOfCore, -1, "mmr-core must be registered");
    assert.notEqual(indexOfWorkers, -1, "mmr-workers must be registered");
    assert.ok(indexOfWorkers > indexOfCore, "mmr-workers loads after the mmr-core runtime it registers into");
    assert.equal(pkg.pi.extensions.indexOf("./src/extensions/mmr-async-tasks/index.ts"), -1, "the pre-merge entrypoint is removed");
  });

  it("exposes a package subpath for direct extension loading", async () => {
    const pkg = await readPackageJson();
    assert.equal(pkg.exports["./extensions/mmr-workers"], asyncTasksExtensionPath);
    assert.equal(pkg.exports["./extensions/mmr-async-tasks"], undefined, "the pre-merge subpath is removed");
  });

  it("registers the async tools alongside the blocking workers and owns session_shutdown cleanup", async () => {
    const { createMmrWorkersExtension } = await importSource("extensions/mmr-workers/index.ts");
    const { pi, tools, handlers } = createMockPi();
    createMmrWorkersExtension()(pi);
    assert.deepEqual(
      [...tools.keys()].sort(),
      ["Task", "code_review", "finder", "librarian", "oracle", "start_task", "task_cancel", "task_poll", "task_wait"],
    );
    assert.equal(typeof handlers.get("session_shutdown"), "function");
  });
});
