import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseBoolEnv } from "../mmr-core/internal/env.js";
import { isRecord } from "../mmr-core/internal/json.js";

/**
 * Settings for the `mmr-github` extension.
 *
 * `mmr-github` ships read-only GitHub repository tools used primarily by the
 * `librarian` subagent. Like `mmr-web`, network access is opt-in: the
 * `enabled` master switch defaults to `false` so a fresh install never makes
 * outbound GitHub calls without explicit user opt-in.
 */
export interface MmrGithubSettings {
  /** Network access master switch. Off by default; opt-in per the extension policy. */
  enabled: boolean;
  /**
   * Optional GitHub API token. Loaded from the `MMR_GITHUB_TOKEN`
   * environment variable (preferred) or `GITHUB_TOKEN`. Never read from
   * settings files, which are commonly committed or synced and would leak
   * the secret. Unauthenticated requests are permitted for public endpoints
   * but are subject to GitHub's strict anonymous rate limits, and the code
   * search API requires a token.
   */
  token?: string;
  /**
   * Base URL for the GitHub REST API. Defaults to `https://api.github.com`.
   * Overridable via `MMR_GITHUB_API_URL` (primarily for deterministic tests;
   * GitHub Enterprise Server is not a supported target in this slice).
   */
  apiBaseUrl: string;
  /** Per-request timeout in milliseconds. */
  requestTimeoutMs: number;
  /** Hard cap on bytes read from any single GitHub response body. */
  maxResultBytes: number;
}

export interface LoadedMmrGithubSettings {
  settings: MmrGithubSettings;
  filesRead: string[];
  warnings: string[];
}

export const MMR_GITHUB_ENABLE_ENV = "MMR_GITHUB_ENABLE";
export const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
export const DEFAULT_GITHUB_TIMEOUT_MS = 30_000;
export const DEFAULT_GITHUB_MAX_RESULT_BYTES = 200_000;

function readJsonFile(filePath: string): { value?: unknown; warning?: string } {
  if (!existsSync(filePath)) return {};
  try {
    return { value: JSON.parse(readFileSync(filePath, "utf8")) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { warning: `Could not read MMR GitHub settings from ${filePath}: ${message}` };
  }
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

/** Remove trailing `/` characters without an unanchored-quantifier regex. */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end--;
  return value.slice(0, end);
}

function normalizeApiBaseUrl(value: string): string {
  return stripTrailingSlashes(value.trim());
}

interface ExtractedMmrGithubSettings {
  values: Partial<MmrGithubSettings>;
  hasToken: boolean;
  invalidApiBaseUrl?: string;
}

function extractMmrGithubSettings(value: unknown): ExtractedMmrGithubSettings | undefined {
  if (!isRecord(value)) return undefined;
  const direct = isRecord(value.mmrGithub) ? value.mmrGithub : undefined;
  let nested: Record<string, unknown> | undefined;
  if (isRecord(value.mmr)) {
    const candidate = (value.mmr as Record<string, unknown>).github;
    if (isRecord(candidate)) nested = candidate;
  }
  const raw = direct ?? nested;
  if (!raw) return undefined;

  const out: Partial<MmrGithubSettings> = {};
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  if (typeof raw.requestTimeoutMs === "number" && raw.requestTimeoutMs > 0) {
    out.requestTimeoutMs = Math.floor(raw.requestTimeoutMs);
  }
  if (typeof raw.maxResultBytes === "number" && raw.maxResultBytes > 0) {
    out.maxResultBytes = Math.floor(raw.maxResultBytes);
  }

  let invalidApiBaseUrl: string | undefined;
  if (typeof raw.apiBaseUrl === "string") {
    const trimmed = raw.apiBaseUrl.trim();
    if (trimmed) {
      try {
        const parsed = new URL(trimmed);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
          out.apiBaseUrl = normalizeApiBaseUrl(trimmed);
        } else {
          invalidApiBaseUrl = trimmed;
        }
      } catch {
        invalidApiBaseUrl = trimmed;
      }
    }
  }

  // Tokens are intentionally NOT read from settings files: settings files are
  // commonly committed to repositories or synced across machines, and the
  // token is a secret. Warn on string values so users can remove a persisted
  // secret and move it to the environment.
  const hasToken =
    (direct !== undefined && typeof direct.token === "string") ||
    (nested !== undefined && typeof nested.token === "string");

  return {
    values: out,
    hasToken,
    ...(invalidApiBaseUrl !== undefined ? { invalidApiBaseUrl } : {}),
  };
}

/**
 * Load `mmr-github` settings from the standard MMR settings files (global
 * home + project) and overlay environment variables. Order: home file →
 * project file → environment, latest source wins per field. Default is fully
 * off so a fresh install never makes outbound GitHub calls without explicit
 * user opt-in.
 */
export function loadMmrGithubSettings(
  cwd: string,
  options: { homeDirectory?: string; env?: NodeJS.ProcessEnv } = {},
): LoadedMmrGithubSettings {
  const homeDirectory = options.homeDirectory ?? homedir();
  const env = options.env ?? process.env;

  const files = [
    path.join(homeDirectory, ".pi/agent/settings.json"),
    path.join(cwd, ".pi/settings.json"),
  ];
  const filesRead: string[] = [];
  const warnings: string[] = [];
  let merged: Partial<MmrGithubSettings> = {};

  for (const filePath of files) {
    const { value, warning } = readJsonFile(filePath);
    if (warning) {
      warnings.push(warning);
      continue;
    }
    if (!value) continue;
    filesRead.push(filePath);
    const extracted = extractMmrGithubSettings(value);
    if (!extracted) continue;
    merged = { ...merged, ...extracted.values };
    if (extracted.hasToken) {
      warnings.push(
        `Ignoring mmrGithub.token in ${filePath}: the GitHub token must come from the MMR_GITHUB_TOKEN (or GITHUB_TOKEN) environment variable, not from settings files (which are commonly committed or synced).`,
      );
    }
    if (extracted.invalidApiBaseUrl !== undefined) {
      warnings.push(
        `Ignoring mmrGithub.apiBaseUrl="${extracted.invalidApiBaseUrl}" in ${filePath}: expected a http(s) URL.`,
      );
    }
  }

  const enableEnv = parseBoolEnv(env[MMR_GITHUB_ENABLE_ENV]);
  if (enableEnv !== undefined) merged.enabled = enableEnv;

  const tokenEnv = env.MMR_GITHUB_TOKEN ?? env.GITHUB_TOKEN;
  if (typeof tokenEnv === "string" && tokenEnv.trim()) {
    merged.token = tokenEnv.trim();
  }

  if (typeof env.MMR_GITHUB_API_URL === "string") {
    const trimmed = env.MMR_GITHUB_API_URL.trim();
    if (trimmed) {
      try {
        const parsed = new URL(trimmed);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
          merged.apiBaseUrl = normalizeApiBaseUrl(trimmed);
        } else {
          warnings.push(`Ignoring MMR_GITHUB_API_URL="${env.MMR_GITHUB_API_URL}": expected a http(s) URL.`);
        }
      } catch {
        warnings.push(`Ignoring MMR_GITHUB_API_URL="${env.MMR_GITHUB_API_URL}": expected a http(s) URL.`);
      }
    }
  }

  const timeout = parsePositiveInt(env.MMR_GITHUB_TIMEOUT_MS);
  if (timeout) merged.requestTimeoutMs = timeout;
  const maxBytes = parsePositiveInt(env.MMR_GITHUB_MAX_RESULT_BYTES);
  if (maxBytes) merged.maxResultBytes = maxBytes;

  const settings: MmrGithubSettings = {
    enabled: merged.enabled ?? false,
    token: merged.token,
    apiBaseUrl: merged.apiBaseUrl ?? DEFAULT_GITHUB_API_BASE_URL,
    requestTimeoutMs: merged.requestTimeoutMs ?? DEFAULT_GITHUB_TIMEOUT_MS,
    maxResultBytes: merged.maxResultBytes ?? DEFAULT_GITHUB_MAX_RESULT_BYTES,
  };

  return { settings, filesRead, warnings };
}
