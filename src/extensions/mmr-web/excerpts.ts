/**
 * Deterministic, local excerpt selection for `read_web_page`.
 *
 * `mmr-web` treats `read_web_page.objective` as an extraction instruction:
 * given the fetched Markdown and a natural-language objective, return the
 * passages from the source most relevant to the objective. No LLM
 * summarization happens here — every returned excerpt is verbatim source
 * text plus its surrounding heading context.
 */

export interface ExtractObjectiveRelevantExcerptsArgs {
  markdown: string;
  objective: string;
  maxBytes: number;
}

export interface ExcerptResult {
  excerpts: string[];
  excerpted: boolean;
}

export const EXCERPT_SEPARATOR = "\n\n---\n\n";

/**
 * Maximum number of excerpts returned from a single objective extraction.
 *
 * Treats the excerpt list as a curated set rather than "every positively
 * scored passage that fits the byte budget": local scoring is an
 * approximation, so emitting many marginally-relevant passages dilutes the
 * useful signal in the response. The cap is a conservative ceiling; the
 * byte budget still applies on top.
 */
export const MAX_EXCERPTS = 10;

/**
 * Final hard cap on the bytes emitted by `read_web_page`, applied after
 * excerpt joining or full-Markdown fallback. Defense-in-depth against
 * pathological inputs and unusually large `maxResultBytes` settings.
 */
export const FINAL_CONTENT_CAP_BYTES = 256 * 1024;

/** Appended to truncated output when {@link FINAL_CONTENT_CAP_BYTES} is hit. */
export const TRUNCATION_MARKER = "\n\n[Content truncated at 256KB for context window]";

/**
 * Relative relevance floor used to drop marginal matches: only passages
 * whose score is at least {@link RELATIVE_SCORE_FLOOR} times the best
 * passage score are eligible. Combined with {@link MAX_EXCERPTS} and the
 * byte budget, this keeps weakly-matching single-token hits out of the
 * returned set without requiring a hard-coded absolute score.
 */
const RELATIVE_SCORE_FLOOR = 0.3;

/**
 * Multiplicative score penalty applied to passages that look like a
 * citation/footnote/bibliography list rather than informative body content.
 * Two signals trigger the penalty: the enclosing heading trail matches a
 * References-style section name, or the body itself is dense with citation
 * markers (bracketed numerics, "Retrieved <date>", "Archived from the
 * original", ISBNs, Wikipedia-style "^ Jump up to:" anchors).
 *
 * The penalty is multiplicative rather than a hard drop so that pages that
 * only have citation-style content (no body prose matches) still surface
 * something, while real body matches outrank citations on the same query.
 */
const CITATION_PENALTY = 0.15;

/**
 * Minimum number of citation markers in a passage's body to treat it as a
 * citation-dense passage even when the enclosing heading is not a known
 * References-style section. Tuned to fire on bibliography / footnote lists
 * while leaving body paragraphs that happen to contain a single citation
 * reference untouched.
 */
const CITATION_MARKER_THRESHOLD = 3;

/**
 * Heading names (case-insensitive, whole-word) that mark a section as a
 * References-style list rather than body content. Matched against any
 * level of the passage's heading trail.
 */
const REFERENCE_HEADING_NAMES = [
  "references",
  "reference",
  "bibliography",
  "citations",
  "footnotes",
  "notes",
  "works cited",
  "further reading",
];

/** Target size for a single passage before sentence-split is applied. */
const TARGET_PASSAGE_BYTES = 2048;

/** A small, conservative English stopword set. Kept small on purpose. */
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "of", "in", "on", "at", "to", "for",
  "with", "by", "from", "as", "is", "are", "was", "were", "be", "been", "being",
  "this", "that", "these", "those", "it", "its", "i", "you", "he", "she", "we",
  "they", "my", "your", "our", "their", "us", "me", "him", "her", "them",
  "do", "does", "did", "doing", "done", "has", "have", "had", "having",
  "can", "could", "should", "would", "will", "may", "might", "must", "shall",
  "what", "which", "who", "whom", "whose", "when", "where", "why", "how",
  "about", "into", "over", "under", "out", "up", "down", "off", "than", "then",
  "so", "if", "not", "no", "yes", "such", "any", "all", "some", "more", "most",
  "much", "many", "few", "other", "another", "same", "very", "just", "only",
  "tell", "find", "get", "show", "give", "explain", "describe", "info",
  "information", "please", "thanks", "regarding",
]);

interface Passage {
  /** Text including any heading prefix carried for context. */
  text: string;
  /**
   * Exact heading prefix included at the start of {@link text}, or the empty
   * string when no heading context was carried. Used at emission time to
   * strip the prefix on consecutive same-trail excerpts so the heading does
   * not visibly repeat in the joined output.
   */
  headingPrefix: string;
  /** Concatenated heading chain (for heading-match scoring). */
  heading: string;
  /** Position in the original markdown (in passages produced order). */
  index: number;
}

interface ParsedObjective {
  /** Lowercased single tokens (no stopwords, length >= 2). */
  tokens: string[];
  /** Lowercased multi-word exact phrases (from double quotes in objective). */
  phrases: string[];
}

export function extractObjectiveRelevantExcerpts(
  args: ExtractObjectiveRelevantExcerptsArgs,
): ExcerptResult {
  const objective = args.objective.trim();
  if (!objective || args.maxBytes <= 0) {
    return { excerpts: [], excerpted: false };
  }
  const parsed = parseObjective(objective);
  if (parsed.tokens.length === 0 && parsed.phrases.length === 0) {
    return { excerpts: [], excerpted: false };
  }

  const passages = splitMarkdownIntoPassages(args.markdown);
  const scored: Array<{ passage: Passage; score: number }> = [];
  for (const passage of passages) {
    const evaluation = scorePassage(passage, parsed);
    if (evaluation.score <= 0) continue;
    // Demote citation/footnote/bibliography passages so real body content
    // outranks them when both match the objective tokens. Without this,
    // pages that mention the query terms in their citation list (e.g.
    // "Smith, J. (2019). <query terms>. Retrieved …") flood the excerpt set
    // with low-information reference entries.
    const penalty = isCitationLikePassage(passage) ? CITATION_PENALTY : 1;
    scored.push({ passage, score: evaluation.score * penalty });
  }
  if (scored.length === 0) return { excerpts: [], excerpted: false };

  // Raised relevance floor: with local scoring as an approximation of the
  // curated excerpts a server-side selector would return, drop passages
  // whose score is well below the best match. This filters the kind of
  // marginal single-token hits that previously flooded the byte budget
  // with weakly-relevant text. The floor is relative so it adapts to
  // objectives with one strong token as well as multi-token queries.
  const topScore = scored.reduce((max, entry) => Math.max(max, entry.score), 0);
  const minScore = topScore * RELATIVE_SCORE_FLOOR;
  const eligible = scored.filter((entry) => entry.score >= minScore);

  // Pick highest-scoring passages within the byte budget and the top-K cap,
  // then restore original document order for the returned excerpts.
  eligible.sort((a, b) => b.score - a.score || a.passage.index - b.passage.index);
  const separatorBytes = Buffer.byteLength(EXCERPT_SEPARATOR, "utf8");
  const selected: typeof scored = [];
  let used = 0;
  for (const candidate of eligible) {
    if (selected.length >= MAX_EXCERPTS) break;
    const passageBytes = Buffer.byteLength(candidate.passage.text, "utf8");
    const sepCost = selected.length > 0 ? separatorBytes : 0;
    const projected = used + sepCost + passageBytes;
    if (selected.length > 0 && projected > args.maxBytes) continue;
    selected.push(candidate);
    used = projected;
    if (used >= args.maxBytes) break;
  }
  selected.sort((a, b) => a.passage.index - b.passage.index);
  // Drop the heading prefix on consecutive same-trail excerpts so the joined
  // output does not show the same `## Heading` line repeated immediately for
  // each sibling passage under it. The first excerpt of a same-heading run
  // keeps the prefix for context; subsequent ones emit body text only.
  const excerpts: string[] = [];
  let previousHeading: string | null = null;
  for (const entry of selected) {
    const passage = entry.passage;
    if (
      previousHeading !== null &&
      passage.heading !== "" &&
      passage.heading === previousHeading &&
      passage.headingPrefix &&
      passage.text.startsWith(passage.headingPrefix)
    ) {
      excerpts.push(passage.text.slice(passage.headingPrefix.length));
    } else {
      excerpts.push(passage.text);
    }
    previousHeading = passage.heading;
  }
  return { excerpts, excerpted: true };
}

/**
 * Return true when a passage looks like a citation/footnote/bibliography
 * entry rather than informative body content. See {@link CITATION_PENALTY}.
 */
function isCitationLikePassage(passage: Passage): boolean {
  if (isUnderReferenceHeading(passage.heading)) return true;
  return citationMarkerCount(passage.text) >= CITATION_MARKER_THRESHOLD;
}

function isUnderReferenceHeading(heading: string): boolean {
  if (!heading) return false;
  // Heading is the concatenated chain joined with spaces; each level keeps
  // its leading "#" markers (e.g. "# Topic ## References"). Strip the markers
  // and split into individual heading texts for whole-word matching.
  const headingTexts = heading
    .split(/\s*#+\s+/)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
  return headingTexts.some((text) => REFERENCE_HEADING_NAMES.includes(text));
}

function citationMarkerCount(text: string): number {
  let count = 0;
  // Bracketed citation numerics: [1], [12], [123] — capped per passage to
  // avoid over-counting long ref lists where the marker total dwarfs every
  // other signal.
  count += (text.match(/\[\d+\]/g) ?? []).length;
  // "Retrieved <date>" — common in Wikipedia citation entries.
  count += (text.match(/\bRetrieved\b[^\n]{0,40}\b\d{4}\b/g) ?? []).length;
  // Archived-from markers.
  count += (text.match(/\bArchived from\b/gi) ?? []).length;
  // ISBN references.
  count += (text.match(/\bISBN[\s-]?\d/gi) ?? []).length;
  // Wikipedia-style "^ Jump up to:" anchors.
  count += (text.match(/\^\s*Jump up to/gi) ?? []).length;
  return count;
}

function parseObjective(objective: string): ParsedObjective {
  const phrases: string[] = [];
  const phraseRe = /"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = phraseRe.exec(objective)) !== null) {
    const phrase = match[1].trim().toLowerCase();
    if (phrase) phrases.push(phrase);
  }
  const stripped = objective.replace(phraseRe, " ");
  const tokens = tokenize(stripped);
  // Also seed individual words from phrases so they contribute to term-match
  // counts (a passage with the full phrase obviously also matches the words).
  for (const phrase of phrases) {
    for (const word of tokenize(phrase)) {
      tokens.push(word);
    }
  }
  return { tokens, phrases };
}

function tokenize(text: string): string[] {
  const out: string[] = [];
  const cleaned = text.toLowerCase().replace(/[^\p{L}\p{N}\s-]+/gu, " ");
  for (const raw of cleaned.split(/\s+/)) {
    const token = raw.replace(/^-+|-+$/g, "");
    if (token.length < 2) continue;
    if (STOPWORDS.has(token)) continue;
    out.push(token);
  }
  return out;
}

interface PassageEvaluation {
  score: number;
  phraseHits: number;
  distinctTermHits: number;
  headingHits: number;
}

function scorePassage(passage: Passage, parsed: ParsedObjective): PassageEvaluation {
  const bodyLower = passage.text.toLowerCase();
  const headingLower = passage.heading.toLowerCase();

  const uniqueTokens = new Set(parsed.tokens);
  let termOccurrences = 0;
  let distinctTermHits = 0;
  let headingHits = 0;
  for (const token of uniqueTokens) {
    const bodyCount = countTokenOccurrences(bodyLower, token);
    if (bodyCount > 0) {
      distinctTermHits++;
      termOccurrences += bodyCount;
    }
    if (headingLower && countTokenOccurrences(headingLower, token) > 0) {
      headingHits++;
    }
  }
  let phraseHits = 0;
  for (const phrase of parsed.phrases) {
    phraseHits += countSubstringOccurrences(bodyLower, phrase);
  }
  if (phraseHits === 0 && distinctTermHits === 0) {
    return { score: 0, phraseHits, distinctTermHits, headingHits };
  }

  const wordCount = Math.max(1, bodyLower.split(/\s+/).length);
  const density = termOccurrences / wordCount;
  const cooccurrenceBonus = distinctTermHits >= 2 ? 5 : 0;

  const score =
    phraseHits * 10 +
    headingHits * 4 +
    distinctTermHits * 3 +
    termOccurrences +
    density * 5 +
    cooccurrenceBonus;
  return { score, phraseHits, distinctTermHits, headingHits };
}

/**
 * Apply the final hard cap on emitted content. Truncates at
 * {@link FINAL_CONTENT_CAP_BYTES} on a UTF-8 boundary and appends
 * {@link TRUNCATION_MARKER}. Returns the original text untouched when it is
 * already at or below the cap.
 */
export function applyFinalContentCap(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= FINAL_CONTENT_CAP_BYTES) {
    return { text, truncated: false };
  }
  const slice = Buffer.from(text, "utf8")
    .subarray(0, FINAL_CONTENT_CAP_BYTES)
    .toString("utf8")
    .replace(/\uFFFD+$/u, "");
  return { text: slice + TRUNCATION_MARKER, truncated: true };
}

function countTokenOccurrences(haystack: string, token: string): number {
  if (!token) return 0;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(token)}(?![\\p{L}\\p{N}])`, "gu");
  return (haystack.match(re) ?? []).length;
}

function countSubstringOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

function escapeRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

/* ------------------------------------------------------------------------- */
/* Markdown-aware passage splitter                                            */
/* ------------------------------------------------------------------------- */

function splitMarkdownIntoPassages(markdown: string): Passage[] {
  const lines = markdown.split(/\r?\n/);
  const passages: Passage[] = [];
  // Slot per heading level (1..6). Empty string when no heading at that depth.
  const headingStack: string[] = ["", "", "", "", "", ""];

  let i = 0;
  let passageIndex = 0;

  const fencedRe = /^(`{3,}|~{3,})/;
  const headingRe = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
  const listItemRe = /^\s{0,3}([-*+]|\d+[.)])\s+/;

  const pushBlock = (block: string): void => {
    const trimmed = block.replace(/^\n+|\n+$/g, "");
    if (!trimmed) return;
    const prefixParts: string[] = [];
    for (const heading of headingStack) {
      if (heading) prefixParts.push(heading);
    }
    const prefix = prefixParts.length > 0 ? prefixParts.join("\n") + "\n\n" : "";
    const headingText = prefixParts.join(" ");
    const sized = sizeSplit(prefix, trimmed, headingText, passageIndex);
    for (const passage of sized) {
      passages.push(passage);
      passageIndex++;
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    const headingMatch = headingRe.exec(line);
    if (headingMatch) {
      const level = headingMatch[1].length;
      headingStack[level - 1] = `${headingMatch[1]} ${headingMatch[2]}`;
      for (let deeper = level; deeper < headingStack.length; deeper++) {
        headingStack[deeper] = "";
      }
      i++;
      continue;
    }
    const fenceMatch = fencedRe.exec(line);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      const start = i;
      i++;
      const closeRe = new RegExp(`^${fence[0]}{${fence.length},}\\s*$`);
      while (i < lines.length && !closeRe.test(lines[i])) i++;
      if (i < lines.length) i++;
      pushBlock(lines.slice(start, i).join("\n"));
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (listItemRe.test(line)) {
      const start = i;
      while (i < lines.length) {
        const current = lines[i];
        if (listItemRe.test(current)) {
          i++;
          continue;
        }
        // Continuation of a list item: indented non-empty line.
        if (current.trim() !== "" && /^\s+\S/.test(current)) {
          i++;
          continue;
        }
        // Allow a single blank line between contiguous list items.
        if (current.trim() === "" && i + 1 < lines.length && listItemRe.test(lines[i + 1])) {
          i++;
          continue;
        }
        break;
      }
      pushBlock(lines.slice(start, i).join("\n").replace(/\n+$/, ""));
      continue;
    }
    // Default paragraph: collect until blank line, heading, or fence.
    const start = i;
    while (i < lines.length && lines[i].trim() !== "" && !headingRe.test(lines[i]) && !fencedRe.test(lines[i])) {
      i++;
    }
    pushBlock(lines.slice(start, i).join("\n"));
  }
  return passages;
}

function sizeSplit(prefix: string, body: string, heading: string, startIndex: number): Passage[] {
  const full = prefix + body;
  if (Buffer.byteLength(full, "utf8") <= TARGET_PASSAGE_BYTES) {
    return [{ text: full, headingPrefix: prefix, heading, index: startIndex }];
  }
  // Split paragraph body on sentence boundaries with one-sentence overlap.
  const sentences = splitSentences(body);
  if (sentences.length <= 1) {
    return [{ text: full, headingPrefix: prefix, heading, index: startIndex }];
  }
  const out: Passage[] = [];
  let buffer = "";
  let lastSentence = "";
  let localIndex = startIndex;
  for (const sentence of sentences) {
    const candidate = buffer ? `${buffer} ${sentence}` : sentence;
    if (buffer && Buffer.byteLength(prefix + candidate, "utf8") > TARGET_PASSAGE_BYTES) {
      out.push({ text: prefix + buffer, headingPrefix: prefix, heading, index: localIndex });
      localIndex++;
      buffer = lastSentence ? `${lastSentence} ${sentence}` : sentence;
    } else {
      buffer = candidate;
    }
    lastSentence = sentence;
  }
  if (buffer) out.push({ text: prefix + buffer, headingPrefix: prefix, heading, index: localIndex });
  return out;
}

function splitSentences(text: string): string[] {
  // Lightweight sentence splitter. Good enough for English prose; preserves
  // most punctuation. Code/lists never reach this path because they are
  // emitted as single passages above.
  const parts = text.split(/(?<=[.!?])\s+(?=[A-Z0-9])/);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}
