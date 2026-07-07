import { isTableRow, parseCells } from "./tables.js";

export function isWordSep(ch) {
  if (!ch) return true;
  if (/\s/.test(ch)) return true;
  if (ch === "|" || ch === "│") return true;
  const code = ch.charCodeAt(0);
  if (code >= 0x3000 && code <= 0x303f) return true; // CJK symbols & punctuation
  if (code >= 0xff00 && code <= 0xffef) return true; // full-width forms
  if (code >= 0x4e00 && code <= 0x9fff) return true; // CJK unified ideographs
  return false;
}

/** Start of the "word" containing position `idx` in `text`. */
export function wordStartBefore(text, idx) {
  let i = idx;
  while (i > 0 && !isWordSep(text.charAt(i - 1))) i--;
  return i;
}

/**
 * Extend `start` backward by up to `n` more whole words so the snippet has real
 * context: skip a run of separators, then walk through one more word. Stops at
 * hard boundaries (CJK char, table pipe, line start).
 */
export function extendPrefixWords(text, start, n) {
  let cursor = start;
  while (n > 0 && cursor > 0) {
    let p = cursor;
    while (p > 0 && isWordSep(text.charAt(p - 1)) && text.charAt(p - 1) !== "|") p--;
    if (p === cursor) break; // no separators to skip
    if (p > 0 && text.charAt(p - 1) === "|") break; // don't cross table cells
    const end = p;
    while (p > 0 && !isWordSep(text.charAt(p - 1))) p--;
    if (p === end) break;
    cursor = p;
    n--;
  }
  return cursor;
}

/** Source-level ranges occupied by Markdown image syntax on a line. */
export function imageSpansIn(line) {
  const spans = [];
  let re = /!\[\[[^\]\n]*\]\]/g;
  let m;
  while ((m = re.exec(line)) !== null)
    spans.push([m.index, m.index + m[0].length]);
  re = /!\[[^\]\n]*\]\([^)\n]*\)/g;
  while ((m = re.exec(line)) !== null)
    spans.push([m.index, m.index + m[0].length]);
  return spans;
}

/**
 * Source-level ranges that are not visible in Reading mode. Examples:
 *   [visible text](hidden-url)       -> URL and brackets are hidden
 *   [[hidden-target|visible alias]]  -> target / pipe / brackets are hidden
 *   ![[image.png]] and ![alt](img)   -> whole image syntax is hidden as text
 */
export function hiddenSpansInReading(line) {
  const spans = [...imageSpansIn(line)];
  let m;

  // Standard Markdown links. Keep only the label between [ and ] visible.
  const mdLink = /(?<!!)\[([^\]\n]*)\]\(([^)\n]*)\)/g;
  while ((m = mdLink.exec(line)) !== null) {
    const textStart = m.index + 1;
    const textEnd = textStart + m[1].length;
    spans.push([m.index, textStart]);
    spans.push([textEnd, m.index + m[0].length]);
  }

  // Obsidian wikilinks. [[Page]] shows Page; [[Page|Alias]] shows Alias.
  const wiki = /(?<!!)\[\[([^|\]\n]*)(?:\|([^\]\n]*))?\]\]/g;
  while ((m = wiki.exec(line)) !== null) {
    if (m[2] != null) {
      const aliasStart = m.index + m[0].indexOf("|") + 1;
      const aliasEnd = m.index + m[0].length - 2;
      spans.push([m.index, aliasStart]);
      spans.push([aliasEnd, m.index + m[0].length]);
    } else {
      spans.push([m.index, m.index + 2]);
      spans.push([m.index + m[0].length - 2, m.index + m[0].length]);
    }
  }

  return spans.sort((a, b) => a[0] - b[0]);
}

export function isInsideSpan(ch, spans) {
  for (const [a, b] of spans) if (ch >= a && ch < b) return true;
  return false;
}

/** For a table row, return the previous cell's text as a semantic anchor. */
export function previousCellOf(line, ch) {
  if (!isTableRow(line)) return null;
  const cells = parseCells(line);
  for (let c = 0; c < cells.length; c++) {
    const cell = cells[c];
    if (ch >= cell.start && ch <= cell.start + cell.text.length) {
      for (let p = c - 1; p >= 0; p--) {
        const t = cells[p].text.trim();
        if (t) return t.replace(/[*_`]/g, "").replace(/\s+/g, " ").slice(0, 24);
      }
      return null;
    }
  }
  return null;
}

export function parseHeading(line, lineIdx) {
  const m = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line || "");
  if (!m) return null;
  return { level: m[1].length, text: m[2], line: lineIdx };
}

/**
 * One O(lines) pass: for every line and heading level, the nearest Markdown
 * heading (of that level or above) at or before that line. lookup[level][line]
 * replaces the per-call upward scan in nearestHeading.
 */
export function buildHeadingLookup(lines) {
  const parsed = new Array(lines.length);
  for (let i = 0; i < lines.length; i++) parsed[i] = parseHeading(lines[i], i);
  const byLevel = [];
  for (let level = 1; level <= 6; level++) {
    const arr = new Array(lines.length);
    let current = null;
    for (let i = 0; i < lines.length; i++) {
      const h = parsed[i];
      if (h && h.level <= level) current = h;
      arr[i] = current;
    }
    byLevel[level] = arr;
  }
  return byLevel;
}

/** Walk up source lines to find the nearest Markdown heading above `lineIdx`. */
export function nearestHeading(lines, lineIdx, maxLevel = 6, lookup) {
  if (lookup && lookup[maxLevel]) return lookup[maxLevel][lineIdx] || null;
  for (let i = lineIdx; i >= 0; i--) {
    const heading = parseHeading(lines[i], i);
    if (heading && heading.level <= maxLevel) return heading;
  }
  return null;
}

export function cleanHeadingText(text) {
  return (text || "").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
}

export function headingGroupForLine(lines, lineIdx, maxLevel, lookup) {
  const heading = nearestHeading(lines, lineIdx, maxLevel, lookup);
  if (heading) return { ...heading, text: cleanHeadingText(heading.text) };
  return { level: 0, line: -1, text: "No heading" };
}

export function headingGroupKey(group) {
  return `${group.line}:${group.level}:${group.text}`;
}

/** Strip common Markdown noise from a source line for clean list snippets. */
export function cleanSnippet(line) {
  return line
    .replace(/!\[\[[^\]\n]*\]\]/g, "") // Obsidian image embeds
    .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, "") // standard images
    .replace(/(?<!!)\[([^\]\n]*)\]\([^)\n]*\)/g, "$1") // standard links
    .replace(/(?<!!)\[\[([^|\]\n]*)(?:\|([^\]\n]*))?\]\]/g, (_, target, alias) => alias || target)
    .replace(/^[\s>#*+\-]+/, "")
    .replace(/[*_`]/g, "")
    .replace(/\|/g, " ")
    .replace(/[│├└─]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}


/** Convert a small Markdown inline fragment to the text users actually read. */
export function visibleInlineText(text) {
  return (text || "")
    .replace(/!\[\[[^\]\n]*\]\]/g, "") // image embed: not readable text
    .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, "") // standard image
    .replace(/(?<!!)\[([^\]\n]*)\]\([^)\n]*\)/g, "$1") // [label](url) -> label
    .replace(/(?<!!)\[\[([^|\]\n]*)(?:\|([^\]\n]*))?\]\]/g, (_, target, alias) => alias || target)
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/[*_`~]/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}
