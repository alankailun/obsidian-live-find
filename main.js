"use strict";

const { Plugin, MarkdownView, Notice, setIcon } = require("obsidian");

const HL_ALL = "live-find-all";
const HL_CURRENT = "live-find-current";

// Hard-coded knobs. Flip DEBUG to true while developing; the others are
// reasonable defaults — adjust here if you ever need to tune them.
const DEBUG = false;
const DEBOUNCE_MS = 100;
const MAX_DOM_HIGHLIGHTS = 2500;

const SELECTORS = {
  readingRoot: ".markdown-reading-view, .markdown-preview-view",
  editorRoot: ".cm-content",
  scroller: ".cm-scroller, .markdown-preview-view",
};

function debugWarn(where, err) {
  if (!DEBUG) return;
  console.warn(`[LiveFind] ${where}`, err);
}

function debounce(fn, ms) {
  let t;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => {
    clearTimeout(t);
    t = null;
  };
  return wrapped;
}

/* ----------------------------- matching engine ----------------------------- */

/** Build a matcher from query + flags. Returns null if no query. */
function buildMatcher(query, caseSensitive, useRegex, wholeWord) {
  if (!query) return null;
  if (useRegex) {
    try {
      return { regex: new RegExp(query, "g" + (caseSensitive ? "" : "i")), wholeWord };
    } catch (e) {
      return { invalid: true, error: e && e.message ? e.message : "Invalid regular expression" };
    }
  }
  return { needle: caseSensitive ? query : query.toLowerCase(), caseSensitive, wholeWord };
}

function isSearchWordChar(ch) {
  return !!ch && /[A-Za-z0-9_]/.test(ch);
}

function isWholeWordMatch(text, index, length) {
  return (
    !isSearchWordChar(text.charAt(index - 1)) &&
    !isSearchWordChar(text.charAt(index + length))
  );
}

/** Find every match of matcher in text. Returns [{ index, length }]. */
function findAll(text, matcher) {
  const out = [];
  if (!text || !matcher || matcher.invalid) return out;
  if (matcher.regex) {
    matcher.regex.lastIndex = 0;
    let m;
    while ((m = matcher.regex.exec(text)) !== null) {
      if (m[0].length === 0) {
        matcher.regex.lastIndex++;
        continue;
      }
      if (!matcher.wholeWord || isWholeWordMatch(text, m.index, m[0].length))
        out.push({ index: m.index, length: m[0].length });
    }
  } else {
    const hay = matcher.caseSensitive ? text : text.toLowerCase();
    const n = matcher.needle;
    let from = 0;
    while (true) {
      const i = hay.indexOf(n, from);
      if (i === -1) break;
      if (!matcher.wholeWord || isWholeWordMatch(text, i, n.length))
        out.push({ index: i, length: n.length });
      from = i + n.length;
    }
  }
  return out;
}

/* ----------------------------- view helpers ----------------------------- */

function getRenderRoot(view) {
  if (!view || !view.containerEl || typeof view.getMode !== "function") return null;
  const mode = view.getMode();
  return view.containerEl.querySelector(
    mode === "preview" ? SELECTORS.readingRoot : SELECTORS.editorRoot
  );
}

function getScroller(view) {
  if (!view || !view.containerEl) return null;
  return view.containerEl.querySelector(SELECTORS.scroller);
}

function getEditorView(editor) {
  return editor && editor.cm ? editor.cm : null;
}

/** Complete, viewport-independent search of the note SOURCE. */
function findSourceMatches(lines, matcher) {
  const res = [];
  if (!matcher || matcher.invalid) return res;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const mt of findAll(line, matcher)) {
      res.push({ line: i, ch: mt.index, len: mt.length, lineText: line });
    }
  }
  return res;
}

/** Occurrences in the currently-rendered DOM (for highlighting). */
function findRenderedMatches(root, matcher) {
  const matches = [];
  if (!root || !matcher || matcher.invalid) return matches;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim())
        return NodeFilter.FILTER_REJECT;
      const tag = node.parentElement && node.parentElement.tagName;
      if (tag === "SCRIPT" || tag === "STYLE") return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node;
  while ((node = walker.nextNode())) {
    const text = node.nodeValue;
    for (const mt of findAll(text, matcher)) {
      const range = document.createRange();
      range.setStart(node, mt.index);
      range.setEnd(node, mt.index + mt.length);
      matches.push({
        range,
        el: node.parentElement,
        text,
        index: mt.index,
        length: mt.length,
      });
    }
  }
  return matches;
}

function rangeCenterY(range) {
  try {
    if (!range) return null;
    const rect = range.getBoundingClientRect();
    if (!Number.isFinite(rect.top) || !Number.isFinite(rect.bottom)) return null;
    return (rect.top + rect.bottom) / 2;
  } catch (e) {
    debugWarn("rangeCenterY", e);
    return null;
  }
}

function viewportCenterY(scroller) {
  try {
    if (!scroller || typeof scroller.getBoundingClientRect !== "function") return null;
    const rect = scroller.getBoundingClientRect();
    if (!Number.isFinite(rect.top) || !Number.isFinite(rect.bottom)) return null;
    return (rect.top + rect.bottom) / 2;
  } catch (e) {
    debugWarn("viewportCenterY", e);
    return null;
  }
}

/**
 * Keep the rendered yellow highlights centered around the current orange match.
 * The search count/list still comes from the full note source; this only limits
 * how many DOM ranges are sent to the CSS Highlight API at once.
 */
function limitDomHighlightsAroundCurrent(dom, currentRange, max, scroller) {
  if (!Array.isArray(dom) || !dom.length) return [];
  const n = Number(max);
  if (!Number.isFinite(n) || n <= 0 || dom.length <= n) return dom;

  const centerY = rangeCenterY(currentRange) ?? viewportCenterY(scroller);
  if (centerY == null) return dom.slice(0, n);

  return dom
    .map((d, i) => {
      const y = rangeCenterY(d.range);
      return {
        item: d,
        index: i,
        dist: y == null ? Infinity : Math.abs(y - centerY),
      };
    })
    .sort((a, b) => a.dist - b.dist || a.index - b.index)
    .slice(0, n)
    .sort((a, b) => a.index - b.index)
    .map((x) => x.item);
}

/* ----------------------------- table cell mapping ----------------------------- */

function isTableRow(line) {
  const t = line.trim();
  return t.startsWith("|") && t.includes("|", 1);
}

function isDelimiterRow(line) {
  return /^\s*\|?[\s:|\-]+\|?\s*$/.test(line) && line.includes("-");
}

function parseCells(line) {
  const cells = [];
  let cur = "";
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\" && i + 1 < line.length) {
      cur += c + line[i + 1];
      i++;
      continue;
    }
    if (c === "|") {
      cells.push({ text: cur, start });
      cur = "";
      start = i + 1;
      continue;
    }
    cur += c;
  }
  cells.push({ text: cur, start });
  return cells;
}

function locateInTables(lines, lineIdx) {
  let tableIdx = -1;
  let i = 0;
  while (i < lines.length) {
    if (!isTableRow(lines[i])) {
      i++;
      continue;
    }

    const blockStart = i;
    let j = i;
    while (j < lines.length && isTableRow(lines[j])) j++;

    let delimOffset = -1;
    for (let k = blockStart; k < j; k++) {
      if (isDelimiterRow(lines[k])) {
        delimOffset = k - blockStart;
        break;
      }
    }

    // A real Markdown table needs a delimiter row. Avoid treating code / ASCII
    // art / arbitrary pipe-prefixed lines as tables.
    if (delimOffset === -1) {
      i = j;
      continue;
    }

    tableIdx++;
    if (lineIdx >= blockStart && lineIdx < j) {
      const offset = lineIdx - blockStart;
      if (offset === 0) return { tableIdx, kind: "header" };
      if (offset === delimOffset) return { tableIdx, kind: "delim" };
      const bodyRowIdx = offset - (delimOffset + 1);
      return { tableIdx, kind: "body", bodyRowIdx };
    }
    i = j;
  }
  return null;
}

function cellInfoForMatch(line, ch, matcher) {
  const cells = parseCells(line);
  let dataCol = -1;
  for (let c = 0; c < cells.length; c++) {
    const cell = cells[c];
    const isEdgeEmpty =
      (c === 0 || c === cells.length - 1) && cell.text.trim() === "";
    if (!isEdgeEmpty) dataCol++;
    const start = cell.start;
    const end = start + cell.text.length;
    if (ch >= start && ch <= end) {
      const offInCell = ch - start;
      let kInCell = 0;
      for (const mt of findAll(cell.text, matcher)) {
        if (mt.index < offInCell) kInCell++;
        else break;
      }
      return { col: dataCol, kInCell };
    }
  }
  return null;
}

function findKthOccurrenceRange(el, matcher, k) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node;
  let count = 0;
  while ((node = walker.nextNode())) {
    for (const mt of findAll(node.nodeValue, matcher)) {
      if (count === k) {
        const r = document.createRange();
        r.setStart(node, mt.index);
        r.setEnd(node, mt.index + mt.length);
        return r;
      }
      count++;
    }
  }
  return null;
}

function resolveByDomAtPos(cm, off, matcher) {
  try {
    if (!cm || typeof cm.domAtPos !== "function") return null;
    const d = cm.domAtPos(off);
    const node = d.node;
    if (!node || node.nodeType !== Node.TEXT_NODE) return null;
    const all = findAll(node.nodeValue, matcher);
    let best = null;
    let bestDist = Infinity;
    for (const mt of all) {
      const dist = Math.abs(mt.index - d.offset);
      if (dist < bestDist) {
        bestDist = dist;
        best = mt;
      }
    }
    if (!best || bestDist > 3) return null;
    const r = document.createRange();
    r.setStart(node, best.index);
    r.setEnd(node, best.index + best.length);
    return r;
  } catch (e) {
    debugWarn("resolveByDomAtPos", e);
    return null;
  }
}

function closestElementFromNode(node) {
  if (!node) return null;
  return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
}

function tableFromDomAtPos(cm, off) {
  try {
    if (!cm || typeof cm.domAtPos !== "function") return null;
    const d = cm.domAtPos(off);
    const el = closestElementFromNode(d && d.node);
    return el && el.closest ? el.closest("table") : null;
  } catch (e) {
    debugWarn("tableFromDomAtPos", e);
    return null;
  }
}

function tableFromPoint(cm, off) {
  try {
    if (!cm || typeof cm.coordsAtPos !== "function") return null;
    const coords = cm.coordsAtPos(off);
    if (!coords) return null;
    const y = (coords.top + coords.bottom) / 2;
    const xs = [coords.left + 1, coords.left + 20, 120, window.innerWidth / 2];
    for (const x of xs) {
      const el = document.elementFromPoint(x, y);
      const t = el && el.closest && el.closest("table");
      if (t) return t;
    }
    return null;
  } catch (e) {
    debugWarn("tableFromPoint", e);
    return null;
  }
}

function resolveTableByPoint(cm, off, lines, m, matcher) {
  try {
    const tableEl = tableFromDomAtPos(cm, off) || tableFromPoint(cm, off);
    if (!tableEl) return null;

    const info = cellInfoForMatch(lines[m.line], m.ch, matcher);
    if (!info || info.col < 0) return null;
    const loc = locateInTables(lines, m.line);
    if (!loc || loc.kind === "delim") return null;

    let rowEl = null;
    if (loc.kind === "header") {
      rowEl = tableEl.querySelector("thead tr") || tableEl.querySelector("tr");
    } else {
      rowEl = tableEl.querySelectorAll("tbody tr")[loc.bodyRowIdx];
    }
    if (!rowEl) return null;

    const cellEl = rowEl.querySelectorAll("th, td")[info.col];
    if (!cellEl) return null;
    return findKthOccurrenceRange(cellEl, matcher, info.kInCell);
  } catch (e) {
    debugWarn("resolveTableByPoint", e);
    return null;
  }
}

/**
 * True if `ch` should be treated as a "word" boundary for snippet purposes:
 * whitespace, table pipes, CJK punctuation, full-width forms, or any CJK char
 * (each Chinese character is its own word).
 */
function isWordSep(ch) {
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
function wordStartBefore(text, idx) {
  let i = idx;
  while (i > 0 && !isWordSep(text.charAt(i - 1))) i--;
  return i;
}

/**
 * Extend `start` backward by up to `n` more whole words so the snippet has real
 * context: skip a run of separators, then walk through one more word. Stops at
 * hard boundaries (CJK char, table pipe, line start).
 */
function extendPrefixWords(text, start, n) {
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
function imageSpansIn(line) {
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
function hiddenSpansInReading(line) {
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

function isInsideSpan(ch, spans) {
  for (const [a, b] of spans) if (ch >= a && ch < b) return true;
  return false;
}

/** For a table row, return the previous cell's text as a semantic anchor. */
function previousCellOf(line, ch) {
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

/** Walk up source lines to find the nearest Markdown heading above `lineIdx`. */
function nearestHeading(lines, lineIdx) {
  for (let i = lineIdx; i >= 0; i--) {
    const ln = lines[i];
    const m = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(ln);
    if (m) return { level: m[1].length, text: m[2] };
  }
  return null;
}

/** Strip common Markdown noise from a source line for clean list snippets. */
function cleanSnippet(line) {
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
function visibleInlineText(text) {
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

function tableDataCells(line) {
  const raw = parseCells(line);
  const out = [];
  let dataCol = -1;
  for (let i = 0; i < raw.length; i++) {
    const cell = raw[i];
    const isEdgeEmpty =
      (i === 0 || i === raw.length - 1) && cell.text.trim() === "";
    if (isEdgeEmpty) continue;
    dataCol++;
    out.push({ ...cell, dataCol });
  }
  return out;
}

function tableBlockForLine(lines, lineIdx) {
  let i = 0;
  while (i < lines.length) {
    if (!isTableRow(lines[i])) {
      i++;
      continue;
    }

    const blockStart = i;
    let j = i;
    while (j < lines.length && isTableRow(lines[j])) j++;

    let delimLine = -1;
    for (let k = blockStart; k < j; k++) {
      if (isDelimiterRow(lines[k])) {
        delimLine = k;
        break;
      }
    }

    if (delimLine !== -1 && lineIdx >= blockStart && lineIdx < j) {
      return { blockStart, blockEnd: j, headerLine: blockStart, delimLine };
    }
    i = j;
  }
  return null;
}

function isMostlyCJK(text) {
  const compact = (text || "").replace(/\s+/g, "");
  if (!compact) return false;
  const cjk = (compact.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  return cjk >= 2 && cjk / compact.length >= 0.25;
}

function snippetWindow(source, hitIdx, hitLen, keepShort = false) {
  if (keepShort && source.length <= 180) return { s: 0, e: source.length };

  if (isMostlyCJK(source)) {
    const s = Math.max(0, hitIdx - 14);
    const e = Math.min(source.length, hitIdx + hitLen + 34);
    return { s, e };
  }

  let s = wordStartBefore(source, hitIdx);
  if (hitIdx - s === 0) s = extendPrefixWords(source, s, 2);
  const e = Math.min(source.length, hitIdx + hitLen + 80);
  return { s, e };
}

function appendHighlightedSnippet(container, source, hitIdx, hitLen, keepShort = false) {
  if (!source) return;
  if (hitIdx == null || hitIdx < 0 || hitLen <= 0) {
    container.appendText(source.slice(0, 120));
    if (source.length > 120) container.appendText("…");
    return;
  }

  const { s, e } = snippetWindow(source, hitIdx, hitLen, keepShort);
  const win = source.slice(s, e);
  const ls = hitIdx - s;
  const le = ls + hitLen;

  if (s > 0) container.appendText("…");
  if (ls > 0) container.appendText(win.slice(0, ls));
  container.createEl("strong", { text: win.slice(ls, le) });
  if (le < win.length) container.appendText(win.slice(le));
  if (e < source.length) container.appendText("…");
}

function normalizeSnippetPart(text) {
  return visibleInlineText(text).replace(/\s+/g, " ").trim();
}

function ellipsizeMiddle(text, maxLen = 42) {
  const t = normalizeSnippetPart(text);
  if (t.length <= maxLen) return t;
  const head = Math.max(8, Math.floor((maxLen - 1) * 0.62));
  const tail = Math.max(6, maxLen - 1 - head);
  return t.slice(0, head).trimEnd() + "…" + t.slice(t.length - tail).trimStart();
}

function pushUniquePart(parts, text, opts = {}) {
  const t = opts.noEllipsis
    ? normalizeSnippetPart(text)
    : ellipsizeMiddle(text, opts.maxLen || 42);
  if (!t) return;
  const key = t.toLowerCase();
  if (parts.some((p) => p.text.toLowerCase() === key)) return;
  parts.push({ text: t, hit: null, role: opts.role || "context" });
}

function pushMatchedPart(parts, text, hit, opts = {}) {
  const full = normalizeSnippetPart(text);
  if (!full || !hit) return null;

  // Keep the matched cell near the beginning of the visible snippet. If the cell
  // is long, crop around the exact hit, but keep hit.index aligned to the cropped
  // text so the result list highlights the same occurrence the user selected.
  const maxLen = opts.maxLen || 96;
  let display = full;
  let adjustedHit = { ...hit };
  if (full.length > maxLen) {
    const before = isMostlyCJK(full) ? 18 : 28;
    let s = Math.max(0, hit.index - before);
    let e = Math.min(full.length, hit.index + hit.length + (maxLen - before));

    // Prefer not to start in the middle of an English word.
    if (!isMostlyCJK(full)) s = wordStartBefore(full, s);
    display = (s > 0 ? "…" : "") + full.slice(s, e) + (e < full.length ? "…" : "");
    adjustedHit = {
      index: hit.index - s + (s > 0 ? 1 : 0),
      length: hit.length,
    };
  }

  const key = display.toLowerCase();
  const duplicateIdx = parts.findIndex((p) => p.text.toLowerCase() === key);
  const part = { text: display, hit: adjustedHit, role: opts.role || "match" };
  if (duplicateIdx >= 0) parts[duplicateIdx] = part;
  else parts.push(part);
  return part;
}

function buildTableSnippetData(m, lines, matcher) {
  const loc = locateInTables(lines, m.line);
  if (!loc || (loc.kind !== "body" && loc.kind !== "header")) return null;

  const block = tableBlockForLine(lines, m.line);
  if (!block) return null;

  const rowCells = tableDataCells(lines[m.line] || "");
  const headerCells = tableDataCells(lines[block.headerLine] || "");
  const info = cellInfoForMatch(lines[m.line] || "", m.ch, matcher);
  if (!info || info.col < 0) return null;

  const cell = rowCells[info.col];
  if (!cell) return null;

  const displayCell = normalizeSnippetPart(cell.text);
  if (!displayCell) return null;

  // Estimate the occurrence index inside the visible cell. This is usually more
  // stable than using the raw Markdown cell because links/emphasis may disappear.
  const sourceOffsetInCell = Math.max(0, m.ch - cell.start);
  const visibleBefore = normalizeSnippetPart(cell.text.slice(0, sourceOffsetInCell));
  const visibleK = findAll(visibleBefore, matcher).length;
  const cellMatches = findAll(displayCell, matcher);
  const pick = cellMatches[visibleK] || cellMatches[info.kInCell] || cellMatches[0];
  if (!pick) return null;

  const parts = [];
  const header = headerCells[info.col] ? headerCells[info.col].text : "";
  const rowLabel = rowCells[0] && info.col !== 0 ? rowCells[0].text : "";

  // Cell-level table snippets: put the column + matched cell first so the exact
  // hit is always visible in the one-line result list. The row label is still
  // included as trailing context, but shortened so it cannot hide the hit.
  // Example: 控制 · 自主 (Voluntary) · ① 口腔期 (Voluntary / Buccal…)
  pushUniquePart(parts, header, { maxLen: 24, role: "header" });
  pushMatchedPart(parts, displayCell, pick, { maxLen: 88, role: "match" });
  pushUniquePart(parts, rowLabel, { maxLen: 36, role: "row" });

  const sep = " · ";
  let source = "";
  let hitIdx = -1;
  let hitLen = pick.length;
  for (const part of parts) {
    if (source) source += sep;
    const start = source.length;
    source += part.text;
    if (part.hit && hitIdx < 0) {
      hitIdx = start + part.hit.index;
      hitLen = part.hit.length;
    }
  }

  if (hitIdx < 0) return null;
  // The hit is now near the beginning by construction, so keeping the short
  // table snippet is safe and avoids jumping back to the long row label.
  return { source, hitIdx, hitLen, keepShort: true };
}

function buildLineSnippetData(m, matcher, domMode) {
  const source = domMode ? cleanSnippet(m.lineText) : m.lineText;
  if (!source) return null;

  let hitIdx;
  let hitLen;
  if (domMode) {
    // Count matches before this one within the same source line, skipping hidden
    // Markdown spans, then select the same occurrence in the visible text.
    const spans = hiddenSpansInReading(m.lineText);
    let kInLine = 0;
    for (const mt of findAll(m.lineText.slice(0, m.ch), matcher)) {
      if (!isInsideSpan(mt.index, spans)) kInLine++;
    }
    const all = findAll(source, matcher);
    const pick = all[kInLine] || all[0];
    if (!pick) return { source, hitIdx: -1, hitLen: 0, keepShort: false };
    hitIdx = pick.index;
    hitLen = pick.length;
  } else {
    hitIdx = m.ch;
    hitLen = m.len;
  }

  return { source, hitIdx, hitLen, keepShort: false };
}

function buildSnippetData(m, lines, matcher, domMode) {
  return (
    buildTableSnippetData(m, lines, matcher) ||
    buildLineSnippetData(m, matcher, domMode)
  );
}

/**
 * Reading mode: map a source match to its exact rendered range by content.
 * Find the rendered element (table row / heading / paragraph / list item) whose
 * full text equals the source line, then take the k-th query occurrence in it
 * (k = occurrences before the match within the same source line). Robust to
 * virtualization and duplicate cells (ordering is within one line).
 */
function resolveReadingCurrentRange(root, lines, m, matcher, scroller) {
  try {
    if (!root) return null;
    const line = lines[m.line] || "";
    // Count only matches that are visible in Reading mode, so the k-th match in
    // the source line aligns with the k-th visible match in the DOM.
    const spans = hiddenSpansInReading(line);
    let kInLine = 0;
    for (const mt of findAll(line.slice(0, m.ch), matcher)) {
      if (!isInsideSpan(mt.index, spans)) kInLine++;
    }
    const want = cleanSnippet(line).replace(/\s+/g, "").toLowerCase();
    if (!want) return null;
    const els = root.querySelectorAll(
      "tr, p, li, h1, h2, h3, h4, h5, h6, dd, dt, td, th, blockquote"
    );

    const candidates = [];
    for (const el of els) {
      const got = (el.textContent || "").replace(/\s+/g, "").toLowerCase();
      if (got === want) {
        const range = findKthOccurrenceRange(el, matcher, kInLine);
        if (range) candidates.push({ el, range });
      }
    }
    if (!candidates.length) return null;

    // If the same row/paragraph text appears multiple times, choose the rendered
    // occurrence nearest the current scroll target instead of blindly taking the
    // first duplicate in the DOM.
    const rect = scroller ? scroller.getBoundingClientRect() : { top: 0 };
    const targetY = rect.top + 80;
    let best = candidates[0];
    let bestDist = Infinity;
    for (const c of candidates) {
      const r = c.el.getBoundingClientRect();
      const dist = Math.abs(r.top - targetY);
      if (dist < bestDist) {
        bestDist = dist;
        best = c;
      }
    }
    return best.range;
  } catch (e) {
    debugWarn("resolveReadingCurrentRange", e);
    return null;
  }
}

/* ----------------------------- find bar ----------------------------- */

class FindBar {
  constructor(plugin, view) {
    this.plugin = plugin;
    this.view = view;
    this.editor = view.editor;
    this.matches = [];
    this.current = -1;
    this.query = "";
    this.matcher = null;
    this.caseSensitive = false;
    this.useRegex = false;
    this.wholeWord = false;
    this.domMode = false; // reading mode: jump via applyScroll, highlight on DOM
    this.currentDomRange = null; // anchored current range in reading mode
    this.barEl = null;
    this.resultsEl = null;
  }

  isOpen() {
    return !!this.barEl;
  }

  updateScroller() {
    if (this.scroller && this.onScroll) {
      this.scroller.removeEventListener("scroll", this.onScroll);
    }

    this.scroller = getScroller(this.view);

    if (this.scroller && this.onScroll) {
      this.scroller.addEventListener("scroll", this.onScroll, { passive: true });
    }
  }

  refreshCurrentSearch() {
    if (!this.barEl) return;
    if (this.query) this.search(this.query);
    else this.clearHighlights();
  }

  open() {
    if (this.barEl) {
      this.input.focus();
      this.input.select();
      return;
    }
    const host = this.view.containerEl;

    const bar = host.createDiv({ cls: "lf-find-bar" });
    this.barEl = bar;
    this.input = bar.createEl("input", {
      cls: "lf-input",
      type: "text",
      placeholder: "Find in note…",
    });

    this.caseBtn = bar.createEl("button", { cls: "lf-btn lf-toggle", text: "Aa" });
    this.caseBtn.title = "Match case";
    this.regexBtn = bar.createEl("button", { cls: "lf-btn lf-toggle", text: ".*" });
    this.regexBtn.title = "Use regular expression";
    this.wordBtn = bar.createEl("button", { cls: "lf-btn lf-toggle", text: "W" });
    this.wordBtn.title = "Match whole word";

    this.countEl = bar.createSpan({ cls: "lf-count", text: "" });
    this.sepEl = bar.createDiv({ cls: "lf-sep" });
    const prev = bar.createEl("button", { cls: "lf-btn" });
    const next = bar.createEl("button", { cls: "lf-btn" });
    const close = bar.createEl("button", { cls: "lf-btn" });
    setIcon(prev, "chevron-up");
    setIcon(next, "chevron-down");
    setIcon(close, "x");
    prev.title = "Previous (Shift+Enter / ↑)";
    next.title = "Next (Enter / ↓)";
    close.title = "Close (Esc)";

    prev.onclick = () => this.step(-1);
    next.onclick = () => this.step(1);
    close.onclick = () => this.close();
    this.caseBtn.onclick = () => {
      this.caseSensitive = !this.caseSensitive;
      this.caseBtn.toggleClass("is-on", this.caseSensitive);
      this.search(this.input.value);
      this.input.focus();
    };
    this.regexBtn.onclick = () => {
      this.useRegex = !this.useRegex;
      this.regexBtn.toggleClass("is-on", this.useRegex);
      this.search(this.input.value);
      this.input.focus();
    };
    this.wordBtn.onclick = () => {
      this.wholeWord = !this.wholeWord;
      this.wordBtn.toggleClass("is-on", this.wholeWord);
      this.search(this.input.value);
      this.input.focus();
    };

    this.resultsEl = host.createDiv({ cls: "lf-results" });
    this.resultsEl.style.display = "none";
    this.updateCount(); // collapse the empty count/separator on open

    this.onInput = debounce(
      () => this.search(this.input.value),
      DEBOUNCE_MS
    );
    this.input.addEventListener("input", this.onInput);
    this.onKeydown = (e) => {
      // Don't hijack keys while an IME is composing (e.g. Chinese pinyin Enter
      // commits the candidate — we'd otherwise step the search).
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Enter") {
        e.preventDefault();
        this.step(e.shiftKey ? -1 : 1);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        this.step(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        this.step(-1);
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      }
    };
    this.input.addEventListener("keydown", this.onKeydown);

    this.onScroll = debounce(
      () => this.refreshHighlights(),
      DEBOUNCE_MS
    );
    this.updateScroller();

    // Re-run search when the user toggles Source / Live Preview / Reading
    // inside the same tab, so domMode, highlights and snippets stay accurate.
    this.lastViewMode = this.view.getMode();
    this.layoutEvt = this.plugin.app.workspace.on("layout-change", () => {
      if (!this.barEl) return;
      const mode = this.view.getMode();
      if (mode === this.lastViewMode) return;
      this.lastViewMode = mode;
      this.updateScroller();
      this.refreshCurrentSearch();
    });

    // Keep results in sync if the note is edited while the find bar is open.
    this.onEditorChange = debounce(() => {
      if (!this.barEl) return;
      const active = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
      if (active !== this.view) return;
      this.refreshCurrentSearch();
    }, DEBOUNCE_MS);
    this.editorChangeEvt = this.plugin.app.workspace.on(
      "editor-change",
      this.onEditorChange
    );

    // Prefill from the current selection, like a browser / editor find.
    let initial = "";
    try {
      const sel = this.editor.getSelection();
      if (sel && !sel.includes("\n")) initial = sel;
    } catch (e) {
      debugWarn("read initial selection", e);
    }
    if (initial) {
      this.input.value = initial;
      this.search(initial);
    }
    setTimeout(() => {
      if (!this.input) return;
      this.input.focus();
      this.input.select();
    }, 0);
  }

  close() {
    if (this.onInput && this.onInput.cancel) this.onInput.cancel();
    if (this.onScroll && this.onScroll.cancel) this.onScroll.cancel();
    if (this.onEditorChange && this.onEditorChange.cancel)
      this.onEditorChange.cancel();

    if (this.input && this.onInput) {
      this.input.removeEventListener("input", this.onInput);
    }
    if (this.input && this.onKeydown) {
      this.input.removeEventListener("keydown", this.onKeydown);
    }

    if (this.scroller && this.onScroll) {
      this.scroller.removeEventListener("scroll", this.onScroll);
    }
    this.scroller = null;

    if (this.layoutEvt) this.plugin.app.workspace.offref(this.layoutEvt);
    if (this.editorChangeEvt) this.plugin.app.workspace.offref(this.editorChangeEvt);
    this.layoutEvt = null;
    this.editorChangeEvt = null;

    this.clearHighlights();
    if (this.barEl) this.barEl.remove();
    if (this.resultsEl) this.resultsEl.remove();
    this.barEl = null;
    this.resultsEl = null;
    this.input = null;
    this.onKeydown = null;
    this.onEditorChange = null;
    this.matches = [];
    this.current = -1;
    this.query = ""; // ensure late timers can't repaint highlights
    this.matcher = null;
  }

  clearHighlights() {
    if (window.CSS && CSS.highlights) {
      CSS.highlights.delete(HL_ALL);
      CSS.highlights.delete(HL_CURRENT);
    }
  }

  domApply(dom, currentRange) {
    CSS.highlights.set(HL_ALL, new Highlight(...dom.map((d) => d.range)));
    if (currentRange) {
      const hl = new Highlight(currentRange);
      hl.priority = 1;
      CSS.highlights.set(HL_CURRENT, hl);
    } else {
      CSS.highlights.delete(HL_CURRENT);
    }
  }

  refreshHighlights() {
    if (!this.barEl) return; // bail if a late timer fires after close()
    if (!(window.CSS && CSS.highlights && window.Highlight)) return;
    if (!this.query || !this.matcher || this.matcher.invalid)
      return this.clearHighlights();

    // Reading mode: list/count/nav come from the source (complete). The current
    // match is mapped to the rendered DOM by content (exact, even with duplicate
    // cells). Yellow highlights are limited around the current match, not just
    // the first N matches in the document.
    if (this.domMode) {
      const root = getRenderRoot(this.view);
      const m = this.matches[this.current];
      const scroller = getScroller(this.view);
      let cur = m
        ? resolveReadingCurrentRange(root, this.docLines, m, this.matcher, scroller)
        : null;
      if (
        !cur &&
        this.currentDomRange &&
        this.currentDomRange.startContainer &&
        this.currentDomRange.startContainer.isConnected
      )
        cur = this.currentDomRange;

      let dom = findRenderedMatches(root, this.matcher);

      if (!cur && dom.length) {
        const rect = scroller ? scroller.getBoundingClientRect() : { top: 0 };
        const targetY = rect.top + 80;
        let best = null;
        let bd = Infinity;
        for (const d of dom) {
          const r = d.range.getBoundingClientRect();
          const dist = Math.abs(r.top - targetY);
          if (dist < bd) {
            bd = dist;
            best = d;
          }
        }
        cur = best ? best.range : null;
      }

      this.currentDomRange = cur;
      dom = limitDomHighlightsAroundCurrent(
        dom,
        cur,
        MAX_DOM_HIGHLIGHTS,
        scroller
      );
      this.domApply(dom, cur);
      return;
    }

    const root = getRenderRoot(this.view);
    const scroller = getScroller(this.view);
    let dom = null;
    let currentRange = null;
    const m = this.matches[this.current];
    const lines = this.docLines || [];
    if (m) {
      const line = lines[m.line] || "";
      const isTable = !!locateInTables(lines, m.line) && !isDelimiterRow(line);
      const cm = getEditorView(this.editor);
      let off = null;
      try {
        off = this.editor.posToOffset({ line: m.line, ch: m.ch });
      } catch (e) {
        debugWarn("posToOffset", e);
      }

      if (off != null && cm) {
        if (isTable)
          currentRange = resolveTableByPoint(cm, off, lines, m, this.matcher);
        if (!currentRange) currentRange = resolveByDomAtPos(cm, off, this.matcher);
        if (!currentRange) {
          dom = findRenderedMatches(root, this.matcher);
          let coords = null;
          try {
            if (typeof cm.coordsAtPos === "function") coords = cm.coordsAtPos(off);
          } catch (e) {
            debugWarn("coordsAtPos fallback", e);
          }
          if (coords && dom.length) {
            const cy = (coords.top + coords.bottom) / 2;
            const cx = coords.left;
            let best = null;
            let bestDist = Infinity;
            for (const d of dom) {
              const r = d.range.getBoundingClientRect();
              const dist =
                Math.abs((r.top + r.bottom) / 2 - cy) * 4 + Math.abs(r.left - cx);
              if (dist < bestDist) {
                bestDist = dist;
                best = d;
              }
            }
            currentRange = best ? best.range : null;
          }
        }
      }
    }

    if (!dom) dom = findRenderedMatches(root, this.matcher);
    dom = limitDomHighlightsAroundCurrent(
      dom,
      currentRange,
      MAX_DOM_HIGHLIGHTS,
      scroller
    );
    this.domApply(dom, currentRange);
  }

  search(query) {
    if (!this.barEl || !this.resultsEl) return;

    this.query = query;
    this.matcher = buildMatcher(query, this.caseSensitive, this.useRegex, this.wholeWord);
    this.domMode = this.view.getMode() === "preview";
    // Both modes: complete whole-note search from the source.
    const text = this.editor.getValue();
    this.docLines = text.split("\n");
    this.matches = findSourceMatches(this.docLines, this.matcher);
    // Reading mode: drop source matches that are not visible in the rendered
    // preview, such as image syntax, link URLs, wikilink targets and table
    // delimiter rows. This avoids empty-looking results.
    if (this.domMode && this.matches.length) {
      const cache = new Map();
      this.matches = this.matches.filter((m) => {
        const line = this.docLines[m.line] || "";
        if (isDelimiterRow(line)) return false;
        if (!cleanSnippet(line)) return false;

        let spans = cache.get(m.line);
        if (!spans) {
          spans = hiddenSpansInReading(line);
          cache.set(m.line, spans);
        }
        return !isInsideSpan(m.ch, spans);
      });
    }
    this.current = this.matches.length ? 0 : -1;
    this.currentDomRange = null;
    this.renderList();
    this.updateCount();
    if (this.current >= 0) this.jumpToCurrent();
    else this.clearHighlights();
  }

  step(dir) {
    if (!this.matches.length) return;
    this.current = (this.current + dir + this.matches.length) % this.matches.length;
    this.jumpToCurrent();
    this.updateCount();
    this.markActiveRow();
  }

  jumpToCurrent() {
    const m = this.matches[this.current];
    if (!m) return;
    if (this.domMode) {
      // Scroll the rendered preview to the match's source line, then let
      // refreshHighlights map the current match by content.
      try {
        const pm = this.view.previewMode || this.view.currentMode;
        if (pm && typeof pm.applyScroll === "function") pm.applyScroll(m.line);
      } catch (e) {
        debugWarn("applyScroll", e);
      }
      this.currentDomRange = null; // recompute fresh for the new selection
      this.refreshHighlights();
      setTimeout(() => this.refreshHighlights(), 90);
      setTimeout(() => this.refreshHighlights(), 220);
      return;
    }
    const from = { line: m.line, ch: m.ch };
    const to = { line: m.line, ch: m.ch + m.len };
    try {
      this.editor.scrollIntoView({ from, to }, true);
    } catch (e) {
      debugWarn("scrollIntoView", e);
    }
    this.refreshHighlights();
    setTimeout(() => this.refreshHighlights(), 60);
  }

  updateCount() {
    if (!this.countEl || !this.sepEl) return;
    if (!this.query) {
      this.countEl.setText("");
      this.countEl.removeClass("is-empty");
      this.countEl.style.display = "none";
      this.sepEl.style.display = "none";
      return;
    }
    this.countEl.style.display = "";
    this.sepEl.style.display = "";
    if (this.matcher && this.matcher.invalid) {
      this.countEl.setText("Invalid regex");
      this.countEl.title = this.matcher.error || "Invalid regular expression";
      this.countEl.addClass("is-empty");
      return;
    }
    if (!this.matches.length) {
      this.countEl.setText("0/0");
      this.countEl.addClass("is-empty");
      return;
    }
    this.countEl.title = "";
    this.countEl.removeClass("is-empty");
    this.countEl.setText(`${this.current + 1}/${this.matches.length}`);
  }

  renderList() {
    const el = this.resultsEl;
    if (!el) return;
    el.empty();
    if (!this.query || !this.matches.length) {
      el.style.display = "none";
      return;
    }
    el.style.display = "block";
    this.matches.forEach((m, i) => {
      const row = el.createDiv({ cls: "lf-row" });
      if (i === this.current) row.addClass("is-active");

      // Second line: nearest heading above this match (always on).
      const head = nearestHeading(this.docLines, m.line);
      if (head) row.addClass("has-head");

      const main = row.createDiv({ cls: "lf-main" });
      main.createSpan({ cls: "lf-line", text: `Line ${m.line + 1}` });
      const sn = main.createSpan({ cls: "lf-snippet" });

      const snippet = buildSnippetData(
        m,
        this.docLines || [],
        this.matcher,
        this.domMode
      );
      if (snippet) {
        appendHighlightedSnippet(
          sn,
          snippet.source,
          snippet.hitIdx,
          snippet.hitLen,
          snippet.keepShort
        );
      }

      if (head) {
        const clean = head.text.replace(/[*_`]/g, "").trim();
        row.createDiv({ cls: "lf-head" }).setText(clean);
      }

      row.onclick = () => {
        this.current = i;
        this.jumpToCurrent();
        this.updateCount();
        this.markActiveRow();
        if (this.input) this.input.focus(); // keep keyboard nav alive
      };
    });
  }

  markActiveRow() {
    if (!this.resultsEl) return;
    const rows = this.resultsEl.children;
    for (let i = 0; i < rows.length; i++) {
      rows[i].toggleClass("is-active", i === this.current);
      if (i === this.current) rows[i].scrollIntoView({ block: "nearest" });
    }
  }
}

/* ----------------------------- plugin ----------------------------- */

module.exports = class LiveFindPlugin extends Plugin {
  async onload() {
    this.styleEl = document.createElement("style");
    this.styleEl.textContent = `
      ::highlight(${HL_ALL}) {
        background-color: rgba(255, 213, 0, 0.45);
        color: inherit;
      }
      ::highlight(${HL_CURRENT}) {
        background-color: #ff6d00;
        color: #ffffff;
      }
      .lf-find-bar {
        position: absolute; top: 10px; right: 18px;
        z-index: var(--layer-popover, 30);
        display: flex; align-items: center; gap: 2px;
        max-width: calc(100% - 36px);
        background: var(--background-primary);
        border: 1px solid var(--background-modifier-border);
        border-radius: 10px; padding: 5px 8px;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18);
      }
      .lf-find-bar .lf-input {
        border: none !important; background: transparent !important;
        box-shadow: none !important; color: var(--text-normal);
        outline: none; width: 200px; min-width: 72px; flex: 1 1 160px;
        font-size: 14px; padding: 2px 4px; margin: 0;
      }
      .lf-find-bar .lf-count {
        font-size: 12px; color: var(--text-muted);
        min-width: 46px; text-align: right; padding: 0 4px;
        font-variant-numeric: tabular-nums; white-space: nowrap;
      }
      .lf-find-bar .lf-count.is-empty { color: var(--text-error); }
      .lf-find-bar .lf-sep {
        width: 1px; height: 18px; margin: 0 4px;
        background: var(--background-modifier-border);
      }
      .lf-find-bar .lf-btn {
        display: flex; align-items: center; justify-content: center;
        width: 26px; height: 26px; padding: 0;
        flex: 0 0 26px;
        background: transparent !important; border: none !important;
        box-shadow: none !important; cursor: pointer;
        border-radius: 6px; color: var(--text-muted);
      }
      .lf-find-bar .lf-btn:hover {
        background: var(--background-modifier-hover) !important;
        color: var(--text-normal);
      }
      .lf-find-bar .lf-btn svg { width: 16px; height: 16px; }
      .lf-find-bar .lf-toggle {
        width: auto; min-width: 26px; padding: 0 6px;
        font-size: 11px; font-weight: 600;
      }
      .lf-find-bar .lf-toggle.is-on {
        background: var(--interactive-accent) !important;
        color: var(--text-on-accent) !important;
      }
      .lf-results {
        position: absolute; top: 50px; right: 18px;
        z-index: var(--layer-popover, 30);
        width: 340px; max-height: 320px; overflow-y: auto;
        background: var(--background-primary);
        border: 1px solid var(--background-modifier-border);
        border-radius: 10px;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18); padding: 4px;
      }
      .lf-results .lf-row {
        display: flex; flex-direction: column; gap: 2px;
        padding: 5px 8px; cursor: pointer; border-radius: 6px; font-size: 13px;
      }
      .lf-results .lf-main {
        display: flex; align-items: baseline; gap: 6px;
        white-space: nowrap; overflow: hidden;
      }
      .lf-results .lf-snippet { overflow: hidden; text-overflow: ellipsis; }
      .lf-results .lf-snippet strong { color: var(--text-accent); }
      .lf-results .lf-col {
        color: var(--text-muted); margin-right: 2px;
      }
      .lf-results .lf-row:hover { background: var(--background-modifier-hover); }
      .lf-results .lf-row.is-active {
        background: var(--background-modifier-active-hover, var(--background-modifier-hover));
      }
      .lf-results .lf-line {
        color: var(--text-faint); flex: 0 0 auto;
        font-variant-numeric: tabular-nums;
      }
      .lf-results .lf-head {
        color: var(--text-faint); font-size: 11px;
        padding-left: 38px; overflow: hidden;
        text-overflow: ellipsis; white-space: nowrap;
      }
    `;
    document.head.appendChild(this.styleEl);

    this.bar = null;

    this.addCommand({
      id: "find-in-note-rendered",
      name: "Find in note (top bar)",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "F" }],
      callback: () => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return new Notice("Open a Markdown note first.");
        if (!(window.CSS && CSS.highlights && window.Highlight))
          return new Notice("This Obsidian version lacks the CSS Highlight API.");
        if (this.bar && this.bar.view !== view) this.bar.close();
        if (!this.bar || !this.bar.isOpen()) this.bar = new FindBar(this, view);
        this.bar.open();
      },
    });

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        if (this.bar) this.bar.close();
      })
    );
  }

  onunload() {
    if (this.bar) this.bar.close();
    if (window.CSS && CSS.highlights) {
      CSS.highlights.delete(HL_ALL);
      CSS.highlights.delete(HL_CURRENT);
    }
    if (this.styleEl) this.styleEl.remove();
  }
};
