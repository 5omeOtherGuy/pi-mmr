import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

const repoRoot = path.resolve(import.meta.dirname, "..");
const patchExtensionPath = "./src/extensions/mmr-patch/index.ts";
const tasksExtensionPath = "./src/extensions/mmr-tasks/index.ts";
const toolboxExtensionPath = "./src/extensions/mmr-toolbox/index.ts";

async function readPackageJson() {
  return JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
}

describe("mmr-patch scaffold", () => {
  it("is registered as a Pi package extension after mmr-core", async () => {
    const pkg = await readPackageJson();
    const indexOfCore = pkg.pi.extensions.indexOf("./src/extensions/mmr-core/index.ts");
    const indexOfPatch = pkg.pi.extensions.indexOf(patchExtensionPath);
    assert.notEqual(indexOfCore, -1, "mmr-core must be registered as a Pi extension");
    assert.notEqual(indexOfPatch, -1, "mmr-patch must be registered as a Pi extension");
    assert.ok(
      indexOfPatch > indexOfCore,
      "mmr-patch must load after mmr-core so providers can register with the runtime singleton",
    );
  });

  it("exposes a package subpath for direct extension loading", async () => {
    const pkg = await readPackageJson();
    assert.equal(pkg.exports["./extensions/mmr-patch"], patchExtensionPath);
  });

  it("exports a loadable extension factory that registers apply_patch on a Pi-shaped host", async () => {
    const patch = await importSource("extensions/mmr-patch/index.ts");
    assert.equal(typeof patch.default, "function");
    const { pi, tools } = createMockPi();
    assert.doesNotThrow(() => patch.default(pi));
    assert.ok(tools.has("apply_patch"), "mmr-patch should register the apply_patch tool");
  });
});

describe("mmr-tasks scaffold", () => {
  it("is registered as a Pi package extension after mmr-core", async () => {
    const pkg = await readPackageJson();
    const indexOfCore = pkg.pi.extensions.indexOf("./src/extensions/mmr-core/index.ts");
    const indexOfTasks = pkg.pi.extensions.indexOf(tasksExtensionPath);
    assert.notEqual(indexOfCore, -1, "mmr-core must be registered as a Pi extension");
    assert.notEqual(indexOfTasks, -1, "mmr-tasks must be registered as a Pi extension");
    assert.ok(
      indexOfTasks > indexOfCore,
      "mmr-tasks must load after mmr-core so providers can register with the runtime singleton",
    );
  });

  it("exposes a package subpath for direct extension loading", async () => {
    const pkg = await readPackageJson();
    assert.equal(pkg.exports["./extensions/mmr-tasks"], tasksExtensionPath);
  });

  it("exports a loadable extension factory that registers task_list on a Pi-shaped host", async () => {
    const tasks = await importSource("extensions/mmr-tasks/index.ts");
    assert.equal(typeof tasks.default, "function");
    const { pi, tools } = createMockPi();
    assert.doesNotThrow(() => tasks.default(pi));
    assert.ok(tools.has("task_list"), "mmr-tasks should register the task_list tool");
  });
});

describe("mmr-toolbox deprecated compatibility shim", () => {
  it("is no longer auto-loaded but keeps its package subpath", async () => {
    const pkg = await readPackageJson();
    assert.equal(
      pkg.pi.extensions.includes(toolboxExtensionPath),
      false,
      "mmr-toolbox must not be auto-loaded after the split",
    );
    assert.equal(pkg.exports["./extensions/mmr-toolbox"], toolboxExtensionPath);
  });

  it("re-exports the former toolbox surface and registers no tools itself", async () => {
    const shim = await importSource("extensions/mmr-toolbox/index.ts");
    assert.equal(typeof shim.registerMmrToolboxProviders, "function");
    assert.equal(typeof shim.APPLY_PATCH_DESCRIPTION, "string");
    assert.equal(shim.default, undefined, "shim must not export an auto-loadable extension factory");
  });
});
