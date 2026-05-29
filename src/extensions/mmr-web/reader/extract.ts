/**
 * No-dependency HTML→Markdown fallback used by the custom direct reader
 * when the Readability + Turndown pipeline cannot load or does not produce
 * useful article Markdown.
 *
 * Supported tags: headings h1–h6, paragraphs, line breaks,
 * ordered/unordered lists, inline emphasis, links, inline code, fenced
 * code blocks, blockquotes. Everything else is rendered as plain text
 * content.
 *
 * Output quality is intentionally coarser than a real Markdown converter;
 * this is the fallback for pages where the heavier pipeline is not
 * available or returns nothing useful.
 */

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
  nbsp: "\u00a0",
  hellip: "\u2026",
  mdash: "\u2014",
  ndash: "\u2013",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201c",
  rdquo: "\u201d",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    if (body.startsWith("#")) {
      const code = parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    const named = HTML_ENTITIES[body];
    return named ?? match;
  });
}

function stripBlock(html: string, tag: string): string {
  const pattern = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>`, "gi");
  return html.replace(pattern, "");
}

function preferMainContent(html: string): string {
  // If the page exposes a recognized main-content container, use just that
  // slice so navigation, sidebars, and footers stop dominating the output.
  const candidates = [
    /<main\b[^>]*>([\s\S]*?)<\/main\s*>/i,
    /<article\b[^>]*>([\s\S]*?)<\/article\s*>/i,
    /<[^>]+role=["']main["'][^>]*>([\s\S]*?)<\/[a-z0-9]+\s*>/i,
  ];
  for (const re of candidates) {
    const match = re.exec(html);
    if (match && match[1] && match[1].length > 200) return match[1];
  }
  return html;
}

export interface ConvertOptions {
  /**
   * Final hard cap on the generated Markdown (in UTF-8 bytes). The
   * converter stops emitting once the budget is reached so we never
   * allocate multi-megabyte intermediate strings for huge pages.
   */
  maxBytes: number;
}

/** True for URL schemes that can carry executable code in a link target. */
function hasUnsafeUrlScheme(href: string): boolean {
  const trimmed = href.trim();
  const colon = trimmed.indexOf(":");
  if (colon <= 0) return false;
  const scheme = trimmed.slice(0, colon).toLowerCase();
  return scheme === "javascript" || scheme === "data" || scheme === "vbscript";
}

export function htmlToMarkdown(rawHtml: string, options: ConvertOptions): string {
  let html = rawHtml;
  // Strip top-level junk that never contributes to readable content.
  // Repeat the comment strip until stable so a comment that only forms after
  // an inner comment is removed (e.g. `<!--<!-- -->-->`) cannot survive.
  let prevHtml: string;
  do {
    prevHtml = html;
    html = html.replace(/<!--[\s\S]*?-->/g, "");
  } while (html !== prevHtml);
  html = html.replace(/<!DOCTYPE[^>]*>/gi, "");
  html = stripBlock(html, "script");
  html = stripBlock(html, "style");
  html = stripBlock(html, "noscript");
  html = stripBlock(html, "template");
  html = stripBlock(html, "svg");
  html = stripBlock(html, "iframe");
  html = preferMainContent(html);
  // Strip layout chrome only after the main-content extraction so we don't
  // accidentally drop an <article> that lives inside a <header>.
  html = stripBlock(html, "nav");
  html = stripBlock(html, "header");
  html = stripBlock(html, "footer");
  html = stripBlock(html, "aside");
  html = stripBlock(html, "form");

  const out: string[] = [];
  let bytes = 0;
  const budget = options.maxBytes;

  function push(chunk: string): boolean {
    if (bytes >= budget) return false;
    const remaining = budget - bytes;
    if (Buffer.byteLength(chunk, "utf8") <= remaining) {
      out.push(chunk);
      bytes += Buffer.byteLength(chunk, "utf8");
      return true;
    }
    // Slice on a UTF-8 boundary.
    const buf = Buffer.from(chunk, "utf8");
    const sliced = buf.subarray(0, remaining).toString("utf8").replace(/\uFFFD+$/u, "");
    out.push(sliced);
    bytes += Buffer.byteLength(sliced, "utf8");
    return false;
  }

  // State for list rendering. Stack tracks nested <ul>/<ol> context.
  const listStack: Array<{ type: "ul" | "ol"; counter: number }> = [];
  let currentHref: string | undefined;

  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  let inPre = false;
  while ((match = tagRe.exec(html)) !== null) {
    if (bytes >= budget) break;
    const before = html.slice(cursor, match.index);
    if (before) {
      const text = decodeEntities(before);
      if (inPre) {
        if (!push(text)) break;
      } else {
        const collapsed = text.replace(/\s+/g, " ");
        if (collapsed.trim() || collapsed === " ") {
          if (!push(collapsed)) break;
        }
      }
    }
    cursor = tagRe.lastIndex;
    const raw = match[0]!;
    const tag = match[1]!.toLowerCase();
    const isClose = raw.startsWith("</");
    const isSelfClose = raw.endsWith("/>");
    const attrs = match[2] ?? "";

    switch (tag) {
      case "br":
        if (!push("\n")) break;
        break;
      case "hr":
        if (!push("\n\n---\n\n")) break;
        break;
      case "p":
      case "div":
      case "section":
        if (!push(isClose ? "\n\n" : "\n\n")) break;
        break;
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6": {
        const level = Number(tag.slice(1));
        if (isClose) {
          if (!push("\n\n")) break;
        } else {
          if (!push(`\n\n${"#".repeat(level)} `)) break;
        }
        break;
      }
      case "ul":
      case "ol":
        if (isClose) {
          listStack.pop();
          if (!push("\n")) break;
        } else {
          listStack.push({ type: tag, counter: 0 });
          if (!push("\n")) break;
        }
        break;
      case "li":
        if (!isClose) {
          const top = listStack[listStack.length - 1];
          const indent = "  ".repeat(Math.max(0, listStack.length - 1));
          if (top?.type === "ol") {
            top.counter += 1;
            if (!push(`\n${indent}${top.counter}. `)) break;
          } else {
            if (!push(`\n${indent}- `)) break;
          }
        }
        break;
      case "strong":
      case "b":
        if (!push("**")) break;
        break;
      case "em":
      case "i":
        if (!push("*")) break;
        break;
      case "code":
        if (!inPre) {
          if (!push("`")) break;
        }
        break;
      case "pre":
        inPre = !isClose;
        if (!push(isClose ? "\n```\n\n" : "\n\n```\n")) break;
        break;
      case "blockquote":
        if (!push(isClose ? "\n\n" : "\n\n> ")) break;
        break;
      case "a": {
        if (isClose) {
          // Closing handled by tracked href below.
          const href = currentHref;
          if (href) {
            if (!push(`](${href})`)) break;
            currentHref = undefined;
          }
        } else {
          const hrefMatch = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
          const href = hrefMatch ? (hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3] ?? "") : "";
          if (href && !hasUnsafeUrlScheme(href)) {
            currentHref = href;
            if (!push("[")) break;
          }
        }
        break;
      }
      default:
        // Ignore unknown tags; pass through inner text only.
        break;
    }
    if (!isClose && isSelfClose && tag === "a") {
      // Self-closing anchor; reset any opened link.
      currentHref = undefined;
    }
  }
  // Trailing text after the last tag.
  if (cursor < html.length && bytes < budget) {
    const tail = decodeEntities(html.slice(cursor));
    const collapsed = inPre ? tail : tail.replace(/\s+/g, " ").trim();
    if (collapsed) push(collapsed);
  }

  return out.join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
