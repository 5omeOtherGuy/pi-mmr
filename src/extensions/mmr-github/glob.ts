/**
 * Documented glob matcher for repository file paths.
 *
 * Stdlib note: Node has no built-in glob path matcher, and adding a glob
 * dependency would require approval. This implementation compiles the pattern
 * to a single anchored RegExp and supports:
 *
 * - `*`    matches any run of characters except `/`
 * - `**`   matches any run of characters including `/` (any path segments)
 * - a `**` segment followed by a slash matches zero or more leading path
 *   segments (so `a/**` + `/b` also matches `a/b`)
 * - `?`    matches exactly one character except `/`
 * - `{a,b}` brace alternation
 * - `[...]` character classes restricted to a validated subset: ASCII
 *   letters, digits, `_`, and `.` as literal members, ascending ranges of
 *   those characters (e.g. `[a-z]`, `[0-9]`), and an optional leading `!` or
 *   `^` negation. Unsupported or malformed class syntax (empty class,
 *   out-of-order range, any other member character) raises a typed
 *   {@link GlobPatternError} instead of being passed to the RegExp verbatim,
 *   so no internal regex error text leaks to callers.
 * - all other characters match literally (regex metacharacters are escaped)
 *
 * Matching is case-sensitive and anchored to the full path.
 */

/** Thrown for unsupported or malformed glob syntax (e.g. a bad character class). */
export class GlobPatternError extends Error {
  readonly pattern: string;
  constructor(pattern: string, detail: string) {
    super(`unsupported glob pattern \`${pattern}\`: ${detail}`);
    this.name = "GlobPatternError";
    this.pattern = pattern;
  }
}

/** Members allowed inside a `[...]` class: ASCII letters, digits, `_`, `.`. */
const GLOB_CLASS_CHAR = /^[A-Za-z0-9_.]$/;

/**
 * Validate a `[...]` character-class body (text between the brackets) against
 * the documented subset and return a safe, anchored regex class. All allowed
 * members are literal inside a regex class, so the result cannot inject regex
 * syntax or throw at `new RegExp` time.
 */
function compileCharClass(pattern: string, body: string): string {
  let rest = body;
  let negate = "";
  if (rest.startsWith("!") || rest.startsWith("^")) {
    negate = "^";
    rest = rest.slice(1);
  }
  if (rest.length === 0) {
    throw new GlobPatternError(pattern, "empty character class is not supported");
  }
  let out = "";
  let j = 0;
  while (j < rest.length) {
    const start = rest[j]!;
    if (!GLOB_CLASS_CHAR.test(start)) {
      throw new GlobPatternError(pattern, "character class contains unsupported syntax");
    }
    if (rest[j + 1] === "-" && j + 2 < rest.length) {
      const end = rest[j + 2]!;
      if (!GLOB_CLASS_CHAR.test(end)) {
        throw new GlobPatternError(pattern, "character class contains unsupported syntax");
      }
      if (start.charCodeAt(0) > end.charCodeAt(0)) {
        throw new GlobPatternError(pattern, "character class range is out of order");
      }
      out += `${start}-${end}`;
      j += 3;
    } else {
      out += start;
      j += 1;
    }
  }
  return `[${negate}${out}]`;
}

function escapeLiteral(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function globToRegExp(pattern: string): RegExp {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i]!;
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          // `**/` — zero or more leading path segments.
          out += "(?:.+/)?";
          i += 3;
        } else {
          // `**` — any characters including path separators.
          out += ".*";
          i += 2;
        }
      } else {
        out += "[^/]*";
        i += 1;
      }
    } else if (char === "?") {
      out += "[^/]";
      i += 1;
    } else if (char === "{") {
      const close = pattern.indexOf("}", i);
      if (close !== -1) {
        const alts = pattern.slice(i + 1, close).split(",");
        out += `(?:${alts.map(escapeLiteral).join("|")})`;
        i = close + 1;
      } else {
        out += escapeLiteral(char);
        i += 1;
      }
    } else if (char === "[") {
      const close = pattern.indexOf("]", i);
      if (close !== -1) {
        // Validate against the documented subset (e.g. `[a-z]`) and emit a
        // safe regex class; unsupported syntax raises GlobPatternError before
        // `new RegExp`, so no raw regex error text can leak.
        out += compileCharClass(pattern, pattern.slice(i + 1, close));
        i = close + 1;
      } else {
        out += escapeLiteral(char);
        i += 1;
      }
    } else {
      out += escapeLiteral(char);
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

const cache = new Map<string, RegExp>();

export function matchGlob(pattern: string, candidate: string): boolean {
  let regex = cache.get(pattern);
  if (!regex) {
    regex = globToRegExp(pattern);
    if (cache.size > 256) cache.clear();
    cache.set(pattern, regex);
  }
  return regex.test(candidate);
}
