#!/usr/bin/env node
import { closeSync, ftruncateSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const lockPath = path.join(repoRoot, "package-lock.json");
const nestedPrefix = "node_modules/@earendil-works/pi-coding-agent/node_modules";
const patchedPackages = ["protobufjs", "ws", "undici"];

function patchLockfile(filePath) {
  let fd;
  try {
    fd = openSync(filePath, "r+");
    const lock = JSON.parse(readFileSync(fd, "utf8"));
    const packages = lock.packages;
    if (!packages || typeof packages !== "object") return false;

    let changed = false;
    for (const packageName of patchedPackages) {
      const rootKey = `node_modules/${packageName}`;
      const nestedKey = `${nestedPrefix}/${packageName}`;
      if (!packages[rootKey] || !packages[nestedKey]) continue;
      const replacement = { ...packages[rootKey] };
      if (JSON.stringify(packages[nestedKey]) !== JSON.stringify(replacement)) {
        packages[nestedKey] = replacement;
        changed = true;
      }
    }

    if (changed) {
      ftruncateSync(fd, 0);
      writeSync(fd, JSON.stringify(lock, null, 2) + "\n", 0, "utf8");
    }
    return changed;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function removeNestedCopies() {
  for (const packageName of patchedPackages) {
    const nestedPath = path.join(repoRoot, nestedPrefix, packageName);
    rmSync(nestedPath, { recursive: true, force: true });
  }
}

patchLockfile(lockPath);
patchLockfile(path.join(repoRoot, "node_modules/@earendil-works/pi-coding-agent/npm-shrinkwrap.json"));
removeNestedCopies();
