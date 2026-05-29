import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const sourceRoot = path.join(repoRoot, "src");
let preparedRoot;
let preparedSourceRoot;

function patchImports(filePath) {
  const source = readFileSync(filePath, "utf8");
  const patched = source
    .replaceAll(/(from\s+["']\.\.?\/[^"']*)\.js(["'])/g, "$1.ts$2")
    .replaceAll(/(import\(\s*["']\.\.?\/[^"']*)\.js(["']\s*\))/g, "$1.ts$2");
  if (patched !== source) writeFileSync(filePath, patched);
}

function walk(dir, visitor) {
  for (const name of readdirSync(dir)) {
    const fullPath = path.join(dir, name);
    if (statSync(fullPath).isDirectory()) {
      walk(fullPath, visitor);
    } else {
      visitor(fullPath);
    }
  }
}

// Idempotent: every test file calls `after(cleanupLoadedSource)`, but the
// prepared source root is shared across the whole process. The first call
// after the last suite finishes performs the rm; subsequent calls become
// no-ops because `preparedRoot` is cleared.
//
// When `PI_MMR_KEEP_PREPARED_SRC=1` (set by `npm run test:cov`), the prepared
// directory is left in place so Node's `--experimental-test-coverage` reporter
// can still read the on-disk sources when it builds the post-run report.
export function cleanupLoadedSource() {
  if (!preparedRoot) return;
  if (process.env.PI_MMR_KEEP_PREPARED_SRC === "1") {
    preparedRoot = undefined;
    preparedSourceRoot = undefined;
    return;
  }
  rmSync(preparedRoot, { recursive: true, force: true });
  preparedRoot = undefined;
  preparedSourceRoot = undefined;
}

// Place the prepared root inside the repo (or under PI_MMR_TESTS_TMP when set)
// so that Node's `--experimental-test-coverage` includes source files in its
// per-file report. V8 coverage is scoped to files under cwd by default; using
// `os.tmpdir()` would silently hide src/ from `npm run test:cov`.
//
// When `PI_MMR_KEEP_PREPARED_SRC=1` is set (coverage runs), all worker
// processes share the same deterministic prepared root so the coverage report
// aggregates cleanly instead of one entry per worker subprocess.
export function getPreparedSourceRoot() {
  if (preparedSourceRoot) return preparedSourceRoot;
  const baseDir = process.env.PI_MMR_TESTS_TMP || path.join(repoRoot, ".test-src");
  mkdirSync(baseDir, { recursive: true });
  if (process.env.PI_MMR_KEEP_PREPARED_SRC === "1") {
    preparedRoot = path.join(baseDir, "shared");
    preparedSourceRoot = path.join(preparedRoot, "src");
    const readyMarker = path.join(preparedRoot, ".ready");
    if (existsSync(readyMarker)) return preparedSourceRoot;
    // Coverage runs spawn one worker per test file; the workers share this
    // prepared root. Use atomic `mkdir` on a lock directory to elect a single
    // copier; everyone else spins on the `.ready` sentinel.
    const lockDir = path.join(preparedRoot, ".lock");
    try {
      mkdirSync(preparedRoot, { recursive: true });
      mkdirSync(lockDir);
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      // Another worker won the race; wait until they publish .ready.
      while (!existsSync(readyMarker)) {
        const start = Date.now();
        while (Date.now() - start < 20) { /* busy-wait briefly */ }
      }
      return preparedSourceRoot;
    }
    // Reaching here means this worker won the lock and is the elected copier;
    // fall through to copy the source tree and publish the .ready marker.
  } else {
    preparedRoot = mkdtempSync(path.join(baseDir, "run-"));
    preparedSourceRoot = path.join(preparedRoot, "src");
  }
  cpSync(sourceRoot, preparedSourceRoot, { recursive: true });
  // Make repo node_modules visible to the prepared source so extension code
  // that imports runtime values from peer dependencies (typebox, pi-coding-agent)
  // resolves the same way it does inside the real package.
  const nodeModulesSource = path.join(repoRoot, "node_modules");
  const nodeModulesLink = path.join(preparedRoot, "node_modules");
  if (existsSync(nodeModulesSource) && !existsSync(nodeModulesLink)) {
    symlinkSync(nodeModulesSource, nodeModulesLink);
  }
  walk(preparedSourceRoot, (filePath) => {
    if (filePath.endsWith(".ts")) patchImports(filePath);
  });
  if (process.env.PI_MMR_KEEP_PREPARED_SRC === "1") {
    writeFileSync(path.join(preparedRoot, ".ready"), "");
  }
  return preparedSourceRoot;
}

// Two import patterns coexist intentionally:
//
//  * `importSource(relativePath)` — cache-busts via a unique `?ts-rand` query,
//    so each call returns a *fresh* module instance. Use this when a test
//    must not see state mutated by a previous test, or when simulating Pi's
//    multi-loader behavior where two extensions get distinct module caches
//    (see `mmr-web-runtime` and `mmr-core-tools`).
//
//  * `pathToFileURL(path.join(getPreparedSourceRoot(), "...")).href` with a
//    *stable* URL (typically wrapped in an `importRuntime()` helper) —
//    intentionally shares the runtime singleton between imports. Tests using
//    this pattern MUST reset module-level state in `beforeEach`, e.g.
//    `runtime.setMmrModeState(undefined)` and, for identity-aware tests,
//    `runtime.setMmrSessionIdentity(undefined)`.
export async function importSource(relativePath) {
  const fullPath = path.join(getPreparedSourceRoot(), relativePath);
  return import(`${pathToFileURL(fullPath).href}?${Date.now()}-${Math.random()}`);
}
