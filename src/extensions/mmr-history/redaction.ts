/**
 * Deterministic redaction for any string field that leaves the local
 * `mmr-history` catalog. Used by both the `find_session` result shape
 * (names, previews, diagnostics) and the worker analysis packet.
 *
 * Patterns are applied in a fixed order so the same input always
 * produces the same output, and so a second pass over already-redacted
 * text is a no-op (idempotence). The replacement markers themselves do
 * not match any pattern they would otherwise feed into, and every
 * marker uses bracketed text (`[redacted]`, `[token]`, `[ip]`, …) so
 * the path patterns reject the marker as part of a candidate path.
 *
 * Order (first match wins per substring):
 *   1. Path family   — Pi-session files, Pi data dir.
 *   2. Secret family — PEM blocks, Authorization headers and env/CLI
 *                       `authorization=` form, known provider token
 *                       prefixes (incl. AWS access key IDs), Slack
 *                       incoming-webhook URLs, JWT triples, env-style
 *                       `key=value` (JSON, single-quoted, bare),
 *                       URL userinfo.
 *   3. Identity-ish  — Email addresses, IPv6/IPv4 addresses, bare OS
 *                       username matching `$USER` / `whoami`.
 *   4. Path family   — `/home/<user>`, `/Users/<user>`, `C:\Users\…`,
 *                       and any remaining absolute path.
 *   5. Repo / project — handled by `projectRefFromCwd` and the catalog
 *                       layer, not by string substitution; this module
 *                       only exposes the hashing helper.
 *
 * Intentional non-redactions (trade-offs accepted to keep the false
 * positive rate manageable):
 *   - Bare long hex strings without a key=value context (commit SHAs,
 *     content digests, etc.) are NOT redacted. There is no standalone
 *     "long hex" pattern; hex values only get redacted when they sit
 *     inside one of the structured forms above.
 *   - "Ambiguous" IPv4-shaped version strings (e.g. `1.2.3.4`) ARE
 *     redacted by the canonical-IPv4 pattern. We do not attempt to
 *     disambiguate version numbers from real addresses; over-redacting
 *     a version is preferable to leaking an address.
 *
 * Pure functions. No filesystem access, no async work. `redactText`
 * is safe to call from packet assembly and from result formatting.
 */
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { userInfo } from "node:os";

/** Marker inserted in place of a Pi session JSONL file path. */
export const REDACTION_PI_SESSION = "[pi-session]";
/** Marker inserted in place of any `~/.pi/...` data path. */
export const REDACTION_PI_DATA = "[pi-data]";
/** Marker inserted in place of a `/home/<user>` or `/Users/<user>` prefix. */
export const REDACTION_HOME = "[home]";
/** Marker inserted in place of any other absolute path. */
export const REDACTION_ABS_PATH = "[abs-path]";
/** Marker inserted in place of a JWT. */
export const REDACTION_JWT = "[jwt]";
/** Marker inserted in place of a PEM private key block. */
export const REDACTION_PEM = "[pem]";
/** Marker inserted in place of a recognized provider token. */
export const REDACTION_TOKEN = "[token]";
/** Marker inserted in place of an Authorization / secret value. */
export const REDACTION_REDACTED = "[redacted]";
/** Marker inserted in place of the local OS username. */
export const REDACTION_USER = "[user]";
/** Marker inserted in place of an email address. */
export const REDACTION_EMAIL = "[email]";
/** Marker inserted in place of an IPv4 or IPv6 address. */
export const REDACTION_IP = "[ip]";

/** Length, in hex characters, of the opaque per-project reference hash. */
export const PROJECT_REF_HEX_LENGTH = 8;

export interface RedactOptions {
  /**
   * The local OS username to redact as a bare identifier. Defaults to
   * the lazily-resolved value from `os.userInfo().username`. Passing
   * an empty string disables the username redaction pass; callers that
   * deliberately want to keep the raw username (e.g. tests) should
   * pass `""`.
   */
  user?: string;
}

let cachedUsername: string | undefined;

function resolveUsername(opts: RedactOptions | undefined): string {
  if (opts && typeof opts.user === "string") return opts.user;
  if (cachedUsername !== undefined) return cachedUsername;
  try {
    const info = userInfo();
    cachedUsername = typeof info.username === "string" ? info.username : "";
  } catch {
    cachedUsername = "";
  }
  return cachedUsername;
}

/** Test-only seam: drop the cached username so a new `os.userInfo()` call is made. */
export function __resetRedactionUsernameCacheForTests(): void {
  cachedUsername = undefined;
}

// --- Patterns -----------------------------------------------------------

// PEM blocks: applied first (largest, most distinctive) so they never get
// shredded into per-line absolute-path matches. Non-greedy across newlines.
const PEM_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

// JWT: three base64url segments joined by dots. The lookarounds prevent
// matches inside larger token-like strings (e.g. `sk-ant-...` already
// redacted) and inside dotted version numbers.
//
// Trade-offs accepted by the {8,} per-segment lower bound:
//   - Very short test JWTs such as `a.b.c` are intentionally NOT
//     matched. Lowering the bound would over-redact prose like
//     dotted abbreviations or version strings.
//   - Dotted hash-like strings such as
//     `a1b2c3d4.e5f6g7h8.deadbeef` DO match as `[jwt]`. We accept
//     that over-redaction rather than risk leaking a real JWT that
//     happens to use only hex-shaped characters.
const JWT_PATTERN = /(?<![A-Za-z0-9_.\-])[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_.\-])/g;

// Authorization header: keep the field name and scheme so callers can
// see the form was redacted, but never surface the credential.
const AUTH_HEADER_PATTERN = /\b(Authorization)\s*:\s*(Bearer|Basic)\s+\S+/gi;

// Env/CLI `authorization=<value>` form. Runs after AUTH_HEADER_PATTERN
// so that the header form's `Authorization: Bearer [redacted]` output
// is preserved verbatim (group 2 captures the optional Bearer/Basic
// scheme keyword and replays it in the replacement). The same group
// also lets us redact CLI/env forms like `authorization=Bearer abc`
// without losing the scheme. Idempotent: replaying on
// `authorization=[redacted]` produces the same string.
const AUTH_KV_PATTERN = /(\bauthorization\s*[:=]\s*)((?:Bearer|Basic)\s+)?(\S+)/gi;

// Env-style key=value families. The key whitelist matches the privacy
// spec (`authorization` is handled by AUTH_HEADER_PATTERN /
// AUTH_KV_PATTERN above with a more specific shape).
//
// JSON object form: `"key": "value with spaces"`. Inner value allows
// escaped quotes via `\\.`. Kept as its own pattern because the
// quote-aware bare form below cannot span whitespace.
const ENV_KV_JSON_PATTERN =
  /("(?:token|secret|password|api[_-]?key|cookie)"\s*:\s*")(?:[^"\\]|\\.)*(")/gi;
// Single-quoted value: `key='value with spaces'`. Inner value allows
// escaped single quotes via `\\.`. Captured open/close quotes are
// replayed so the marker stays inside `'…'`.
const ENV_KV_SQUOTE_PATTERN =
  /(\b(?:token|secret|password|api[_-]?key|cookie)\s*[:=]\s*')(?:[^'\\]|\\.)*(')/gi;
// Bare-token form (also covers a no-space `key="value"` thanks to the
// `("?)` backreference). Whitespace, quotes, commas and semicolons
// terminate the value, which keeps the pattern from spilling across
// adjacent fields. `[redacted]` itself fits inside the inner class so
// a second pass replaces value with the same marker.
const ENV_KV_BARE_PATTERN =
  /(\b(?:token|secret|password|api[_-]?key|cookie)\s*[:=]\s*)("?)[^\s"',;]+\2/gi;

// Provider-prefixed tokens. Ordered most-specific-first so `sk-ant-...`
// doesn't get partially matched by the generic `sk-` rule. Lookbehind
// ensures we don't redact mid-identifier. Length lower bounds keep the
// patterns from firing on prose like `sk-foo`.
const PROVIDER_TOKEN_PATTERNS: readonly RegExp[] = [
  /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{16,}/g,
  /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9]{20,}/g,
  /(?<![A-Za-z0-9_-])ghp_[A-Za-z0-9]{20,}/g,
  /(?<![A-Za-z0-9_-])gho_[A-Za-z0-9]{20,}/g,
  /(?<![A-Za-z0-9_-])AIza[A-Za-z0-9_-]{20,}/g,
  /(?<![A-Za-z0-9_-])jina_[A-Za-z0-9]{16,}/g,
  /(?<![A-Za-z0-9_-])xoxb-[A-Za-z0-9-]{20,}/g,
  /(?<![A-Za-z0-9_-])xoxa-[A-Za-z0-9-]{20,}/g,
  // AWS access key IDs: `AKIA` + 16 uppercase alphanum.
  /(?<![A-Za-z0-9_-])AKIA[0-9A-Z]{16}(?![A-Za-z0-9_-])/g,
];

// Slack incoming-webhook URLs. Treated as a token-class secret because
// the path segment is sufficient to post to the workspace.
const SLACK_WEBHOOK_PATTERN = /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g;

// URL userinfo: `scheme://user[:pass]@host`. We keep scheme and host
// intact so the result is still recognizable as a URL.
const URL_USERINFO_PATTERN = /\b([a-zA-Z][a-zA-Z0-9+.\-]*:\/\/)[^/@\s]+@/g;

// Email addresses. Lookbehind excludes `[`, `]`, `@`, and the local-part
// character class so the pattern cannot eat a leading redaction marker
// (e.g. the `[redacted]@github.com` left behind by URL_USERINFO).
const EMAIL_PATTERN =
  /(?<![A-Za-z0-9._%+\-\[\]@])[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g;

// IPv4: canonical 0-255 octets bounded by `\b`. Version-shaped strings
// that happen to be valid IPv4 (e.g. `1.2.3.4`) are intentionally
// redacted; see the file header note for the rationale.
const IPV4_PATTERN =
  /\b(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(?:\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)){3}\b/g;

// IPv6 detection: broad candidate extraction validated by
// `node:net.isIP()`. Curated per-form regexes only recognized the full
// 8-group form plus `::1`/`::`/`fe80::`, so compressed global-unicast
// and unique-local addresses leaked. Instead we slice plausible IPv6
// spans out of free text and let stdlib decide: only candidates that
// validate as IPv6 (`isIP() === 6`) are redacted. Consequences:
//   - Compressed/mixed/IPv4-mapped/full forms all collapse to `[ip]`.
//   - Multi-character language `::` syntax (C++ `std::cout`, Ruby/Rust
//     `Module::method`, `Foo::Bar::baz`) and non-address colon text
//     (`12:34`, `de:ad:be:ef`) are either never extracted (the leading
//     group must be hex, preceded by a non-identifier boundary) or fail
//     `isIP` validation, so they are left intact.
//   - A bare single-group `x::y` (e.g. `a::b`, `0::1`) is a valid IPv6
//     literal and IS redacted: the over-redaction stance favors never
//     leaking a routable address over preserving a rare single-letter
//     namespace token, and keeps `0::1` consistent with `::1`.
// The two branches cover (1) addresses starting with a hex group and
// (2) addresses starting with the `::` compression. Both allow an
// optional dotted IPv4 tail (mapped forms) and an optional `%zone`
// suffix. Hex groups are bounded to {1,4} and group/octet repetition is
// bounded, so there is no catastrophic-backtracking risk on large input.
const IPV6_CANDIDATE_PATTERN =
  /(?<![0-9A-Za-z_.%])(?=[0-9a-f]*:)[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){1,7}(?:\.[0-9]{1,3}){0,3}(?:%[0-9A-Za-z._-]+)?(?![0-9A-Za-z_])|(?<![0-9A-Za-z_.%])::(?:[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){0,7})?(?:\.[0-9]{1,3}){0,3}(?:%[0-9A-Za-z._-]+)?(?![0-9A-Za-z_])/gi;

// `net.isIP` rejects a trailing zone id, so strip it before validating.
const IPV6_ZONE_SUFFIX = /%[0-9A-Za-z._-]+$/;

function redactIfIPv6(match: string): string {
  const address = match.replace(IPV6_ZONE_SUFFIX, "");
  return isIP(address) === 6 ? REDACTION_IP : match;
}

// `~/.pi/agent/sessions/<encoded-cwd>/<file>.jsonl` — the exact storage
// path for Pi session JSONL files.
const PI_SESSION_PATH_PATTERN = /(?<![A-Za-z0-9_./\\-])~\/\.pi\/agent\/sessions\/[^\s'"`]+\.jsonl/g;

// Any other `~/.pi/...` path collapses to the generic `[pi-data]` marker.
const PI_DATA_PATH_PATTERN = /(?<![A-Za-z0-9_./\\-])~\/\.pi(?:\/[^\s'"`]*)?/g;

// `/home/<user>/...`, `/Users/<user>/...`, `C:\Users\<user>\...`. The
// trailing remainder is preserved verbatim because it usually carries
// project structure (e.g. `[home]/projects/foo/bar.ts`) that's already
// useful and not itself user-identifying.
const POSIX_HOME_PATTERN = /(?<![A-Za-z0-9_./\\-])\/(?:home|Users)\/[^/\s'"`]+/g;
const WINDOWS_HOME_PATTERN = /(?<![A-Za-z0-9_./\\-])[A-Za-z]:\\Users\\[^\\\s'"`]+/g;

// Other absolute paths reduce to `[abs-path]/<basename>`. POSIX form;
// Windows drive-letter paths are caught separately. The lookbehind
// also excludes `]` so the remainder of an already-redacted
// `[home]/...` or `[pi-data]/...` marker is left alone (idempotence).
const ABS_POSIX_PATTERN = /(?<![A-Za-z0-9_.\\\-\]])\/(?:[^\s'"`/()[\]<>{}]+\/)+[^\s'"`/()[\]<>{}]+/g;
const ABS_WINDOWS_PATTERN = /(?<![A-Za-z0-9_./\\\-\]])[A-Za-z]:\\(?:[^\\\s'"`]+\\)+[^\\\s'"`]+/g;

function replaceAbsPosix(match: string): string {
  const idx = match.lastIndexOf("/");
  const basename = idx >= 0 ? match.slice(idx + 1) : match;
  return `${REDACTION_ABS_PATH}/${basename}`;
}

function replaceAbsWindows(match: string): string {
  const idx = Math.max(match.lastIndexOf("\\"), match.lastIndexOf("/"));
  const basename = idx >= 0 ? match.slice(idx + 1) : match;
  return `${REDACTION_ABS_PATH}/${basename}`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- Public API ---------------------------------------------------------

/**
 * Apply the redaction patterns to `input`. Returns the input unchanged
 * for `""` and non-strings. Idempotent: `redactText(redactText(x))`
 * equals `redactText(x)`.
 */
export function redactText(input: string, opts?: RedactOptions): string {
  if (typeof input !== "string" || input.length === 0) return input;
  let out = input;

  // 1. Path family — most specific first.
  out = out.replace(PI_SESSION_PATH_PATTERN, REDACTION_PI_SESSION);
  out = out.replace(PI_DATA_PATH_PATTERN, REDACTION_PI_DATA);

  // 2. Secret family — apply before generic absolute-path collapse so
  //    tokens / JWTs that happen to contain `/` don't get shredded.
  out = out.replace(PEM_PATTERN, REDACTION_PEM);
  out = out.replace(AUTH_HEADER_PATTERN, `$1: $2 ${REDACTION_REDACTED}`);
  out = out.replace(AUTH_KV_PATTERN, `$1$2${REDACTION_REDACTED}`);
  for (const pattern of PROVIDER_TOKEN_PATTERNS) out = out.replace(pattern, REDACTION_TOKEN);
  out = out.replace(SLACK_WEBHOOK_PATTERN, REDACTION_TOKEN);
  out = out.replace(JWT_PATTERN, REDACTION_JWT);
  out = out.replace(ENV_KV_JSON_PATTERN, `$1${REDACTION_REDACTED}$2`);
  out = out.replace(ENV_KV_SQUOTE_PATTERN, `$1${REDACTION_REDACTED}$2`);
  out = out.replace(ENV_KV_BARE_PATTERN, `$1$2${REDACTION_REDACTED}$2`);
  out = out.replace(URL_USERINFO_PATTERN, `$1${REDACTION_REDACTED}@`);

  // 3. Identity-ish family — emails and IPs before path collapse so
  //    addresses don't get rewritten as `[abs-path]/...` via the
  //    generic absolute-path rules.
  out = out.replace(EMAIL_PATTERN, REDACTION_EMAIL);
  // IPv6 before IPv4 so IPv4-mapped forms (`::ffff:1.2.3.4`) collapse to
  // a single `[ip]` instead of leaving a `::ffff:` prefix.
  out = out.replace(IPV6_CANDIDATE_PATTERN, redactIfIPv6);
  out = out.replace(IPV4_PATTERN, REDACTION_IP);

  // 4. Remaining path family — home dirs before generic absolute paths
  //    so `/home/<user>/projects/foo` becomes `[home]/projects/foo`
  //    rather than `[abs-path]/foo`.
  out = out.replace(POSIX_HOME_PATTERN, REDACTION_HOME);
  out = out.replace(WINDOWS_HOME_PATTERN, REDACTION_HOME);
  out = out.replace(ABS_POSIX_PATTERN, replaceAbsPosix);
  out = out.replace(ABS_WINDOWS_PATTERN, replaceAbsWindows);

  // 5. Identity family — replace the local OS username when it appears
  //    as a bare word. Done last so it doesn't strip the username out
  //    of a `/home/<user>/...` segment before the home pattern matched.
  const user = resolveUsername(opts);
  if (user && user.length >= 2) {
    const userPattern = new RegExp(`(?<![A-Za-z0-9_-])${escapeRegex(user)}(?![A-Za-z0-9_-])`, "g");
    out = out.replace(userPattern, REDACTION_USER);
  }

  return out;
}

/** Remove trailing `/` characters without an unanchored-quantifier regex. */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end--;
  return value.slice(0, end);
}

/**
 * Stable 8-character hex reference for a project working directory.
 * Used as the opaque `projectRef` in `find_session` results so callers
 * can group matches by project without learning the raw cwd.
 */
export function projectRefFromCwd(cwd: string): string {
  const canonical = typeof cwd === "string" ? stripTrailingSlashes(cwd.replace(/\\/g, "/")) : "";
  const hash = createHash("sha256");
  hash.update(canonical);
  return hash.digest("hex").slice(0, PROJECT_REF_HEX_LENGTH);
}
