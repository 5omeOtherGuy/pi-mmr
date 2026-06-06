import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseBoolEnv } from "../mmr-core/internal/env.js";
import { isRecord } from "../mmr-core/internal/json.js";

/**
 * Backend selection for `mmr-web`.
 *
 * `web_search` resolves to one of these in `auto` mode:
 *   1. `searxng`     — when `searxngUrl` is configured (no-key preferred).
 *   2. `brave`       — when `BRAVE_API_KEY` is configured.
 *   3. `duckduckgo`  — built-in no-key HTML/lite fallback (best-effort).
 *
 * Explicit `searchBackend: "searxng"` requires `searxngUrl`; explicit
 * `"brave"` requires `BRAVE_API_KEY`; explicit `"duckduckgo"` requires no
 * configuration. `read_web_page` always uses the built-in custom reader
 * regardless of this setting.
 *
 * Jina is no longer a supported provider and is rejected with a warning.
 */
export type MmrWebBackend = "auto" | "brave" | "searxng" | "duckduckgo";

export const MMR_WEB_BACKENDS: ReadonlyArray<MmrWebBackend> = ["auto", "brave", "searxng", "duckduckgo"];

export interface MmrWebSettings {
  /** Network access master switch. Off by default; opt-in per the extension policy. */
  enabled: boolean;
  /** Compatibility setting. Defaults to `"auto"`; `"auto"` and `"brave"` now behave the same. */
  backend: MmrWebBackend;
  /** Compatibility per-tool override for `web_search`; `"auto"` and `"brave"` now behave the same. */
  searchBackend?: MmrWebBackend;
  /** Compatibility per-tool override for `read_web_page`; `"auto"` and `"brave"` now behave the same. */
  readerBackend?: MmrWebBackend;
  /**
   * Optional Brave Search API key. Required for successful `web_search` calls
   * routed through the Brave backend. Loaded from the `BRAVE_API_KEY`
   * environment variable only; settings-file values are ignored with a warning.
   */
  braveApiKey?: string;
  /**
   * Optional URL of a user-configured SearXNG instance, e.g.
   * `http://127.0.0.1:8080`. When set, `auto` selects SearXNG ahead of Brave.
   * Read from the `MMR_WEB_SEARXNG_URL` environment variable or the settings
   * file `mmrWeb.searxngUrl` field. Loopback/private/link-local addresses are
   * permitted here because this URL is user-trusted configuration, unlike
   * model-supplied URLs passed to `read_web_page`.
   */
  searxngUrl?: string;
  /**
   * Opt-in: have `mmr-web` start a local SearXNG instance on demand and
   * stop it when idle. Off by default. Read from `MMR_WEB_SEARXNG_MANAGED`
   * or the settings file `mmrWeb.searxngManaged` field.
   *
   * When enabled, `mmrWeb.searxngStartCommand` (and optionally
   * `mmrWeb.searxngStopCommand`) must be set in the GLOBAL settings file
   * (`~/.pi/agent/settings.json`). The start/stop commands are NEVER read
   * from environment variables, model input, or a project-local
   * `<cwd>/.pi/settings.json` — they spawn arbitrary processes and must
   * come from the user's trusted global configuration only.
   */
  searxngManaged: boolean;
  /**
   * Command array used to start the managed SearXNG instance, e.g.
   * `["docker", "compose", "-f", "./searxng.yml", "up", "-d"]`.
   * Global settings file only (project-local settings are ignored). Items
   * are passed to `child_process.spawn` with `shell: false`, so the command
   * and its arguments are not interpreted by any shell.
   */
  searxngStartCommand?: string[];
  /**
   * Command array used to stop the managed SearXNG instance, e.g.
   * `["docker", "compose", "-f", "./searxng.yml", "down"]`. Global settings
   * file only (project-local settings are ignored). When omitted, `mmr-web`
   * falls back to sending SIGTERM to the spawned PID and is best-effort.
   */
  searxngStopCommand?: string[];
  /**
   * Optional URL used by the sidecar health-poller while waiting for
   * SearXNG to come up. Defaults to
   * `${searxngUrl}/search?q=ping&format=json` if unset.
   * Read from `MMR_WEB_SEARXNG_HEALTH_URL` or `mmrWeb.searxngHealthUrl`.
   */
  searxngHealthUrl?: string;
  /**
   * Idle timeout before the sidecar runs the stop command. Defaults to
   * 15 minutes. Read from `MMR_WEB_SEARXNG_IDLE_TIMEOUT_MS` or the
   * settings file. Set to 0 to disable the idle stop.
   */
  searxngIdleTimeoutMs: number;
  /**
   * Maximum time to wait for the managed SearXNG instance to pass its
   * health check before failing the search. Defaults to 30 seconds.
   */
  searxngStartTimeoutMs: number;
  searchTimeoutMs: number;
  readTimeoutMs: number;
  maxResultBytes: number;
}

export interface LoadedMmrWebSettings {
  settings: MmrWebSettings;
  filesRead: string[];
  warnings: string[];
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RESULT_BYTES = 200_000;
/** Default idle-stop window for the managed SearXNG sidecar (15 minutes). */
export const DEFAULT_SEARXNG_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
/** Default health-readiness window for the managed SearXNG sidecar (30 seconds). */
export const DEFAULT_SEARXNG_START_TIMEOUT_MS = 30_000;

function readJsonFile(filePath: string): { value?: unknown; warning?: string } {
  if (!existsSync(filePath)) return {};
  try {
    return { value: JSON.parse(readFileSync(filePath, "utf8")) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { warning: `Could not read MMR web settings from ${filePath}: ${message}` };
  }
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

interface ExtractedMmrWebSettings {
  values: Partial<MmrWebSettings>;
  hasJinaApiKey: boolean;
  hasBraveApiKey: boolean;
  invalidBackend?: string;
  invalidSearchBackend?: string;
  invalidReaderBackend?: string;
  invalidSearxngUrl?: string;
  invalidSearxngHealthUrl?: string;
  invalidSearxngStartCommand?: string;
  invalidSearxngStopCommand?: string;
}

export function isMmrWebBackend(value: unknown): value is MmrWebBackend {
  return typeof value === "string" && (MMR_WEB_BACKENDS as ReadonlyArray<string>).includes(value);
}

function extractMmrWebSettings(value: unknown): ExtractedMmrWebSettings | undefined {
  if (!isRecord(value)) return undefined;
  const direct = isRecord(value.mmrWeb) ? value.mmrWeb : undefined;
  let nested: Record<string, unknown> | undefined;
  if (isRecord(value.mmr)) {
    const candidate = (value.mmr as Record<string, unknown>).web;
    if (isRecord(candidate)) nested = candidate;
  }
  const raw = direct ?? nested;
  if (!raw) return undefined;

  const out: Partial<MmrWebSettings> = {};
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  if (typeof raw.searchTimeoutMs === "number" && raw.searchTimeoutMs > 0) out.searchTimeoutMs = Math.floor(raw.searchTimeoutMs);
  if (typeof raw.readTimeoutMs === "number" && raw.readTimeoutMs > 0) out.readTimeoutMs = Math.floor(raw.readTimeoutMs);
  if (typeof raw.maxResultBytes === "number" && raw.maxResultBytes > 0) out.maxResultBytes = Math.floor(raw.maxResultBytes);

  let invalidBackend: string | undefined;
  if (isMmrWebBackend(raw.backend)) {
    out.backend = raw.backend;
  } else if (typeof raw.backend === "string") {
    invalidBackend = raw.backend;
  }

  let invalidSearchBackend: string | undefined;
  if (isMmrWebBackend(raw.searchBackend)) {
    out.searchBackend = raw.searchBackend;
  } else if (typeof raw.searchBackend === "string") {
    invalidSearchBackend = raw.searchBackend;
  }

  let invalidReaderBackend: string | undefined;
  if (isMmrWebBackend(raw.readerBackend)) {
    out.readerBackend = raw.readerBackend;
  } else if (typeof raw.readerBackend === "string") {
    invalidReaderBackend = raw.readerBackend;
  }

  let invalidSearxngUrl: string | undefined;
  if (typeof raw.searxngUrl === "string") {
    const trimmed = raw.searxngUrl.trim();
    if (trimmed) {
      try {
        const parsed = new URL(trimmed);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
          out.searxngUrl = trimmed;
        } else {
          invalidSearxngUrl = trimmed;
        }
      } catch {
        invalidSearxngUrl = trimmed;
      }
    }
  }

  if (typeof raw.searxngManaged === "boolean") out.searxngManaged = raw.searxngManaged;

  let invalidSearxngHealthUrl: string | undefined;
  if (typeof raw.searxngHealthUrl === "string") {
    const trimmed = raw.searxngHealthUrl.trim();
    if (trimmed) {
      try {
        const parsed = new URL(trimmed);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
          out.searxngHealthUrl = trimmed;
        } else {
          invalidSearxngHealthUrl = trimmed;
        }
      } catch {
        invalidSearxngHealthUrl = trimmed;
      }
    }
  }

  let invalidSearxngStartCommand: string | undefined;
  if (Array.isArray(raw.searxngStartCommand)) {
    if (
      raw.searxngStartCommand.length > 0 &&
      raw.searxngStartCommand.every((part) => typeof part === "string" && part !== "")
    ) {
      out.searxngStartCommand = raw.searxngStartCommand as string[];
    } else {
      invalidSearxngStartCommand = JSON.stringify(raw.searxngStartCommand);
    }
  } else if (raw.searxngStartCommand !== undefined) {
    invalidSearxngStartCommand = String(raw.searxngStartCommand);
  }

  let invalidSearxngStopCommand: string | undefined;
  if (Array.isArray(raw.searxngStopCommand)) {
    if (
      raw.searxngStopCommand.length > 0 &&
      raw.searxngStopCommand.every((part) => typeof part === "string" && part !== "")
    ) {
      out.searxngStopCommand = raw.searxngStopCommand as string[];
    } else {
      invalidSearxngStopCommand = JSON.stringify(raw.searxngStopCommand);
    }
  } else if (raw.searxngStopCommand !== undefined) {
    invalidSearxngStopCommand = String(raw.searxngStopCommand);
  }

  if (typeof raw.searxngIdleTimeoutMs === "number" && raw.searxngIdleTimeoutMs >= 0) {
    out.searxngIdleTimeoutMs = Math.floor(raw.searxngIdleTimeoutMs);
  }
  if (typeof raw.searxngStartTimeoutMs === "number" && raw.searxngStartTimeoutMs > 0) {
    out.searxngStartTimeoutMs = Math.floor(raw.searxngStartTimeoutMs);
  }

  // API keys are intentionally NOT read from settings files: settings files
  // are commonly committed to repositories or synced across machines, and
  // these keys are secrets. `jinaApiKey` is now an ignored legacy field, but
  // still warn on string values so users can remove a persisted secret.
  const hasJinaApiKey =
    (direct !== undefined && typeof direct.jinaApiKey === "string") ||
    (nested !== undefined && typeof nested.jinaApiKey === "string");
  const hasBraveApiKey =
    (direct !== undefined && typeof direct.braveApiKey === "string") ||
    (nested !== undefined && typeof nested.braveApiKey === "string");
  return {
    values: out,
    hasJinaApiKey,
    hasBraveApiKey,
    invalidBackend,
    invalidSearchBackend,
    invalidReaderBackend,
    invalidSearxngUrl,
    invalidSearxngHealthUrl,
    invalidSearxngStartCommand,
    invalidSearxngStopCommand,
  };
}

function parseBackendEnv(value: string | undefined, warnings: string[]): MmrWebBackend | undefined {
  return parseNamedBackendEnv("MMR_WEB_BACKEND", value, warnings);
}

function parseNamedBackendEnv(
  name: string,
  value: string | undefined,
  warnings: string[],
): MmrWebBackend | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "") return undefined;
  if (isMmrWebBackend(trimmed)) return trimmed;
  warnings.push(
    `Ignoring ${name}="${value}": expected one of ${MMR_WEB_BACKENDS.join(", ")}; mmr-web no longer supports Jina.`,
  );
  return undefined;
}

/**
 * Load mmr-web settings from the standard MMR settings files (global home +
 * project) and overlay environment variables. Order: home file → project file
 * → environment, latest source wins per field. Default is fully off so a fresh
 * install never makes outbound network calls without explicit user opt-in.
 */
export function loadMmrWebSettings(
  cwd: string,
  options: { homeDirectory?: string; env?: NodeJS.ProcessEnv } = {},
): LoadedMmrWebSettings {
  const homeDirectory = options.homeDirectory ?? homedir();
  const env = options.env ?? process.env;

  // The global (user-home) settings file is the only trusted layer for the
  // managed-SearXNG start/stop commands: they spawn arbitrary processes, so a
  // project-local `<cwd>/.pi/settings.json` (which travels with a checkout)
  // must not be able to inject them. Everything else merges global → project.
  const globalSettingsPath = path.join(homeDirectory, ".pi/agent/settings.json");
  const projectSettingsPath = path.join(cwd, ".pi/settings.json");
  const files = [globalSettingsPath, projectSettingsPath];
  const filesRead: string[] = [];
  const warnings: string[] = [];
  let merged: Partial<MmrWebSettings> = {};

  for (const filePath of files) {
    const { value, warning } = readJsonFile(filePath);
    if (warning) {
      warnings.push(warning);
      continue;
    }
    if (!value) continue;
    filesRead.push(filePath);
    const extracted = extractMmrWebSettings(value);
    if (!extracted) continue;
    const values = extracted.values;
    if (filePath !== globalSettingsPath &&
        (values.searxngStartCommand !== undefined || values.searxngStopCommand !== undefined)) {
      warnings.push(
        `Ignoring mmrWeb.searxngStartCommand/searxngStopCommand in ${filePath}: the managed-SearXNG start/stop commands spawn arbitrary processes and are honored only from your global settings file (~/.pi/agent/settings.json), not from project-local settings.`,
      );
      delete values.searxngStartCommand;
      delete values.searxngStopCommand;
    }
    merged = { ...merged, ...values };
    if (extracted.hasJinaApiKey) {
      warnings.push(
        `Ignoring mmrWeb.jinaApiKey in ${filePath}: mmr-web no longer uses Jina. Remove this settings-file secret and set BRAVE_API_KEY in the environment for web_search.`,
      );
    }
    if (extracted.hasBraveApiKey) {
      warnings.push(
        `Ignoring mmrWeb.braveApiKey in ${filePath}: the Brave Search API key must come from the BRAVE_API_KEY environment variable, not from settings files (which are commonly committed or synced).`,
      );
    }
    if (extracted.invalidBackend !== undefined) {
      warnings.push(
        `Ignoring mmrWeb.backend="${extracted.invalidBackend}" in ${filePath}: expected one of ${MMR_WEB_BACKENDS.join(", ")}; mmr-web no longer supports Jina.`,
      );
    }
    if (extracted.invalidSearchBackend !== undefined) {
      warnings.push(
        `Ignoring mmrWeb.searchBackend="${extracted.invalidSearchBackend}" in ${filePath}: expected one of ${MMR_WEB_BACKENDS.join(", ")}; mmr-web no longer supports Jina.`,
      );
    }
    if (extracted.invalidReaderBackend !== undefined) {
      warnings.push(
        `Ignoring mmrWeb.readerBackend="${extracted.invalidReaderBackend}" in ${filePath}: expected one of ${MMR_WEB_BACKENDS.join(", ")}; mmr-web no longer supports Jina.`,
      );
    }
    if (extracted.invalidSearxngUrl !== undefined) {
      warnings.push(
        `Ignoring mmrWeb.searxngUrl="${extracted.invalidSearxngUrl}" in ${filePath}: expected a http(s) URL.`,
      );
    }
    if (extracted.invalidSearxngHealthUrl !== undefined) {
      warnings.push(
        `Ignoring mmrWeb.searxngHealthUrl="${extracted.invalidSearxngHealthUrl}" in ${filePath}: expected a http(s) URL.`,
      );
    }
    if (extracted.invalidSearxngStartCommand !== undefined) {
      warnings.push(
        `Ignoring mmrWeb.searxngStartCommand=${extracted.invalidSearxngStartCommand} in ${filePath}: expected a non-empty array of strings (e.g. ["docker", "compose", "-f", "./searxng.yml", "up", "-d"]).`,
      );
    }
    if (extracted.invalidSearxngStopCommand !== undefined) {
      warnings.push(
        `Ignoring mmrWeb.searxngStopCommand=${extracted.invalidSearxngStopCommand} in ${filePath}: expected a non-empty array of strings.`,
      );
    }
  }

  const enableEnv = parseBoolEnv(env.MMR_WEB_ENABLE);
  if (enableEnv !== undefined) merged.enabled = enableEnv;
  const managedEnv = parseBoolEnv(env.MMR_WEB_SEARXNG_MANAGED);
  if (managedEnv !== undefined) merged.searxngManaged = managedEnv;
  if (typeof env.MMR_WEB_SEARXNG_HEALTH_URL === "string") {
    const trimmed = env.MMR_WEB_SEARXNG_HEALTH_URL.trim();
    if (trimmed) {
      try {
        const parsed = new URL(trimmed);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
          merged.searxngHealthUrl = trimmed;
        } else {
          warnings.push(
            `Ignoring MMR_WEB_SEARXNG_HEALTH_URL="${env.MMR_WEB_SEARXNG_HEALTH_URL}": expected a http(s) URL.`,
          );
        }
      } catch {
        warnings.push(
          `Ignoring MMR_WEB_SEARXNG_HEALTH_URL="${env.MMR_WEB_SEARXNG_HEALTH_URL}": expected a http(s) URL.`,
        );
      }
    }
  }
  const idleEnv = parsePositiveInt(env.MMR_WEB_SEARXNG_IDLE_TIMEOUT_MS);
  if (idleEnv !== undefined) merged.searxngIdleTimeoutMs = idleEnv;
  // Also accept 0 (idle-stop disabled) via env.
  if (env.MMR_WEB_SEARXNG_IDLE_TIMEOUT_MS === "0") merged.searxngIdleTimeoutMs = 0;
  const startTimeoutEnv = parsePositiveInt(env.MMR_WEB_SEARXNG_START_TIMEOUT_MS);
  if (startTimeoutEnv !== undefined) merged.searxngStartTimeoutMs = startTimeoutEnv;
  if (env.MMR_WEB_SEARXNG_START_COMMAND !== undefined && env.MMR_WEB_SEARXNG_START_COMMAND.trim() !== "") {
    warnings.push(
      `Ignoring MMR_WEB_SEARXNG_START_COMMAND: the managed-SearXNG start/stop commands must come from the mmrWeb.searxngStartCommand / mmrWeb.searxngStopCommand fields in your settings file (settings.json), not from environment variables.`,
    );
  }
  if (env.MMR_WEB_SEARXNG_STOP_COMMAND !== undefined && env.MMR_WEB_SEARXNG_STOP_COMMAND.trim() !== "") {
    warnings.push(
      `Ignoring MMR_WEB_SEARXNG_STOP_COMMAND: the managed-SearXNG start/stop commands must come from the mmrWeb.searxngStartCommand / mmrWeb.searxngStopCommand fields in your settings file (settings.json), not from environment variables.`,
    );
  }
  if (typeof env.BRAVE_API_KEY === "string" && env.BRAVE_API_KEY.trim()) {
    merged.braveApiKey = env.BRAVE_API_KEY.trim();
  }
  const backendEnv = parseBackendEnv(env.MMR_WEB_BACKEND, warnings);
  if (backendEnv !== undefined) merged.backend = backendEnv;
  const searchBackendEnv = parseNamedBackendEnv(
    "MMR_WEB_SEARCH_BACKEND",
    env.MMR_WEB_SEARCH_BACKEND,
    warnings,
  );
  if (searchBackendEnv !== undefined) merged.searchBackend = searchBackendEnv;
  const readerBackendEnv = parseNamedBackendEnv(
    "MMR_WEB_READER_BACKEND",
    env.MMR_WEB_READER_BACKEND,
    warnings,
  );
  if (readerBackendEnv !== undefined) merged.readerBackend = readerBackendEnv;
  if (typeof env.MMR_WEB_SEARXNG_URL === "string") {
    const trimmed = env.MMR_WEB_SEARXNG_URL.trim();
    if (trimmed) {
      try {
        const parsed = new URL(trimmed);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
          merged.searxngUrl = trimmed;
        } else {
          warnings.push(
            `Ignoring MMR_WEB_SEARXNG_URL="${env.MMR_WEB_SEARXNG_URL}": expected a http(s) URL.`,
          );
        }
      } catch {
        warnings.push(
          `Ignoring MMR_WEB_SEARXNG_URL="${env.MMR_WEB_SEARXNG_URL}": expected a http(s) URL.`,
        );
      }
    }
  }
  const searchTimeout = parsePositiveInt(env.MMR_WEB_SEARCH_TIMEOUT_MS);
  if (searchTimeout) merged.searchTimeoutMs = searchTimeout;
  const readTimeout = parsePositiveInt(env.MMR_WEB_READ_TIMEOUT_MS);
  if (readTimeout) merged.readTimeoutMs = readTimeout;
  const maxBytes = parsePositiveInt(env.MMR_WEB_MAX_RESULT_BYTES);
  if (maxBytes) merged.maxResultBytes = maxBytes;

  const settings: MmrWebSettings = {
    enabled: merged.enabled ?? false,
    backend: merged.backend ?? "auto",
    searchBackend: merged.searchBackend,
    readerBackend: merged.readerBackend,
    braveApiKey: merged.braveApiKey,
    searxngUrl: merged.searxngUrl,
    searxngManaged: merged.searxngManaged ?? false,
    searxngStartCommand: merged.searxngStartCommand,
    searxngStopCommand: merged.searxngStopCommand,
    searxngHealthUrl: merged.searxngHealthUrl,
    searxngIdleTimeoutMs: merged.searxngIdleTimeoutMs ?? DEFAULT_SEARXNG_IDLE_TIMEOUT_MS,
    searxngStartTimeoutMs: merged.searxngStartTimeoutMs ?? DEFAULT_SEARXNG_START_TIMEOUT_MS,
    searchTimeoutMs: merged.searchTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    readTimeoutMs: merged.readTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxResultBytes: merged.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES,
  };

  return { settings, filesRead, warnings };
}
