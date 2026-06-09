import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const repoRoot = path.resolve(import.meta.dirname, "..");
const asyncTasksExtensionPath = "./src/extensions/mmr-async-tasks/index.ts";

async function readPackageJson() {
  return JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
}

describe("mmr-async-tasks extension", () => {
  it("is registered as a Pi package extension after mmr-subagents", async () => {
    const pkg = await readPackageJson();
    const indexOfSubagents = pkg.pi.extensions.indexOf("./src/extensions/mmr-subagents/index.ts");
    const indexOfAsync = pkg.pi.extensions.indexOf(asyncTasksExtensionPath);
    assert.notEqual(indexOfSubagents, -1, "mmr-subagents must be registered");
    assert.notEqual(indexOfAsync, -1, "mmr-async-tasks must be registered");
    assert.ok(indexOfAsync > indexOfSubagents, "mmr-async-tasks loads after worker tools it can launch");
  });

  it("exposes a package subpath for direct extension loading", async () => {
    const pkg = await readPackageJson();
    assert.equal(pkg.exports["./extensions/mmr-async-tasks"], asyncTasksExtensionPath);
  });

  it("registers async tools and owns session_shutdown cleanup", async () => {
    const { createMmrAsyncTasksExtension } = await importSource("extensions/mmr-async-tasks/index.ts");
    const { pi, tools, handlers } = createMockPi();
    createMmrAsyncTasksExtension()(pi);
    assert.deepEqual(
      [...tools.keys()].sort(),
      ["start_task", "task_cancel", "task_poll", "task_wait"],
    );
    assert.equal(typeof handlers.get("session_shutdown"), "function");
  });
});
