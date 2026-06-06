import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";

/**
 * Shared, symlink-safe, atomic read-modify-write for Pi settings JSON files.
 *
 * All MMR config writers (`mmr-core`, `mmr-web`, `mmr-subagents`) persist to a
 * project's `<cwd>/.pi/settings.json`. They share three invariants that this
 * module centralizes:
 *
 *  1. A missing file is treated as an empty object (no `existsSync()` race).
 *  2. A file whose contents are not valid JSON is never overwritten.
 *  3. The rewrite is atomic and never follows a symlink: a same-directory
 *     temp file is written with `O_EXCL | O_NOFOLLOW`, flushed, then
 *     `rename(2)`d over the target. A crash mid-write can therefore only
 *     leave the original file intact (or a leftover temp file), never a
 *     truncated settings file. Because the destination is replaced via
 *     `rename`, the write never traverses a symlink at the target path.
 *
 * Reads also refuse to follow a symlink at the settings path so a symlinked
 * `settings.json` cannot redirect reads (and is not silently clobbered into a
 * regular file by the rename on the next write).
 */

const NOFOLLOW = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

/**
 * Read and JSON-parse a settings file without following a symlink at the path.
 *
 * Returns `{}` when the file does not exist. Throws a clear, path-qualified
 * error when the path is a symlink or when the existing contents are not
 * valid JSON, so callers never overwrite a file they could not parse.
 */
export function readJsonSettingsFile(filePath: string): unknown {
  let fd: number | undefined;
  let raw: string | undefined;
  try {
    fd = openSync(filePath, fsConstants.O_RDONLY | NOFOLLOW);
    raw = readFileSync(fd, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return {};
    // ELOOP: the path is a symlink and O_NOFOLLOW refused to open it.
    if (isErrno(error, "ELOOP")) {
      throw new Error(`Refusing to use ${filePath}: it is a symbolic link.`);
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Refusing to overwrite ${filePath}: contents are not valid JSON (${message}).`);
  }
}

function fsyncDirBestEffort(dirPath: string): void {
  let dirFd: number | undefined;
  try {
    dirFd = openSync(dirPath, fsConstants.O_RDONLY);
    fsyncSync(dirFd);
  } catch {
    // Directory fsync is a durability nicety; not all platforms allow
    // opening a directory for fsync. The rename itself is still atomic.
  } finally {
    if (dirFd !== undefined) {
      try {
        closeSync(dirFd);
      } catch {
        // best effort
      }
    }
  }
}

/**
 * Atomically write `text` to `filePath` via a same-directory temp file and
 * `rename(2)`. Creates the parent directory if needed. The temp file is
 * opened with `O_EXCL | O_NOFOLLOW` so it cannot clobber or follow an
 * existing symlink, and is removed on any failure before the rename.
 */
export function writeFileAtomic(filePath: string, text: string): void {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });

  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  );

  let fd: number | undefined;
  try {
    fd = openSync(tempPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW, 0o600);
    writeSync(fd, text);
    fsyncSync(fd);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // best effort
      }
      fd = undefined;
    }
    try {
      unlinkSync(tempPath);
    } catch {
      // best effort cleanup
    }
    throw error;
  }

  try {
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, filePath);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // best effort
      }
    }
    try {
      unlinkSync(tempPath);
    } catch {
      // best effort cleanup
    }
    throw error;
  }

  fsyncDirBestEffort(dir);
}

/**
 * Read a settings file, apply `transform` to the parsed value, and write the
 * result back atomically with 2-space JSON indentation and a trailing
 * newline. Shared by all MMR config writers so the read/refuse/atomic-write
 * contract lives in one place. Returns the resolved file path.
 */
export function rewriteJsonSettingsFile(
  filePath: string,
  transform: (existing: unknown) => Record<string, unknown>,
): string {
  const existing = readJsonSettingsFile(filePath);
  const next = transform(existing);
  writeFileAtomic(filePath, `${JSON.stringify(next, null, 2)}\n`);
  return filePath;
}

const UNSAFE_OBJECT_KEYS: ReadonlySet<string> = new Set(["__proto__", "prototype", "constructor"]);

/**
 * True when `key` would pollute Object prototype state if used as a plain
 * object property key. MMR config writers reject these on user-influenced
 * keys (mode keys, subagent profile names, agent ids) as defense in depth.
 */
export function isUnsafeObjectKey(key: string): boolean {
  return UNSAFE_OBJECT_KEYS.has(key);
}
