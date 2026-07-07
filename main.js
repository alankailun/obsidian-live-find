var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.js
var main_exports = {};
__export(main_exports, {
  default: () => LiveFindPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian2 = require("obsidian");

// src/constants.js
var HL_ALL = "live-find-all";
var HL_CURRENT = "live-find-current";
var DEBUG = false;
var DEBOUNCE_MS = 100;
var MAX_DOM_HIGHLIGHTS = 2500;
var RESULT_RENDER_BATCH = 150;
var RESULT_RENDER_AHEAD_PX = 900;
var RESULT_IDLE_PREFETCH_BATCH = 75;
var RESULT_DISPLAY_CAP = 5e3;
var DEFAULT_RESULT_ROW_HEIGHT = 42;
var SELECTORS = {
  readingRoot: ".markdown-reading-view, .markdown-preview-view",
  editorRoot: ".cm-content",
  scroller: ".cm-scroller, .markdown-preview-view"
};
var DEFAULT_FIND_OPTIONS = {
  caseSensitive: false,
  useRegex: false,
  wholeWord: false,
  groupResults: false,
  headingGroupLevel: 2,
  showResultHeadings: true,
  jumpNearest: true
};
function normalizeHeadingGroupLevel(value) {
  const n = Number(value);
  if (Number.isInteger(n) && n >= 1 && n <= 6) return n;
  return DEFAULT_FIND_OPTIONS.headingGroupLevel;
}
function headingLevelLabel(level) {
  return `H${normalizeHeadingGroupLevel(level)}`;
}
function headingLevelMenuLabel(level) {
  return `Heading ${normalizeHeadingGroupLevel(level)}`;
}
function normalizeFindOptions(options) {
  const src = options && typeof options === "object" ? options : {};
  const savedRemovedTopLevel = src.headingGroupLevel === "top";
  return {
    caseSensitive: typeof src.caseSensitive === "boolean" ? src.caseSensitive : DEFAULT_FIND_OPTIONS.caseSensitive,
    useRegex: typeof src.useRegex === "boolean" ? src.useRegex : DEFAULT_FIND_OPTIONS.useRegex,
    wholeWord: typeof src.wholeWord === "boolean" ? src.wholeWord : DEFAULT_FIND_OPTIONS.wholeWord,
    groupResults: typeof src.groupResults === "boolean" ? src.groupResults && !savedRemovedTopLevel : DEFAULT_FIND_OPTIONS.groupResults,
    headingGroupLevel: normalizeHeadingGroupLevel(src.headingGroupLevel),
    showResultHeadings: typeof src.showResultHeadings === "boolean" ? src.showResultHeadings : DEFAULT_FIND_OPTIONS.showResultHeadings,
    jumpNearest: typeof src.jumpNearest === "boolean" ? src.jumpNearest : DEFAULT_FIND_OPTIONS.jumpNearest
  };
}
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
function throttleFrame(fn) {
  let queued = false;
  return (...args) => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn(...args);
    });
  };
}

// src/find-bar.js
var import_obsidian = require("obsidian");

// src/matcher.js
var TOKEN_CHAR_RE = (() => {
  try {
    return new RegExp("[\\p{L}\\p{M}\\p{N}_]", "u");
  } catch (e) {
    return /[A-Za-z0-9_]/;
  }
})();
var BOUNDARYLESS_SCRIPT_RE = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
function normalizePlainQuery(query) {
  return (query || "").trim();
}
function buildMatcher(query, caseSensitive, useRegex, wholeWord) {
  if (!query) return null;
  if (useRegex) {
    const useWordBoundaries2 = !!wholeWord && queryUsesWordBoundaries(query);
    try {
      return {
        regex: new RegExp(query, "g" + (caseSensitive ? "" : "i")),
        wholeWord: !!wholeWord,
        useWordBoundaries: useWordBoundaries2
      };
    } catch (e) {
      return { invalid: true, error: e && e.message ? e.message : "Invalid regular expression" };
    }
  }
  const plainQuery = normalizePlainQuery(query);
  if (!plainQuery) return null;
  const useWordBoundaries = !!wholeWord && queryUsesWordBoundaries(plainQuery);
  return {
    needle: caseSensitive ? plainQuery : plainQuery.toLowerCase(),
    caseSensitive,
    wholeWord: !!wholeWord,
    useWordBoundaries
  };
}
function isBoundarylessScriptChar(ch) {
  return !!ch && BOUNDARYLESS_SCRIPT_RE.test(ch);
}
function isSearchTokenChar(ch) {
  return !!ch && TOKEN_CHAR_RE.test(ch) && !isBoundarylessScriptChar(ch);
}
function edgeCharBefore(text, index) {
  if (index <= 0) return "";
  const chars = [...text.slice(Math.max(0, index - 2), index)];
  return chars[chars.length - 1] || "";
}
function edgeCharAfter(text, index) {
  if (index >= text.length) return "";
  return [...text.slice(index, index + 2)][0] || "";
}
function queryUsesWordBoundaries(query) {
  let hasTokenChar = false;
  for (const ch of query) {
    if (isBoundarylessScriptChar(ch)) return false;
    if (isSearchTokenChar(ch)) hasTokenChar = true;
  }
  return hasTokenChar;
}
function isWholeWordMatch(text, index, length, matcher) {
  if (!matcher.useWordBoundaries) return true;
  return !isSearchTokenChar(edgeCharBefore(text, index)) && !isSearchTokenChar(edgeCharAfter(text, index + length));
}
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
      if (!matcher.wholeWord || isWholeWordMatch(text, m.index, m[0].length, matcher))
        out.push({ index: m.index, length: m[0].length });
    }
  } else {
    const hay = matcher.caseSensitive ? text : text.toLowerCase();
    const n = matcher.needle;
    let from = 0;
    while (true) {
      const i = hay.indexOf(n, from);
      if (i === -1) break;
      if (!matcher.wholeWord || isWholeWordMatch(text, i, n.length, matcher))
        out.push({ index: i, length: n.length });
      from = i + n.length;
    }
  }
  return out;
}
function findPlainMatchesInHaystack(text, hay, matcher) {
  const out = [];
  const n = matcher.needle;
  let from = 0;
  while (true) {
    const i = hay.indexOf(n, from);
    if (i === -1) break;
    if (!matcher.wholeWord || isWholeWordMatch(text, i, n.length, matcher))
      out.push({ index: i, length: n.length });
    from = i + n.length;
  }
  return out;
}
function findSourceMatches(lines, matcher, lowerLines = null) {
  const res = [];
  if (!matcher || matcher.invalid) return res;
  const useLowerCache = !!lowerLines && !matcher.regex && !matcher.caseSensitive;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const found = useLowerCache ? findPlainMatchesInHaystack(line, lowerLines[i] || "", matcher) : findAll(line, matcher);
    for (const mt of found) {
      res.push({ line: i, ch: mt.index, len: mt.length, lineText: line });
    }
  }
  return res;
}

// src/tables.js
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
function buildTableLookup(lines) {
  const ranges = [];
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
    let delimLine = -1;
    for (let k = blockStart; k < j; k++) {
      if (isDelimiterRow(lines[k])) {
        delimLine = k;
        break;
      }
    }
    if (delimLine !== -1) {
      tableIdx++;
      ranges.push({
        tableIdx,
        blockStart,
        blockEnd: j,
        startLine: blockStart,
        endLine: j - 1,
        headerLine: blockStart,
        delimLine
      });
    }
    i = j;
  }
  return ranges;
}
function findTableForLine(ranges, lineIdx) {
  if (!ranges || !ranges.length || !Number.isFinite(lineIdx)) return null;
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = lo + hi >> 1;
    const block = ranges[mid];
    if (lineIdx < block.startLine) {
      hi = mid - 1;
    } else if (lineIdx > block.endLine) {
      lo = mid + 1;
    } else {
      return block;
    }
  }
  return null;
}
function locateInTables(lines, lineIdx, lookup) {
  if (lookup) {
    const block = findTableForLine(lookup, lineIdx);
    if (!block) return null;
    if (lineIdx === block.blockStart)
      return { tableIdx: block.tableIdx, kind: "header" };
    if (lineIdx === block.delimLine)
      return { tableIdx: block.tableIdx, kind: "delim" };
    return {
      tableIdx: block.tableIdx,
      kind: "body",
      bodyRowIdx: lineIdx - block.delimLine - 1
    };
  }
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
    const isEdgeEmpty = (c === 0 || c === cells.length - 1) && cell.text.trim() === "";
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
function tableDataCells(line) {
  const raw = parseCells(line);
  const out = [];
  let dataCol = -1;
  for (let i = 0; i < raw.length; i++) {
    const cell = raw[i];
    const isEdgeEmpty = (i === 0 || i === raw.length - 1) && cell.text.trim() === "";
    if (isEdgeEmpty) continue;
    dataCol++;
    out.push({ ...cell, dataCol });
  }
  return out;
}
function tableBlockForLine(lines, lineIdx, lookup) {
  if (lookup) {
    const block = findTableForLine(lookup, lineIdx);
    if (!block) return null;
    return {
      blockStart: block.blockStart,
      blockEnd: block.blockEnd,
      headerLine: block.headerLine,
      delimLine: block.delimLine
    };
  }
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

// src/markdown.js
function isWordSep(ch) {
  if (!ch) return true;
  if (/\s/.test(ch)) return true;
  if (ch === "|" || ch === "\u2502") return true;
  const code = ch.charCodeAt(0);
  if (code >= 12288 && code <= 12351) return true;
  if (code >= 65280 && code <= 65519) return true;
  if (code >= 19968 && code <= 40959) return true;
  return false;
}
function wordStartBefore(text, idx) {
  let i = idx;
  while (i > 0 && !isWordSep(text.charAt(i - 1))) i--;
  return i;
}
function extendPrefixWords(text, start, n) {
  let cursor = start;
  while (n > 0 && cursor > 0) {
    let p = cursor;
    while (p > 0 && isWordSep(text.charAt(p - 1)) && text.charAt(p - 1) !== "|") p--;
    if (p === cursor) break;
    if (p > 0 && text.charAt(p - 1) === "|") break;
    const end = p;
    while (p > 0 && !isWordSep(text.charAt(p - 1))) p--;
    if (p === end) break;
    cursor = p;
    n--;
  }
  return cursor;
}
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
function hiddenSpansInReading(line) {
  const spans = [...imageSpansIn(line)];
  let m;
  const mdLink = /(?<!!)\[([^\]\n]*)\]\(([^)\n]*)\)/g;
  while ((m = mdLink.exec(line)) !== null) {
    const textStart = m.index + 1;
    const textEnd = textStart + m[1].length;
    spans.push([m.index, textStart]);
    spans.push([textEnd, m.index + m[0].length]);
  }
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
function parseHeading(line, lineIdx) {
  const m = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line || "");
  if (!m) return null;
  return { level: m[1].length, text: m[2], line: lineIdx };
}
function buildHeadingLookup(lines) {
  const byLevel = Array.from({ length: 7 }, () => []);
  for (let i = 0; i < lines.length; i++) {
    const heading = parseHeading(lines[i], i);
    if (!heading) continue;
    for (let level = heading.level; level <= 6; level++) {
      byLevel[level].push(heading);
    }
  }
  return byLevel;
}
function findHeadingForLine(headings, lineIdx) {
  if (!headings || !headings.length || !Number.isFinite(lineIdx)) return null;
  let lo = 0;
  let hi = headings.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = lo + hi >> 1;
    if (headings[mid].line <= lineIdx) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best >= 0 ? headings[best] : null;
}
function nearestHeading(lines, lineIdx, maxLevel = 6, lookup) {
  if (lookup && lookup[maxLevel])
    return findHeadingForLine(lookup[maxLevel], lineIdx);
  for (let i = lineIdx; i >= 0; i--) {
    const heading = parseHeading(lines[i], i);
    if (heading && heading.level <= maxLevel) return heading;
  }
  return null;
}
function cleanHeadingText(text) {
  return (text || "").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
}
function headingGroupForLine(lines, lineIdx, maxLevel, lookup) {
  const heading = nearestHeading(lines, lineIdx, maxLevel, lookup);
  if (heading) return { ...heading, text: cleanHeadingText(heading.text) };
  return { level: 0, line: -1, text: "No heading" };
}
function headingGroupKey(group) {
  return `${group.line}:${group.level}:${group.text}`;
}
function cleanSnippet(line) {
  return line.replace(/!\[\[[^\]\n]*\]\]/g, "").replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, "").replace(/(?<!!)\[([^\]\n]*)\]\([^)\n]*\)/g, "$1").replace(/(?<!!)\[\[([^|\]\n]*)(?:\|([^\]\n]*))?\]\]/g, (_, target, alias) => alias || target).replace(/^[\s>#*+\-]+/, "").replace(/[*_`]/g, "").replace(/\|/g, " ").replace(/[│├└─]+/g, "").replace(/\s+/g, " ").trim();
}
function visibleInlineText(text) {
  return (text || "").replace(/!\[\[[^\]\n]*\]\]/g, "").replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, "").replace(/(?<!!)\[([^\]\n]*)\]\([^)\n]*\)/g, "$1").replace(/(?<!!)\[\[([^|\]\n]*)(?:\|([^\]\n]*))?\]\]/g, (_, target, alias) => alias || target).replace(/<br\s*\/?\s*>/gi, " ").replace(/<[^>]+>/g, "").replace(/[*_`~]/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
}

// src/snippets.js
function isMostlyCJK(text) {
  const compact = (text || "").replace(/\s+/g, "");
  if (!compact) return false;
  const cjk = (compact.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  return cjk >= 2 && cjk / compact.length >= 0.25;
}
function snippetWindow(source, hitIdx, hitLen, keepShort = false) {
  if (keepShort && source.length <= 180) return { s: 0, e: source.length };
  if (isMostlyCJK(source)) {
    const s2 = Math.max(0, hitIdx - 14);
    const e2 = Math.min(source.length, hitIdx + hitLen + 34);
    return { s: s2, e: e2 };
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
    if (source.length > 120) container.appendText("\u2026");
    return;
  }
  const { s, e } = snippetWindow(source, hitIdx, hitLen, keepShort);
  const win = source.slice(s, e);
  const ls = hitIdx - s;
  const le = ls + hitLen;
  if (s > 0) container.appendText("\u2026");
  if (ls > 0) container.appendText(win.slice(0, ls));
  container.createEl("strong", { text: win.slice(ls, le) });
  if (le < win.length) container.appendText(win.slice(le));
  if (e < source.length) container.appendText("\u2026");
}
function cachedHiddenSpans(lineIdx, lineText, hiddenSpansByLine = null) {
  if (!hiddenSpansByLine || !Number.isFinite(lineIdx))
    return hiddenSpansInReading(lineText);
  if (!hiddenSpansByLine.has(lineIdx)) {
    hiddenSpansByLine.set(lineIdx, hiddenSpansInReading(lineText));
  }
  return hiddenSpansByLine.get(lineIdx) || [];
}
function normalizeSnippetPart(text) {
  return visibleInlineText(text).replace(/\s+/g, " ").trim();
}
function ellipsizeMiddle(text, maxLen = 42) {
  const t = normalizeSnippetPart(text);
  if (t.length <= maxLen) return t;
  const head = Math.max(8, Math.floor((maxLen - 1) * 0.62));
  const tail = Math.max(6, maxLen - 1 - head);
  return t.slice(0, head).trimEnd() + "\u2026" + t.slice(t.length - tail).trimStart();
}
function pushUniquePart(parts, text, opts = {}) {
  const t = opts.noEllipsis ? normalizeSnippetPart(text) : ellipsizeMiddle(text, opts.maxLen || 42);
  if (!t) return;
  const key = t.toLowerCase();
  if (parts.some((p) => p.text.toLowerCase() === key)) return;
  parts.push({ text: t, hit: null, role: opts.role || "context" });
}
function pushMatchedPart(parts, text, hit, opts = {}) {
  const full = normalizeSnippetPart(text);
  if (!full || !hit) return null;
  const maxLen = opts.maxLen || 96;
  let display = full;
  let adjustedHit = { ...hit };
  if (full.length > maxLen) {
    const before = isMostlyCJK(full) ? 18 : 28;
    let s = Math.max(0, hit.index - before);
    let e = Math.min(full.length, hit.index + hit.length + (maxLen - before));
    if (!isMostlyCJK(full)) s = wordStartBefore(full, s);
    display = (s > 0 ? "\u2026" : "") + full.slice(s, e) + (e < full.length ? "\u2026" : "");
    adjustedHit = {
      index: hit.index - s + (s > 0 ? 1 : 0),
      length: hit.length
    };
  }
  const key = display.toLowerCase();
  const duplicateIdx = parts.findIndex((p) => p.text.toLowerCase() === key);
  const part = { text: display, hit: adjustedHit, role: opts.role || "match" };
  if (duplicateIdx >= 0) parts[duplicateIdx] = part;
  else parts.push(part);
  return part;
}
function buildTableSnippetData(m, lines, matcher, tableLookup) {
  const loc = locateInTables(lines, m.line, tableLookup);
  if (!loc || loc.kind !== "body" && loc.kind !== "header") return null;
  const block = tableBlockForLine(lines, m.line, tableLookup);
  if (!block) return null;
  const rowCells = tableDataCells(lines[m.line] || "");
  const headerCells = tableDataCells(lines[block.headerLine] || "");
  const info = cellInfoForMatch(lines[m.line] || "", m.ch, matcher);
  if (!info || info.col < 0) return null;
  const cell = rowCells[info.col];
  if (!cell) return null;
  const displayCell = normalizeSnippetPart(cell.text);
  if (!displayCell) return null;
  const sourceOffsetInCell = Math.max(0, m.ch - cell.start);
  const visibleBefore = normalizeSnippetPart(cell.text.slice(0, sourceOffsetInCell));
  const visibleK = findAll(visibleBefore, matcher).length;
  const cellMatches = findAll(displayCell, matcher);
  const pick = cellMatches[visibleK] || cellMatches[info.kInCell] || cellMatches[0];
  if (!pick) return null;
  const parts = [];
  const header = headerCells[info.col] ? headerCells[info.col].text : "";
  const rowLabel = rowCells[0] && info.col !== 0 ? rowCells[0].text : "";
  pushUniquePart(parts, header, { maxLen: 24, role: "header" });
  pushMatchedPart(parts, displayCell, pick, { maxLen: 88, role: "match" });
  pushUniquePart(parts, rowLabel, { maxLen: 36, role: "row" });
  const sep = " \xB7 ";
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
  return { source, hitIdx, hitLen, keepShort: true };
}
function buildLineSnippetData(m, matcher, domMode, hiddenSpansByLine = null) {
  const source = domMode ? cleanSnippet(m.lineText) : m.lineText;
  if (!source) return null;
  let hitIdx;
  let hitLen;
  if (domMode) {
    const spans = cachedHiddenSpans(m.line, m.lineText, hiddenSpansByLine);
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
function buildSnippetData(m, lines, matcher, domMode, tableLookup, hiddenSpansByLine = null) {
  return buildTableSnippetData(m, lines, matcher, tableLookup) || buildLineSnippetData(m, matcher, domMode, hiddenSpansByLine);
}

// src/dom-resolve.js
function getRenderRoot(view) {
  if (!view || !view.containerEl || typeof view.getMode !== "function") return null;
  const mode = view.getMode();
  return view.containerEl.querySelector(
    mode === "preview" ? SELECTORS.readingRoot : SELECTORS.editorRoot
  );
}
function isLivePreviewMode(view) {
  if (!view || !view.containerEl || typeof view.getMode !== "function") return false;
  if (view.getMode() !== "source") return false;
  return !!view.containerEl.querySelector(".markdown-source-view.is-live-preview");
}
function getScroller(view) {
  if (!view || !view.containerEl) return null;
  return view.containerEl.querySelector(SELECTORS.scroller);
}
function getEditorView(editor) {
  return editor && editor.cm ? editor.cm : null;
}
function getElementDocument(el) {
  return el && el.ownerDocument || document;
}
function getElementWindow(el) {
  const doc = getElementDocument(el);
  return doc && doc.defaultView || window;
}
function getViewDocument(view) {
  return view && view.containerEl && view.containerEl.ownerDocument || document;
}
function getViewWindow(view) {
  const doc = getViewDocument(view);
  return doc && doc.defaultView || window;
}
function findRenderedMatches(root, matcher, options = {}) {
  const matches = [];
  if (!root || !matcher || matcher.invalid) return matches;
  const scroller = options.scroller;
  const margin = typeof options.viewportMargin === "number" ? options.viewportMargin : Infinity;
  let viewTop = -Infinity;
  let viewBottom = Infinity;
  if (scroller && margin !== Infinity) {
    const rect = scroller.getBoundingClientRect();
    viewTop = rect.top - margin;
    viewBottom = rect.bottom + margin;
  }
  const doc = getElementDocument(root);
  const win = getElementWindow(root);
  const filter = win.NodeFilter;
  const walker = doc.createTreeWalker(root, filter.SHOW_TEXT, {
    acceptNode(node2) {
      if (!node2.nodeValue || !node2.nodeValue.trim())
        return filter.FILTER_REJECT;
      const tag = node2.parentElement && node2.parentElement.tagName;
      if (tag === "SCRIPT" || tag === "STYLE") return filter.FILTER_REJECT;
      return filter.FILTER_ACCEPT;
    }
  });
  let node;
  while (node = walker.nextNode()) {
    if (scroller && margin !== Infinity) {
      const elRect = node.parentElement.getBoundingClientRect();
      if (elRect.bottom < viewTop || elRect.top > viewBottom) {
        continue;
      }
    }
    const text = node.nodeValue;
    for (const mt of findAll(text, matcher)) {
      const range = doc.createRange();
      range.setStart(node, mt.index);
      range.setEnd(node, mt.index + mt.length);
      matches.push({
        range,
        el: node.parentElement,
        text,
        index: mt.index,
        length: mt.length
      });
    }
  }
  return matches;
}
function scrollRangeIntoView(range) {
  try {
    if (!range || !range.startContainer) return false;
    const node = range.startContainer;
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!el || typeof el.scrollIntoView !== "function") return false;
    const target = el.closest && el.closest(
      ".cm-line, td, th, tr, p, li, h1, h2, h3, h4, h5, h6, dd, dt, blockquote"
    ) || el;
    target.scrollIntoView({ behavior: "auto", block: "center", inline: "nearest" });
    return true;
  } catch (e) {
    debugWarn("scrollRangeIntoView", e);
    return false;
  }
}
function centerEditorOffset(view, editor, off) {
  try {
    const pos = editor.offsetToPos(off);
    editor.setCursor(pos);
    const cm = getEditorView(editor);
    const scroller = getScroller(view) || cm && cm.scrollDOM;
    if (!cm || typeof cm.coordsAtPos !== "function" || !scroller || off == null) return false;
    requestAnimationFrame(() => {
      const coords = cm.coordsAtPos(off);
      if (coords) {
        const targetY = coords.top + scroller.scrollTop - scroller.getBoundingClientRect().top;
        scroller.scrollTop = targetY - scroller.clientHeight / 2;
      }
    });
    return true;
  } catch (e) {
    debugWarn("centerEditorOffset", e);
    return false;
  }
}
function findKthOccurrenceRange(el, matcher, k) {
  const doc = getElementDocument(el);
  const win = getElementWindow(el);
  const walker = doc.createTreeWalker(el, win.NodeFilter.SHOW_TEXT);
  let node;
  let count = 0;
  while (node = walker.nextNode()) {
    for (const mt of findAll(node.nodeValue, matcher)) {
      if (count === k) {
        const r = doc.createRange();
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
    if (!node || node.nodeType !== 3) return null;
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
    const r = getElementDocument(node).createRange();
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
  return node.nodeType === 1 ? node : node.parentElement;
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
    const doc = getElementDocument(cm.dom);
    const win = getElementWindow(cm.dom);
    const coords = cm.coordsAtPos(off);
    if (!coords) return null;
    const y = (coords.top + coords.bottom) / 2;
    const xs = [coords.left + 1, coords.left + 20, 120, win.innerWidth / 2];
    for (const x of xs) {
      const el = doc.elementFromPoint(x, y);
      const t = el && el.closest && el.closest("table");
      if (t) return t;
    }
    return null;
  } catch (e) {
    debugWarn("tableFromPoint", e);
    return null;
  }
}
function resolveTableByPoint(cm, off, lines, m, matcher, tableLookup = null) {
  try {
    const tableEl = tableFromDomAtPos(cm, off) || tableFromPoint(cm, off);
    if (!tableEl) return null;
    const info = cellInfoForMatch(lines[m.line], m.ch, matcher);
    if (!info || info.col < 0) return null;
    const loc = locateInTables(lines, m.line, tableLookup);
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
function cachedHiddenSpansForLine(lineIdx, line, hiddenSpansByLine = null) {
  if (!hiddenSpansByLine || !Number.isFinite(lineIdx))
    return hiddenSpansInReading(line);
  if (!hiddenSpansByLine.has(lineIdx)) {
    hiddenSpansByLine.set(lineIdx, hiddenSpansInReading(line));
  }
  return hiddenSpansByLine.get(lineIdx) || [];
}
function resolveReadingCurrentRange(root, lines, m, matcher, scroller, hiddenSpansByLine = null) {
  try {
    if (!root) return null;
    const line = lines[m.line] || "";
    const spans = cachedHiddenSpansForLine(m.line, line, hiddenSpansByLine);
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

// src/highlighter.js
function getHighlightSupport(view) {
  const win = getViewWindow(view);
  const css = win && win.CSS;
  if (!css || !css.highlights || !win.Highlight) return null;
  return {
    Highlight: win.Highlight,
    registry: css.highlights
  };
}
function clearHighlights(view, previousRegistry = null) {
  const registries = [previousRegistry];
  const support = getHighlightSupport(view);
  if (support) registries.push(support.registry);
  const seen = /* @__PURE__ */ new Set();
  for (const registry of registries) {
    if (!registry || seen.has(registry)) continue;
    seen.add(registry);
    registry.delete(HL_ALL);
    registry.delete(HL_CURRENT);
  }
}
function applyHighlights(view, previousRegistry, dom, currentRange) {
  const support = getHighlightSupport(view);
  if (!support) return null;
  if (previousRegistry && previousRegistry !== support.registry) {
    previousRegistry.delete(HL_ALL);
    previousRegistry.delete(HL_CURRENT);
  }
  support.registry.set(HL_ALL, new support.Highlight(...dom.map((d) => d.range)));
  if (currentRange) {
    const hl = new support.Highlight(currentRange);
    hl.priority = 1;
    support.registry.set(HL_CURRENT, hl);
  } else {
    support.registry.delete(HL_CURRENT);
  }
  return support.registry;
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
function limitDomHighlightsAroundCurrent(dom, currentRange, max, scroller) {
  var _a;
  if (!Array.isArray(dom) || !dom.length) return [];
  const n = Number(max);
  if (!Number.isFinite(n) || n <= 0 || dom.length <= n) return dom;
  const centerY = (_a = rangeCenterY(currentRange)) != null ? _a : viewportCenterY(scroller);
  if (centerY == null) return dom.slice(0, n);
  return dom.map((d, i) => {
    const y = rangeCenterY(d.range);
    return {
      item: d,
      index: i,
      dist: y == null ? Infinity : Math.abs(y - centerY)
    };
  }).sort((a, b) => a.dist - b.dist || a.index - b.index).slice(0, n).sort((a, b) => a.index - b.index).map((x) => x.item);
}

// src/results-list.js
var VirtualResultList = class {
  constructor({ container, getCurrent, getGroupInfo, onAfterRender, renderRow }) {
    this.el = container;
    this.getCurrent = getCurrent;
    this.getGroupInfo = getGroupInfo;
    this.onAfterRender = onAfterRender;
    this.renderRow = renderRow;
    this.itemCount = 0;
    this.renderLimit = RESULT_RENDER_BATCH;
    this.renderedCount = 0;
    this.renderedGroupKey = null;
    this.activeRow = null;
    this.observer = null;
    this.sentinelEl = null;
    this.spacerEl = null;
    this.moreBtnEl = null;
    this.displayLimit = 0;
    this.averageRowHeight = DEFAULT_RESULT_ROW_HEIGHT;
    this.renderToken = 0;
    this.scrollFrame = null;
    this.scrollWindow = null;
    this.prefetchId = null;
    this.prefetchKind = null;
    this.prefetchWindow = null;
    this.catchupFrame = null;
    this.catchupWindow = null;
    this.onScroll = null;
    this.setupObserver();
  }
  destroy() {
    this.disconnectObserver();
    this.cancelPrefetch();
    this.cancelCatchup();
    this.cancelScrollCheck();
    this.clearTail();
    if (this.el) this.el.empty();
    this.el = null;
    this.itemCount = 0;
    this.activeRow = null;
  }
  clear() {
    this.renderToken += 1;
    this.cancelPrefetch();
    this.cancelCatchup();
    this.cancelScrollCheck();
    this.clearTail();
    if (this.el) this.el.empty();
    this.renderLimit = RESULT_RENDER_BATCH;
    this.renderedCount = 0;
    this.renderedGroupKey = null;
    this.activeRow = null;
    this.displayLimit = 0;
    this.averageRowHeight = DEFAULT_RESULT_ROW_HEIGHT;
  }
  setItems(itemCount, activeIndex) {
    const el = this.el;
    if (!el) return;
    this.clear();
    this.itemCount = Math.max(0, Number(itemCount) || 0);
    if (!this.itemCount) return;
    el.scrollTop = 0;
    this.displayLimit = Math.min(this.itemCount, RESULT_DISPLAY_CAP);
    this.ensureCapCovers(activeIndex);
    this.renderLimit = Math.min(
      this.displayLimit || this.itemCount,
      Math.max(RESULT_RENDER_BATCH, activeIndex + 1)
    );
    this.renderChunk(this.renderLimit);
    this.setActive(activeIndex, { block: "center" });
    this.schedulePrefetch();
  }
  ensureCapCovers(index) {
    if (index == null || index < 0) return;
    if (index < this.displayLimit) return;
    const steps = Math.ceil((index + 1) / RESULT_DISPLAY_CAP);
    this.displayLimit = Math.min(this.itemCount, steps * RESULT_DISPLAY_CAP);
  }
  renderChunk(targetCount) {
    const el = this.el;
    if (!el || !this.itemCount) return false;
    const groupInfo = this.getGroupInfo ? this.getGroupInfo() : null;
    const start = this.renderedCount || 0;
    const limit = Math.min(this.displayLimit || this.itemCount, this.itemCount);
    const end = Math.min(limit, targetCount);
    if (end <= start) return false;
    const keepScrollTop = el.scrollTop;
    this.clearTail();
    const state = { lastGroupKey: this.renderedGroupKey };
    const activeIndex = this.current();
    for (let i = start; i < end; i++) {
      const row = this.renderRow ? this.renderRow(i, groupInfo, state) : null;
      if (row && i === activeIndex) {
        row.addClass("is-active");
        this.activeRow = row;
      }
    }
    this.renderedCount = end;
    this.renderedGroupKey = state.lastGroupKey;
    this.updateAverageHeight(el.scrollHeight, this.renderedCount);
    this.updateTail();
    el.scrollTop = keepScrollTop;
    return true;
  }
  ensureRendered(index) {
    if (index < 0 || index >= this.itemCount) return false;
    if (index < (this.renderedCount || 0)) return true;
    this.ensureCapCovers(index);
    this.renderLimit = Math.min(
      this.displayLimit || this.itemCount,
      Math.max(index + 1, (this.renderedCount || 0) + RESULT_RENDER_BATCH)
    );
    const changed = this.renderChunk(this.renderLimit);
    if (changed && this.onAfterRender) this.onAfterRender();
    return index < (this.renderedCount || 0);
  }
  setupObserver() {
    const el = this.el;
    if (!el) return;
    this.disconnectObserver();
    this.onScroll = () => this.scheduleScrollCheck();
    el.addEventListener("scroll", this.onScroll, { passive: true });
    const win = getElementWindow(el);
    if (win && typeof win.IntersectionObserver === "function") {
      this.observer = new win.IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            this.maybeRenderMore({ force: true });
          }
        },
        {
          root: el,
          rootMargin: `0px 0px ${RESULT_RENDER_AHEAD_PX}px 0px`,
          threshold: 0
        }
      );
    }
  }
  disconnectObserver() {
    if (this.observer) this.observer.disconnect();
    this.observer = null;
    this.cancelScrollCheck();
    if (this.el && this.onScroll) {
      this.el.removeEventListener("scroll", this.onScroll);
    }
    this.onScroll = null;
    this.sentinelEl = null;
    this.spacerEl = null;
    this.moreBtnEl = null;
  }
  scheduleScrollCheck() {
    const el = this.el;
    if (!el || this.scrollFrame != null) return;
    const win = getElementWindow(el);
    this.scrollWindow = win;
    this.scrollFrame = win.requestAnimationFrame(() => {
      this.scrollFrame = null;
      this.scrollWindow = null;
      this.maybeRenderMore();
    });
  }
  cancelScrollCheck() {
    if (this.scrollFrame == null) return;
    const win = this.scrollWindow || (this.el ? getElementWindow(this.el) : null);
    if (win && typeof win.cancelAnimationFrame === "function") {
      win.cancelAnimationFrame(this.scrollFrame);
    }
    this.scrollFrame = null;
    this.scrollWindow = null;
  }
  clearTail() {
    if (this.sentinelEl) {
      if (this.observer) this.observer.unobserve(this.sentinelEl);
      this.sentinelEl.remove();
      this.sentinelEl = null;
    }
    if (this.spacerEl) {
      this.spacerEl.remove();
      this.spacerEl = null;
    }
    if (this.moreBtnEl) {
      this.moreBtnEl.remove();
      this.moreBtnEl = null;
    }
  }
  updateAverageHeight(totalRowsHeight, renderedCount) {
    if (renderedCount <= 0 || totalRowsHeight <= 0) return;
    const sample = totalRowsHeight / renderedCount;
    if (!Number.isFinite(sample) || sample < 12) return;
    this.averageRowHeight = sample;
  }
  updateTail() {
    const el = this.el;
    if (!el || !this.itemCount) return;
    this.clearTail();
    const limit = Math.min(this.displayLimit || this.itemCount, this.itemCount);
    const rendered = this.renderedCount || 0;
    if (rendered < limit) {
      this.sentinelEl = el.createDiv({ cls: "lf-sentinel" });
      if (this.observer) this.observer.observe(this.sentinelEl);
      this.spacerEl = el.createDiv({ cls: "lf-spacer" });
      this.spacerEl.style.height = `${Math.max(
        0,
        Math.round(
          (limit - rendered) * (this.averageRowHeight || DEFAULT_RESULT_ROW_HEIGHT)
        )
      )}px`;
    }
    if (limit < this.itemCount) {
      this.moreBtnEl = el.createEl("button", { cls: "lf-btn lf-more-btn" });
      this.moreBtnEl.setText(`Show more (${this.itemCount - limit} hidden)`);
      this.moreBtnEl.onclick = () => this.expandCap();
    }
  }
  expandCap() {
    if (!this.el || this.displayLimit >= this.itemCount) return;
    this.displayLimit = Math.min(
      this.itemCount,
      this.displayLimit + RESULT_DISPLAY_CAP
    );
    this.renderLimit = Math.max(
      this.renderLimit || RESULT_RENDER_BATCH,
      (this.renderedCount || 0) + RESULT_RENDER_BATCH
    );
    if (!this.renderChunk(this.renderLimit)) this.updateTail();
    if (this.onAfterRender) this.onAfterRender();
    this.schedulePrefetch();
  }
  isNearBottom() {
    const el = this.el;
    if (!el) return false;
    const tailTop = this.sentinelEl ? this.sentinelEl.offsetTop : el.scrollHeight;
    return el.scrollTop + el.clientHeight >= tailTop - RESULT_RENDER_AHEAD_PX;
  }
  maybeRenderMore(options = {}) {
    const limit = Math.min(this.displayLimit || this.itemCount, this.itemCount);
    if (!this.el || !this.itemCount || (this.renderedCount || 0) >= limit) return;
    if (!options.force && !this.isNearBottom()) return;
    this.renderLimit = Math.min(
      limit,
      Math.max(
        this.renderLimit || RESULT_RENDER_BATCH,
        (this.renderedCount || 0) + RESULT_RENDER_BATCH
      )
    );
    if (this.renderChunk(this.renderLimit)) {
      if (this.onAfterRender) this.onAfterRender();
      this.schedulePrefetch();
      if (this.isNearBottom()) this.scheduleCatchup();
    }
  }
  schedulePrefetch() {
    const el = this.el;
    if (!el || this.prefetchId != null || !this.itemCount) return;
    const cap = Math.min(this.displayLimit || this.itemCount, this.itemCount);
    if ((this.renderedCount || 0) >= cap) return;
    const win = getElementWindow(el);
    const token = this.renderToken;
    const run = () => {
      this.prefetchId = null;
      this.prefetchKind = null;
      this.prefetchWindow = null;
      if (token !== this.renderToken || !this.el || !this.itemCount) return;
      const limit = Math.min(this.displayLimit || this.itemCount, this.itemCount);
      if ((this.renderedCount || 0) >= limit) return;
      const scrollTop = this.el.scrollTop;
      const target = Math.min(
        limit,
        (this.renderedCount || 0) + RESULT_IDLE_PREFETCH_BATCH
      );
      if (this.renderChunk(target)) {
        this.el.scrollTop = scrollTop;
        if (this.onAfterRender) this.onAfterRender();
      }
      this.schedulePrefetch();
    };
    if (win && typeof win.requestIdleCallback === "function") {
      this.prefetchKind = "idle";
      this.prefetchId = win.requestIdleCallback(run, { timeout: 350 });
    } else {
      this.prefetchKind = "timeout";
      this.prefetchId = win.setTimeout(run, 80);
    }
    this.prefetchWindow = win;
  }
  cancelPrefetch() {
    if (this.prefetchId == null) return;
    const win = this.prefetchWindow || (this.el ? getElementWindow(this.el) : null);
    if (this.prefetchKind === "idle" && win && typeof win.cancelIdleCallback === "function") {
      win.cancelIdleCallback(this.prefetchId);
    } else if (win && typeof win.clearTimeout === "function") {
      win.clearTimeout(this.prefetchId);
    }
    this.prefetchId = null;
    this.prefetchKind = null;
    this.prefetchWindow = null;
  }
  scheduleCatchup() {
    const el = this.el;
    if (!el || this.catchupFrame != null) return;
    const win = getElementWindow(el);
    this.catchupWindow = win;
    this.catchupFrame = win.requestAnimationFrame(() => {
      this.catchupFrame = null;
      this.catchupWindow = null;
      this.maybeRenderMore();
    });
  }
  cancelCatchup() {
    if (this.catchupFrame == null) return;
    const win = this.catchupWindow || (this.el ? getElementWindow(this.el) : null);
    if (win && typeof win.cancelAnimationFrame === "function") {
      win.cancelAnimationFrame(this.catchupFrame);
    }
    this.catchupFrame = null;
    this.catchupWindow = null;
  }
  current() {
    const current = this.getCurrent ? this.getCurrent() : -1;
    return Number.isFinite(current) ? current : -1;
  }
  setActive(index, options = {}) {
    if (!this.el) return;
    const shouldScroll = options.scroll !== false;
    this.ensureRendered(index);
    const previous = this.activeRow && this.activeRow.isConnected ? this.activeRow : null;
    const row = index >= 0 ? this.el.querySelector(`.lf-row[data-match-index="${index}"]`) : null;
    if (previous && previous !== row) previous.classList.remove("is-active");
    if (row) {
      row.classList.add("is-active");
      if (shouldScroll) {
        row.scrollIntoView({
          block: options.block || "nearest",
          inline: "nearest"
        });
      }
    }
    this.activeRow = row || null;
    if (this.onAfterRender) this.onAfterRender();
  }
};

// src/find-bar.js
var FindBar = class {
  constructor(plugin, view) {
    this.plugin = plugin;
    this.view = view;
    this.matches = [];
    this.current = -1;
    this.query = "";
    this.matcher = null;
    const options = plugin && typeof plugin.getFindOptions === "function" ? plugin.getFindOptions() : DEFAULT_FIND_OPTIONS;
    this.caseSensitive = options.caseSensitive;
    this.useRegex = options.useRegex;
    this.wholeWord = options.wholeWord;
    this.groupResults = options.groupResults;
    this.headingGroupLevel = options.headingGroupLevel;
    this.showResultHeadings = options.showResultHeadings;
    this.jumpNearest = options.jumpNearest;
    this.domMode = false;
    this.renderedTextMode = false;
    this.currentDomRange = null;
    this.highlightToken = 0;
    this.highlightRegistry = null;
    this.resultList = null;
    this.docCache = null;
    this.perfStats = {};
    this.perfSeq = 0;
    this.barEl = null;
    this.resultsEl = null;
  }
  get editor() {
    return this.view && this.view.editor;
  }
  performanceApi() {
    const win = getElementWindow(
      this.barEl || this.view && this.view.containerEl
    );
    return win && win.performance ? win.performance : null;
  }
  beginPerf(name) {
    const perf = this.performanceApi();
    const id = ++this.perfSeq;
    const start = perf ? perf.now() : Date.now();
    const markName = `live-find:${name}:start:${id}`;
    if (perf && typeof perf.mark === "function") {
      try {
        perf.mark(markName);
      } catch (e) {
        debugWarn("perf mark", e);
      }
    }
    return { name, id, start, markName, perf };
  }
  endPerf(mark) {
    if (!mark) return 0;
    const perf = mark.perf || this.performanceApi();
    const end = perf ? perf.now() : Date.now();
    const duration = end - mark.start;
    this.perfStats[mark.name] = duration;
    if (perf && typeof perf.mark === "function" && typeof perf.measure === "function") {
      const endMark = `live-find:${mark.name}:end:${mark.id}`;
      const measureName = `live-find:${mark.name}`;
      try {
        perf.mark(endMark);
        perf.measure(measureName, mark.markName, endMark);
        if (typeof perf.clearMarks === "function") {
          perf.clearMarks(mark.markName);
          perf.clearMarks(endMark);
        }
      } catch (e) {
        debugWarn("perf measure", e);
      }
    }
    return duration;
  }
  updateDocumentCache() {
    const text = this.editor.getValue();
    if (this.docCache && this.docCache.text === text) {
      this.docLines = this.docCache.lines;
      this.tableLookup = this.docCache.tables;
      this.headingLookup = this.docCache.headings;
      return this.docCache;
    }
    const lines = text.split("\n");
    const cache = {
      text,
      lines,
      lowerLines: lines.map((line) => line.toLowerCase()),
      tables: buildTableLookup(lines),
      headings: buildHeadingLookup(lines),
      hiddenSpansByLine: /* @__PURE__ */ new Map(),
      version: this.docCache ? this.docCache.version + 1 : 1
    };
    this.docCache = cache;
    this.docLines = cache.lines;
    this.tableLookup = cache.tables;
    this.headingLookup = cache.headings;
    return cache;
  }
  hiddenSpansForLine(lineIdx) {
    const cache = this.docCache;
    const line = cache && cache.lines ? cache.lines[lineIdx] || "" : "";
    if (!cache) return hiddenSpansInReading(line);
    if (!cache.hiddenSpansByLine.has(lineIdx)) {
      cache.hiddenSpansByLine.set(lineIdx, hiddenSpansInReading(line));
    }
    return cache.hiddenSpansByLine.get(lineIdx) || [];
  }
  isOpen() {
    return !!this.barEl;
  }
  viewModeKey() {
    return `${this.view.getMode()}:${isLivePreviewMode(this.view) ? "live" : "plain"}`;
  }
  nextHighlightToken() {
    this.highlightToken += 1;
    return this.highlightToken;
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
  refreshCurrentSearch(options = {}) {
    if (!this.barEl) return;
    const query = this.input ? this.input.value : this.query;
    if (query) this.search(query, options);
    else this.clearHighlights();
  }
  flushInputSearch() {
    if (this.onInput && this.onInput.cancel) this.onInput.cancel();
    if (this.input) this.search(this.input.value);
  }
  closestMatchIndex(previousMatch, previousCurrent) {
    if (!this.matches.length) return -1;
    if (!previousMatch) {
      return Math.min(Math.max(previousCurrent, 0), this.matches.length - 1);
    }
    let bestIndex = 0;
    let bestDistance = Infinity;
    this.matches.forEach((m, i) => {
      const distance = Math.abs(m.line - previousMatch.line) * 1e5 + Math.abs(m.ch - previousMatch.ch);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    });
    return bestIndex;
  }
  /**
   * Best-effort source line currently at the center of the viewport. Used to
   * start a fresh search near what the user is reading instead of always
   * yanking to the first match in the note. Returns null if it can't be
   * determined (callers then fall back to the first match).
   */
  anchorLineFromViewport() {
    try {
      if (this.view.getMode() === "preview") {
        const pm = this.view.previewMode || this.view.currentMode;
        const renderer = pm && pm.renderer;
        let s = null;
        if (renderer && typeof renderer.getScroll === "function") s = renderer.getScroll();
        else if (pm && typeof pm.getScroll === "function") s = pm.getScroll();
        return Number.isFinite(s) ? Math.max(0, Math.round(s)) : null;
      }
      const cm = getEditorView(this.editor);
      const scroller = getScroller(this.view) || cm && cm.scrollDOM;
      if (!cm || !scroller || typeof cm.posAtCoords !== "function") return null;
      const rect = scroller.getBoundingClientRect();
      const y = rect.top + rect.height / 2;
      const x = rect.left + Math.min(40, rect.width / 2);
      let off = cm.posAtCoords({ x, y }, false);
      if (off == null) off = cm.posAtCoords({ x, y });
      if (off == null) return null;
      const pos = this.editor.offsetToPos(off);
      return pos ? pos.line : null;
    } catch (e) {
      debugWarn("anchorLineFromViewport", e);
      return null;
    }
  }
  /** Index of the match whose source line is nearest `line`; 0 if unknown. */
  nearestMatchIndexToLine(line) {
    if (line == null || !this.matches.length) return 0;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < this.matches.length; i++) {
      const m = this.matches[i];
      const dist = Math.abs(m.line - line) * 1e5 + m.ch;
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    return best;
  }
  syncToggleButtons() {
    if (this.caseBtn) this.caseBtn.toggleClass("is-on", this.caseSensitive);
    if (this.regexBtn) this.regexBtn.toggleClass("is-on", this.useRegex);
    if (this.wordBtn) this.wordBtn.toggleClass("is-on", this.wholeWord);
    if (this.nearestBtn) this.nearestBtn.toggleClass("is-on", this.jumpNearest);
    if (this.groupBtn) {
      this.groupBtn.toggleClass("is-on", this.groupResults);
      this.groupBtn.setText(
        this.groupResults ? headingLevelLabel(this.headingGroupLevel) : "H-"
      );
      this.groupBtn.title = this.groupResults ? `Grouped by ${headingLevelMenuLabel(this.headingGroupLevel)}` : "Group results by heading";
    }
  }
  persistFindOptions() {
    if (this.plugin && typeof this.plugin.saveFindOptions === "function") {
      this.plugin.saveFindOptions({
        caseSensitive: this.caseSensitive,
        useRegex: this.useRegex,
        wholeWord: this.wholeWord,
        groupResults: this.groupResults,
        headingGroupLevel: this.headingGroupLevel,
        showResultHeadings: this.showResultHeadings,
        jumpNearest: this.jumpNearest
      });
    }
  }
  setSearchOption(name, value) {
    this[name] = value;
    this.syncToggleButtons();
    this.persistFindOptions();
    this.search(this.input.value);
    this.input.focus();
  }
  setHeadingGrouping(groupResults, headingGroupLevel = this.headingGroupLevel) {
    this.groupResults = !!groupResults;
    this.headingGroupLevel = normalizeHeadingGroupLevel(headingGroupLevel);
    this.matchGroupInfo = null;
    this.syncToggleButtons();
    this.persistFindOptions();
    this.renderList();
    this.updateCount();
    this.markActiveRow();
    if (this.input) this.input.focus();
  }
  setResultHeadingDisplay(showResultHeadings) {
    this.showResultHeadings = !!showResultHeadings;
    this.syncToggleButtons();
    this.persistFindOptions();
    this.renderList();
    this.markActiveRow();
    if (this.input) this.input.focus();
  }
  showHeadingGroupMenu(evt) {
    evt.preventDefault();
    const menu = new import_obsidian.Menu();
    menu.addItem((item) => {
      item.setTitle("Show row headings").setChecked(this.showResultHeadings).onClick(() => this.setResultHeadingDisplay(!this.showResultHeadings));
    });
    if (typeof menu.addSeparator === "function") menu.addSeparator();
    menu.addItem((item) => {
      item.setTitle("Group: Off").setChecked(!this.groupResults).onClick(() => this.setHeadingGrouping(false));
    });
    if (typeof menu.addSeparator === "function") menu.addSeparator();
    const levels = [1, 2, 3, 4, 5, 6];
    for (const level of levels) {
      menu.addItem((item) => {
        item.setTitle(`Group by ${headingLevelMenuLabel(level)}`).setChecked(this.groupResults && this.headingGroupLevel === level).onClick(() => this.setHeadingGrouping(true, level));
      });
    }
    menu.showAtMouseEvent(evt);
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
      placeholder: "Search current note..."
    });
    this.caseBtn = bar.createEl("button", { cls: "lf-btn lf-toggle", text: "Aa" });
    this.caseBtn.title = "Match case";
    this.regexBtn = bar.createEl("button", { cls: "lf-btn lf-toggle", text: ".*" });
    this.regexBtn.title = "Use regular expression";
    this.wordBtn = bar.createEl("button", { cls: "lf-btn lf-toggle", text: "W" });
    this.wordBtn.title = "Match whole word";
    this.nearestBtn = bar.createEl("button", { cls: "lf-btn lf-toggle" });
    (0, import_obsidian.setIcon)(this.nearestBtn, "locate-fixed");
    this.nearestBtn.title = "Jump to the match nearest the current view (off: always jump to the first match)";
    this.groupBtn = bar.createEl("button", { cls: "lf-btn lf-toggle lf-heading-toggle", text: "H-" });
    this.groupBtn.title = "Group results by heading";
    this.syncToggleButtons();
    this.countEl = bar.createSpan({ cls: "lf-count", text: "" });
    this.sepEl = bar.createDiv({ cls: "lf-sep" });
    const prev = bar.createEl("button", { cls: "lf-btn" });
    const next = bar.createEl("button", { cls: "lf-btn" });
    const close = bar.createEl("button", { cls: "lf-btn" });
    (0, import_obsidian.setIcon)(prev, "chevron-up");
    (0, import_obsidian.setIcon)(next, "chevron-down");
    (0, import_obsidian.setIcon)(close, "x");
    prev.title = "Previous (Shift+Enter / \u2191)";
    next.title = "Next (Enter / \u2193)";
    close.title = "Close (Esc)";
    prev.onclick = () => this.step(-1);
    next.onclick = () => this.step(1);
    close.onclick = () => this.close();
    this.caseBtn.onclick = () => {
      this.setSearchOption("caseSensitive", !this.caseSensitive);
    };
    this.regexBtn.onclick = () => {
      this.setSearchOption("useRegex", !this.useRegex);
    };
    this.wordBtn.onclick = () => {
      this.setSearchOption("wholeWord", !this.wholeWord);
    };
    this.nearestBtn.onclick = () => {
      this.setSearchOption("jumpNearest", !this.jumpNearest);
    };
    this.groupBtn.onclick = (evt) => this.showHeadingGroupMenu(evt);
    this.resultsEl = host.createDiv({ cls: "lf-results" });
    this.resultsEl.style.display = "none";
    this.resultList = new VirtualResultList({
      container: this.resultsEl,
      getCurrent: () => this.current,
      getGroupInfo: () => this.getMatchGroupInfo(),
      onAfterRender: () => this.updateGroupCounts(),
      renderRow: (index, groupInfo, state) => this.createResultRow(index, groupInfo, state)
    });
    this.updateCount();
    this.onInput = debounce(
      () => this.search(this.input.value),
      DEBOUNCE_MS
    );
    this.input.addEventListener("input", this.onInput);
    this.onPaste = (e) => {
      var _a, _b;
      if (this.useRegex || !e.clipboardData) {
        setTimeout(() => this.flushInputSearch(), 0);
        return;
      }
      const text = e.clipboardData.getData("text");
      const trimmed = normalizePlainQuery(text);
      if (trimmed === text) {
        setTimeout(() => this.flushInputSearch(), 0);
        return;
      }
      e.preventDefault();
      const start = (_a = this.input.selectionStart) != null ? _a : this.input.value.length;
      const end = (_b = this.input.selectionEnd) != null ? _b : start;
      this.input.setRangeText(trimmed, start, end, "end");
      this.flushInputSearch();
    };
    this.input.addEventListener("paste", this.onPaste);
    this.onKeydown = (e) => {
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
    this.onScroll = throttleFrame(
      () => this.refreshHighlights(this.highlightToken, { fromScroll: true })
    );
    this.updateScroller();
    this.lastViewMode = this.viewModeKey();
    this.layoutEvt = this.plugin.app.workspace.on("layout-change", () => {
      if (!this.barEl) return;
      const mode = this.viewModeKey();
      if (mode === this.lastViewMode) return;
      this.lastViewMode = mode;
      this.updateScroller();
      this.refreshCurrentSearch({ preserveCurrent: true });
    });
    this.onEditorChange = debounce(() => {
      if (!this.barEl) return;
      const active = this.plugin.app.workspace.getActiveViewOfType(import_obsidian.MarkdownView);
      if (active !== this.view) return;
      this.refreshCurrentSearch({ preserveCurrent: true, jump: false });
    }, DEBOUNCE_MS);
    this.editorChangeEvt = this.plugin.app.workspace.on(
      "editor-change",
      this.onEditorChange
    );
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
    if (this.input && this.onPaste) {
      this.input.removeEventListener("paste", this.onPaste);
    }
    if (this.input && this.onKeydown) {
      this.input.removeEventListener("keydown", this.onKeydown);
    }
    if (this.scroller && this.onScroll) {
      this.scroller.removeEventListener("scroll", this.onScroll);
    }
    this.scroller = null;
    if (this.resultList) this.resultList.destroy();
    this.resultList = null;
    if (this.layoutEvt) this.plugin.app.workspace.offref(this.layoutEvt);
    if (this.editorChangeEvt) this.plugin.app.workspace.offref(this.editorChangeEvt);
    this.layoutEvt = null;
    this.editorChangeEvt = null;
    this.clearHighlights();
    this.nextHighlightToken();
    if (this.barEl) this.barEl.remove();
    if (this.resultsEl) this.resultsEl.remove();
    this.barEl = null;
    this.resultsEl = null;
    this.input = null;
    this.onPaste = null;
    this.onKeydown = null;
    this.onResultsScroll = null;
    this.onEditorChange = null;
    this.matches = [];
    this.current = -1;
    this.query = "";
    this.matcher = null;
    this.tableLookup = null;
    this.headingLookup = null;
    this.docCache = null;
    this.snippetCache = /* @__PURE__ */ new Map();
  }
  clearHighlights() {
    clearHighlights(this.view, this.highlightRegistry);
    this.highlightRegistry = null;
  }
  domApply(dom, currentRange) {
    const registry = applyHighlights(this.view, this.highlightRegistry, dom, currentRange);
    if (registry) this.highlightRegistry = registry;
  }
  refreshHighlights(token = this.highlightToken, options = {}) {
    if (token !== this.highlightToken) return null;
    if (!this.barEl) return null;
    if (!getHighlightSupport(this.view)) return null;
    if (!this.query || !this.matcher || this.matcher.invalid)
      return this.clearHighlights(), null;
    const fromScroll = !!options.fromScroll;
    if (this.domMode) {
      const root2 = getRenderRoot(this.view);
      const m2 = this.matches[this.current];
      const scroller2 = getScroller(this.view);
      let cur = m2 ? resolveReadingCurrentRange(
        root2,
        this.docLines,
        m2,
        this.matcher,
        scroller2,
        this.docCache && this.docCache.hiddenSpansByLine
      ) : null;
      if (!cur && this.currentDomRange && this.currentDomRange.startContainer && this.currentDomRange.startContainer.isConnected)
        cur = this.currentDomRange;
      const domOptions2 = fromScroll || options.viewportOnly ? { scroller: scroller2, viewportMargin: 3e3 } : {};
      let dom2 = findRenderedMatches(root2, this.matcher, domOptions2);
      if (!cur && dom2.length) {
        const rect = scroller2 ? scroller2.getBoundingClientRect() : { top: 0 };
        const targetY = rect.top + 80;
        let best = null;
        let bd = Infinity;
        for (const d of dom2) {
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
      dom2 = limitDomHighlightsAroundCurrent(
        dom2,
        cur,
        MAX_DOM_HIGHLIGHTS,
        scroller2
      );
      this.domApply(dom2, cur);
      return cur;
    }
    const root = getRenderRoot(this.view);
    const scroller = getScroller(this.view);
    let dom = null;
    let currentRange = null;
    const m = this.matches[this.current];
    const lines = this.docLines || [];
    if (m) {
      const line = lines[m.line] || "";
      const isTable = !!locateInTables(lines, m.line, this.tableLookup) && !isDelimiterRow(line);
      const cm = getEditorView(this.editor);
      let off = null;
      try {
        off = this.editor.posToOffset({ line: m.line, ch: m.ch });
      } catch (e) {
        debugWarn("posToOffset", e);
      }
      if (off != null && cm) {
        if (isTable)
          currentRange = resolveTableByPoint(
            cm,
            off,
            lines,
            m,
            this.matcher,
            this.tableLookup
          );
        if (!currentRange) currentRange = resolveByDomAtPos(cm, off, this.matcher);
        if (!currentRange) {
          const domOptions2 = fromScroll || options.viewportOnly ? { scroller, viewportMargin: 3e3 } : {};
          dom = findRenderedMatches(root, this.matcher, domOptions2);
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
              const dist = Math.abs((r.top + r.bottom) / 2 - cy) * 4 + Math.abs(r.left - cx);
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
    const domOptions = fromScroll || options.viewportOnly ? { scroller, viewportMargin: 3e3 } : {};
    if (!dom) dom = findRenderedMatches(root, this.matcher, domOptions);
    this.currentDomRange = currentRange;
    dom = limitDomHighlightsAroundCurrent(
      dom,
      currentRange,
      MAX_DOM_HIGHLIGHTS,
      scroller
    );
    this.domApply(dom, currentRange);
    return currentRange;
  }
  revealCurrentMatch(token = this.highlightToken) {
    const range = this.refreshHighlights(token, { viewportOnly: true });
    if (range && scrollRangeIntoView(range)) return;
    const m = this.matches[this.current];
    if (!m || this.domMode) return;
    try {
      centerEditorOffset(
        this.view,
        this.editor,
        this.editor.posToOffset({ line: m.line, ch: m.ch })
      );
    } catch (e) {
      debugWarn("reveal current fallback", e);
    }
  }
  search(query, options = {}) {
    if (!this.barEl || !this.resultsEl) return;
    const totalPerf = this.beginPerf("search-total");
    const previousCurrent = this.current;
    const previousMatch = options.preserveCurrent ? this.matches[previousCurrent] : null;
    const shouldJump = options.jump !== false;
    const effectiveQuery = this.useRegex ? query : normalizePlainQuery(query);
    this.query = effectiveQuery;
    this.matcher = buildMatcher(effectiveQuery, this.caseSensitive, this.useRegex, this.wholeWord);
    this.domMode = this.view.getMode() === "preview";
    this.renderedTextMode = this.domMode || isLivePreviewMode(this.view);
    const cachePerf = this.beginPerf("document-cache");
    const docCache = this.updateDocumentCache();
    this.endPerf(cachePerf);
    this.snippetCache = /* @__PURE__ */ new Map();
    const matchPerf = this.beginPerf("match-source");
    this.matches = findSourceMatches(
      docCache.lines,
      this.matcher,
      docCache.lowerLines
    );
    this.endPerf(matchPerf);
    this.matchGroupInfo = null;
    if (this.renderedTextMode && this.matches.length) {
      const filterPerf = this.beginPerf("filter-rendered");
      this.matches = this.matches.filter((m) => {
        const line = this.docLines[m.line] || "";
        if (isDelimiterRow(line)) return false;
        if (!cleanSnippet(line)) return false;
        const spans = this.hiddenSpansForLine(m.line);
        return !isInsideSpan(m.ch, spans);
      });
      this.endPerf(filterPerf);
    }
    this.current = this.matches.length ? options.preserveCurrent ? this.closestMatchIndex(previousMatch, previousCurrent) : this.jumpNearest ? this.nearestMatchIndexToLine(this.anchorLineFromViewport()) : 0 : -1;
    this.currentDomRange = null;
    const renderPerf = this.beginPerf("render-results");
    this.renderList();
    this.updateCount();
    this.endPerf(renderPerf);
    const token = this.nextHighlightToken();
    if (this.current >= 0 && shouldJump) this.jumpToCurrent(token);
    else if (this.current >= 0) this.refreshHighlights(token);
    else this.clearHighlights();
    this.endPerf(totalPerf);
  }
  step(dir) {
    if (!this.matches.length) return;
    this.current = (this.current + dir + this.matches.length) % this.matches.length;
    this.jumpToCurrent(this.nextHighlightToken());
    this.updateCount();
    this.markActiveRow();
  }
  jumpToCurrent(token = this.nextHighlightToken()) {
    const m = this.matches[this.current];
    if (!m) return;
    if (this.domMode) {
      try {
        const pm = this.view.previewMode || this.view.currentMode;
        const renderer = pm && pm.renderer;
        if (renderer && typeof renderer.applyScrollDelayed === "function") {
          renderer.applyScrollDelayed(m.line, { center: true, highlight: true });
        } else if (renderer && typeof renderer.applyScroll === "function") {
          renderer.applyScroll(m.line, { center: true, highlight: true });
        } else if (pm && typeof pm.applyScroll === "function") {
          pm.applyScroll(m.line);
        }
      } catch (e) {
        debugWarn("applyScroll", e);
      }
      this.currentDomRange = null;
      this.revealCurrentMatch(token);
      setTimeout(() => this.revealCurrentMatch(token), 90);
      setTimeout(() => this.revealCurrentMatch(token), 220);
      return;
    }
    const from = { line: m.line, ch: m.ch };
    const to = { line: m.line, ch: m.ch + m.len };
    let fromOffset = null;
    let toOffset = null;
    try {
      fromOffset = this.editor.posToOffset(from);
      toOffset = this.editor.posToOffset(to);
    } catch (e) {
      debugWarn("source posToOffset", e);
    }
    try {
      const cm = getEditorView(this.editor);
      if (cm && typeof cm.dispatch === "function" && fromOffset != null && toOffset != null) {
        cm.dispatch({
          selection: { anchor: fromOffset, head: toOffset },
          scrollIntoView: true
        });
      } else if (typeof this.editor.setSelection === "function") {
        this.editor.setSelection(from, to);
      }
    } catch (e) {
      debugWarn("source selection", e);
    }
    try {
      const mode = this.view.currentMode || this.view.sourceMode;
      if (mode && typeof mode.applyScroll === "function") mode.applyScroll(m.line);
    } catch (e) {
      debugWarn("source applyScroll", e);
    }
    try {
      this.editor.scrollIntoView({ from, to }, true);
    } catch (e) {
      debugWarn("scrollIntoView", e);
    }
    this.currentDomRange = null;
    this.revealCurrentMatch(token);
    setTimeout(() => this.revealCurrentMatch(token), 60);
    setTimeout(() => this.revealCurrentMatch(token), 180);
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
    this.updateGroupCounts();
  }
  getMatchGroupInfo() {
    if (!this.groupResults || !this.matches.length) return null;
    if (this.matchGroupInfo && this.matchGroupInfo.matchCount === this.matches.length && this.matchGroupInfo.headingGroupLevel === this.headingGroupLevel) {
      return this.matchGroupInfo;
    }
    const groupLevel = normalizeHeadingGroupLevel(this.headingGroupLevel);
    const groups = this.matches.map(
      (m) => headingGroupForLine(this.docLines || [], m.line, groupLevel, this.headingLookup)
    );
    const totals = /* @__PURE__ */ new Map();
    for (const group of groups) {
      const key = headingGroupKey(group);
      totals.set(key, (totals.get(key) || 0) + 1);
    }
    const seen = /* @__PURE__ */ new Map();
    const items = groups.map((group) => {
      const key = headingGroupKey(group);
      const indexInGroup = (seen.get(key) || 0) + 1;
      seen.set(key, indexInGroup);
      return {
        group,
        key,
        indexInGroup,
        totalInGroup: totals.get(key) || 0
      };
    });
    this.matchGroupInfo = {
      headingGroupLevel: this.headingGroupLevel,
      matchCount: this.matches.length,
      items,
      totals
    };
    return this.matchGroupInfo;
  }
  renderList() {
    const el = this.resultsEl;
    if (!el || !this.resultList) return;
    if (!this.query || !this.matches.length) {
      this.resultList.clear();
      el.style.display = "none";
      return;
    }
    el.style.display = "block";
    this.resultList.setItems(this.matches.length, this.current);
  }
  createResultRow(i, groupInfo, state) {
    const el = this.resultsEl;
    if (!el) return null;
    const m = this.matches[i];
    const groupItem = groupInfo ? groupInfo.items[i] : null;
    const group = groupItem ? groupItem.group : null;
    if (groupItem && groupItem.key !== state.lastGroupKey) {
      state.lastGroupKey = groupItem.key;
      const groupEl = el.createDiv({ cls: "lf-group" });
      groupEl.dataset.groupKey = groupItem.key;
      groupEl.dataset.groupTitle = group.text;
      groupEl.dataset.groupTotal = String(groupItem.totalInGroup);
      groupEl.createSpan({ cls: "lf-group-title", text: group.text });
      groupEl.createSpan({
        cls: "lf-group-count",
        text: String(groupItem.totalInGroup)
      });
    }
    const row = el.createDiv({ cls: "lf-row" });
    row.dataset.matchIndex = String(i);
    const head = this.showResultHeadings ? nearestHeading(this.docLines, m.line, 6, this.headingLookup) : null;
    if (head) row.addClass("has-head");
    const main = row.createDiv({ cls: "lf-main" });
    main.createSpan({ cls: "lf-line", text: `Line ${m.line + 1}` });
    const sn = main.createSpan({ cls: "lf-snippet" });
    let snippet = this.snippetCache.get(i);
    if (snippet === void 0) {
      snippet = buildSnippetData(
        m,
        this.docLines || [],
        this.matcher,
        this.renderedTextMode,
        this.tableLookup,
        this.docCache && this.docCache.hiddenSpansByLine
      );
      this.snippetCache.set(i, snippet || null);
    }
    if (snippet) {
      appendHighlightedSnippet(
        sn,
        snippet.source,
        snippet.hitIdx,
        snippet.hitLen,
        snippet.keepShort
      );
    }
    if (head && (!group || head.line !== group.line)) {
      row.createDiv({ cls: "lf-head" }).setText(cleanHeadingText(head.text));
    }
    row.onclick = () => {
      this.current = i;
      this.jumpToCurrent(this.nextHighlightToken());
      this.updateCount();
      this.markActiveRow();
      if (this.input) this.input.focus();
    };
    return row;
  }
  setText(el, text) {
    if (!el) return;
    if (typeof el.setText === "function") el.setText(text);
    else el.textContent = text;
  }
  updateGroupCounts() {
    if (!this.resultsEl) return;
    const groupInfo = this.getMatchGroupInfo();
    if (!groupInfo) return;
    const active = groupInfo.items[this.current];
    const groups = this.resultsEl.querySelectorAll(".lf-group");
    for (const groupEl of groups) {
      const key = groupEl.dataset.groupKey;
      const countEl = groupEl.querySelector(".lf-group-count");
      const total = groupInfo.totals.get(key) || Number(groupEl.dataset.groupTotal) || 0;
      const isActive = !!active && key === active.key;
      groupEl.toggleClass("is-active", isActive);
      this.setText(
        countEl,
        isActive ? `${active.indexInGroup}/${active.totalInGroup}` : String(total)
      );
      groupEl.title = isActive ? `${active.group.text}: ${active.indexInGroup}/${active.totalInGroup}` : `${groupEl.dataset.groupTitle || "Heading"}: ${total}`;
    }
  }
  markActiveRow(options = {}) {
    if (!this.resultList) return;
    this.resultList.setActive(this.current, options);
    this.updateGroupCounts();
  }
};

// src/main.js
var LiveFindPlugin = class extends import_obsidian2.Plugin {
  async onload() {
    await this.loadPluginData();
    this.bar = null;
    this.addCommand({
      id: "open-find-bar",
      name: "Open find bar",
      callback: () => {
        const view = this.app.workspace.getActiveViewOfType(import_obsidian2.MarkdownView);
        if (!view) return new import_obsidian2.Notice("Open a Markdown note first.");
        if (!getHighlightSupport(view))
          return new import_obsidian2.Notice("This Obsidian version lacks the CSS Highlight API.");
        if (this.bar && this.bar.view !== view) this.bar.close();
        if (!this.bar || !this.bar.isOpen()) this.bar = new FindBar(this, view);
        this.bar.open();
      }
    });
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        if (this.bar) this.bar.close();
      })
    );
  }
  async loadPluginData() {
    try {
      this.data = await this.loadData() || {};
    } catch (e) {
      debugWarn("loadData", e);
      this.data = {};
    }
    this.findOptions = normalizeFindOptions(this.data.findOptions);
  }
  getFindOptions() {
    return normalizeFindOptions(this.findOptions);
  }
  saveFindOptions(options) {
    this.findOptions = normalizeFindOptions(options);
    const data = this.data && typeof this.data === "object" ? this.data : {};
    this.data = { ...data, findOptions: this.findOptions };
    this.saveData(this.data).catch((e) => debugWarn("save find options", e));
  }
  onunload() {
    if (this.bar) this.bar.close();
  }
};
