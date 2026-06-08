export interface SessionQuery {
  terms: string[];
  id?: string;
  name?: string;
  after?: Date;
  before?: Date;
  /** One entry per `file:<value>` token; values are lowercased for matching. */
  file: string[];
  /** Original `file:<value>` tokens, preserved for diagnostics. */
  fileTokens: string[];
  /** One entry per `repo:<value>` token; values are lowercased for matching. */
  repo: string[];
  /** Original `repo:<value>` tokens, preserved for diagnostics. */
  repoTokens: string[];
  unsupportedFilters: string[];
  /**
   * `after:`/`before:` tokens whose value did not parse as a date. The date
   * filter is silently not applied (result semantics unchanged), but the
   * token is recorded here so the tool can surface an actionable diagnostic
   * instead of dropping it without a signal.
   */
  invalidFilters: string[];
  /** Original tokens that parsed as `key:value` filters (used for diagnostics). */
  appliedFilterTokens: string[];
}

const FILTER_RE = /^([a-zA-Z_][\w-]*):(.*)$/;

function parseRelativeDate(value: string, now: Date): Date | undefined {
  const match = /^(\d+)([dw])$/i.exec(value.trim());
  if (!match) return undefined;
  const amount = Number.parseInt(match[1]!, 10);
  const unit = match[2]!.toLowerCase();
  const days = unit === "w" ? amount * 7 : amount;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

function parseDateFilter(value: string, now: Date): Date | undefined {
  const relative = parseRelativeDate(value, now);
  if (relative) return relative;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export function tokenizeSessionQuery(query: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]+)"|'([^']+)'|(\S+)/g;
  for (const match of query.matchAll(re)) {
    const token = match[1] ?? match[2] ?? match[3];
    if (token) tokens.push(token);
  }
  return tokens;
}

export function parseSessionQuery(query: string, now = new Date()): SessionQuery {
  const parsed: SessionQuery = {
    terms: [],
    file: [],
    fileTokens: [],
    repo: [],
    repoTokens: [],
    unsupportedFilters: [],
    invalidFilters: [],
    appliedFilterTokens: [],
  };
  for (const token of tokenizeSessionQuery(query)) {
    const filter = FILTER_RE.exec(token);
    if (!filter) {
      parsed.terms.push(token);
      continue;
    }
    const key = filter[1]!.toLowerCase();
    const value = filter[2]!.trim();
    if (!value) continue;
    if (key === "id") {
      parsed.id = value;
      parsed.appliedFilterTokens.push(`id:${value}`);
    } else if (key === "name") {
      parsed.name = value;
      parsed.appliedFilterTokens.push(`name:${value}`);
    } else if (key === "after") {
      const date = parseDateFilter(value, now);
      if (date) {
        parsed.after = date;
        parsed.appliedFilterTokens.push(`after:${value}`);
      } else {
        parsed.invalidFilters.push(`after:${value}`);
      }
    } else if (key === "before") {
      const date = parseDateFilter(value, now);
      if (date) {
        parsed.before = date;
        parsed.appliedFilterTokens.push(`before:${value}`);
      } else {
        parsed.invalidFilters.push(`before:${value}`);
      }
    } else if (key === "file") {
      parsed.file.push(value.toLowerCase());
      parsed.fileTokens.push(`file:${value}`);
    } else if (key === "repo") {
      parsed.repo.push(value.toLowerCase());
      parsed.repoTokens.push(`repo:${value}`);
    } else {
      parsed.unsupportedFilters.push(`${key}:${value}`);
    }
  }
  return parsed;
}

export function includesCaseInsensitive(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}
