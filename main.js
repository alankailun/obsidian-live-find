"use strict";
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// src/constants.js
var require_constants = __commonJS({
  "src/constants.js"(exports2, module2) {
    "use strict";
    var HL_ALL2 = "live-find-all";
    var HL_CURRENT2 = "live-find-current";
    var DEBUG = false;
    var DEBOUNCE_MS = 100;
    var MAX_DOM_HIGHLIGHTS = 2500;
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
      showResultHeadings: true
    };
    module2.exports = {
      HL_ALL: HL_ALL2,
      HL_CURRENT: HL_CURRENT2,
      DEBUG,
      DEBOUNCE_MS,
      MAX_DOM_HIGHLIGHTS,
      SELECTORS,
      DEFAULT_FIND_OPTIONS
    };
  }
});

// src/options.js
var require_options = __commonJS({
  "src/options.js"(exports2, module2) {
    "use strict";
    var { DEFAULT_FIND_OPTIONS } = require_constants();
    function normalizeHeadingGroupLevel2(value) {
      const n = Number(value);
      if (Number.isInteger(n) && n >= 1 && n <= 6) return n;
      return DEFAULT_FIND_OPTIONS.headingGroupLevel;
    }
    function headingLevelLabel(level) {
      return `H${normalizeHeadingGroupLevel2(level)}`;
    }
    function headingLevelMenuLabel(level) {
      return `Heading ${normalizeHeadingGroupLevel2(level)}`;
    }
    function normalizeFindOptions2(options) {
      const src = options && typeof options === "object" ? options : {};
      const savedRemovedTopLevel = src.headingGroupLevel === "top";
      return {
        caseSensitive: typeof src.caseSensitive === "boolean" ? src.caseSensitive : DEFAULT_FIND_OPTIONS.caseSensitive,
        useRegex: typeof src.useRegex === "boolean" ? src.useRegex : DEFAULT_FIND_OPTIONS.useRegex,
        wholeWord: typeof src.wholeWord === "boolean" ? src.wholeWord : DEFAULT_FIND_OPTIONS.wholeWord,
        groupResults: typeof src.groupResults === "boolean" ? src.groupResults && !savedRemovedTopLevel : DEFAULT_FIND_OPTIONS.groupResults,
        headingGroupLevel: normalizeHeadingGroupLevel2(src.headingGroupLevel),
        showResultHeadings: typeof src.showResultHeadings === "boolean" ? src.showResultHeadings : DEFAULT_FIND_OPTIONS.showResultHeadings
      };
    }
    module2.exports = {
      normalizeHeadingGroupLevel: normalizeHeadingGroupLevel2,
      headingLevelLabel,
      headingLevelMenuLabel,
      normalizeFindOptions: normalizeFindOptions2
    };
  }
});

// src/utils.js
var require_utils = __commonJS({
  "src/utils.js"(exports2, module2) {
    "use strict";
    var { DEBUG } = require_constants();
    function debugWarn2(where, err) {
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
    module2.exports = { debugWarn: debugWarn2, debounce };
  }
});

// src/matcher.js
var require_matcher = __commonJS({
  "src/matcher.js"(exports2, module2) {
    "use strict";
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
    function findAll2(text, matcher) {
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
    module2.exports = {
      normalizePlainQuery,
      buildMatcher,
      findAll: findAll2
    };
  }
});

// src/source-search.js
var require_source_search = __commonJS({
  "src/source-search.js"(exports2, module2) {
    "use strict";
    var { findAll: findAll2 } = require_matcher();
    function findSourceMatches(lines, matcher) {
      const res = [];
      if (!matcher || matcher.invalid) return res;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const mt of findAll2(line, matcher)) {
          res.push({ line: i, ch: mt.index, len: mt.length, lineText: line });
        }
      }
      return res;
    }
    module2.exports = { findSourceMatches };
  }
});

// src/view.js
var require_view = __commonJS({
  "src/view.js"(exports2, module2) {
    "use strict";
    var { SELECTORS } = require_constants();
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
    module2.exports = {
      getRenderRoot,
      isLivePreviewMode,
      getScroller,
      getEditorView
    };
  }
});

// src/dom-highlights.js
var require_dom_highlights = __commonJS({
  "src/dom-highlights.js"(exports2, module2) {
    "use strict";
    var { findAll: findAll2 } = require_matcher();
    var { debugWarn: debugWarn2 } = require_utils();
    function findRenderedMatches(root, matcher) {
      const matches = [];
      if (!root || !matcher || matcher.invalid) return matches;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node2) {
          if (!node2.nodeValue || !node2.nodeValue.trim())
            return NodeFilter.FILTER_REJECT;
          const tag = node2.parentElement && node2.parentElement.tagName;
          if (tag === "SCRIPT" || tag === "STYLE") return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      let node;
      while (node = walker.nextNode()) {
        const text = node.nodeValue;
        for (const mt of findAll2(text, matcher)) {
          const range = document.createRange();
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
    function rangeCenterY(range) {
      try {
        if (!range) return null;
        const rect = range.getBoundingClientRect();
        if (!Number.isFinite(rect.top) || !Number.isFinite(rect.bottom)) return null;
        return (rect.top + rect.bottom) / 2;
      } catch (e) {
        debugWarn2("rangeCenterY", e);
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
        debugWarn2("viewportCenterY", e);
        return null;
      }
    }
    function limitDomHighlightsAroundCurrent(dom, currentRange, max, scroller) {
      if (!Array.isArray(dom) || !dom.length) return [];
      const n = Number(max);
      if (!Number.isFinite(n) || n <= 0 || dom.length <= n) return dom;
      const centerY = rangeCenterY(currentRange) ?? viewportCenterY(scroller);
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
    module2.exports = {
      findRenderedMatches,
      limitDomHighlightsAroundCurrent
    };
  }
});

// src/tables.js
var require_tables = __commonJS({
  "src/tables.js"(exports2, module2) {
    "use strict";
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
    module2.exports = {
      isTableRow,
      isDelimiterRow,
      parseCells,
      locateInTables,
      cellInfoForMatch,
      tableDataCells,
      tableBlockForLine
    };
  }
});

// src/markdown.js
var require_markdown = __commonJS({
  "src/markdown.js"(exports2, module2) {
    "use strict";
    var { isTableRow, parseCells } = require_tables();
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
    function parseHeading(line, lineIdx) {
      const m = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line || "");
      if (!m) return null;
      return { level: m[1].length, text: m[2], line: lineIdx };
    }
    function nearestHeading(lines, lineIdx, maxLevel = 6) {
      for (let i = lineIdx; i >= 0; i--) {
        const heading = parseHeading(lines[i], i);
        if (heading && heading.level <= maxLevel) return heading;
      }
      return null;
    }
    function cleanHeadingText(text) {
      return (text || "").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
    }
    function headingGroupForLine(lines, lineIdx, maxLevel) {
      const heading = nearestHeading(lines, lineIdx, maxLevel);
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
    module2.exports = {
      hiddenSpansInReading,
      isInsideSpan,
      previousCellOf,
      nearestHeading,
      cleanHeadingText,
      headingGroupForLine,
      headingGroupKey,
      cleanSnippet,
      visibleInlineText
    };
  }
});

// src/snippets.js
var require_snippets = __commonJS({
  "src/snippets.js"(exports2, module2) {
    "use strict";
    var { findAll: findAll2 } = require_matcher();
    var {
      cellInfoForMatch,
      locateInTables,
      tableBlockForLine,
      tableDataCells
    } = require_tables();
    var {
      cleanSnippet,
      hiddenSpansInReading,
      isInsideSpan,
      visibleInlineText
    } = require_markdown();
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
        display = (s > 0 ? "\xE2\u20AC\xA6" : "") + full.slice(s, e) + (e < full.length ? "\xE2\u20AC\xA6" : "");
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
    function buildTableSnippetData(m, lines, matcher) {
      const loc = locateInTables(lines, m.line);
      if (!loc || loc.kind !== "body" && loc.kind !== "header") return null;
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
      const sourceOffsetInCell = Math.max(0, m.ch - cell.start);
      const visibleBefore = normalizeSnippetPart(cell.text.slice(0, sourceOffsetInCell));
      const visibleK = findAll2(visibleBefore, matcher).length;
      const cellMatches = findAll2(displayCell, matcher);
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
    function buildLineSnippetData(m, matcher, domMode) {
      const source = domMode ? cleanSnippet(m.lineText) : m.lineText;
      if (!source) return null;
      let hitIdx;
      let hitLen;
      if (domMode) {
        const spans = hiddenSpansInReading(m.lineText);
        let kInLine = 0;
        for (const mt of findAll2(m.lineText.slice(0, m.ch), matcher)) {
          if (!isInsideSpan(mt.index, spans)) kInLine++;
        }
        const all = findAll2(source, matcher);
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
      return buildTableSnippetData(m, lines, matcher) || buildLineSnippetData(m, matcher, domMode);
    }
    module2.exports = {
      appendHighlightedSnippet,
      buildSnippetData
    };
  }
});

// src/positioning.js
var require_positioning = __commonJS({
  "src/positioning.js"(exports2, module2) {
    "use strict";
    var { findAll: findAll2 } = require_matcher();
    var { debugWarn: debugWarn2 } = require_utils();
    var {
      cellInfoForMatch,
      isDelimiterRow,
      locateInTables
    } = require_tables();
    var { cleanSnippet, hiddenSpansInReading, isInsideSpan } = require_markdown();
    function findKthOccurrenceRange(el, matcher, k) {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node;
      let count = 0;
      while (node = walker.nextNode()) {
        for (const mt of findAll2(node.nodeValue, matcher)) {
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
        const all = findAll2(node.nodeValue, matcher);
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
        debugWarn2("resolveByDomAtPos", e);
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
        debugWarn2("tableFromDomAtPos", e);
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
        debugWarn2("tableFromPoint", e);
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
        debugWarn2("resolveTableByPoint", e);
        return null;
      }
    }
    function resolveReadingCurrentRange(root, lines, m, matcher, scroller) {
      try {
        if (!root) return null;
        const line = lines[m.line] || "";
        const spans = hiddenSpansInReading(line);
        let kInLine = 0;
        for (const mt of findAll2(line.slice(0, m.ch), matcher)) {
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
        debugWarn2("resolveReadingCurrentRange", e);
        return null;
      }
    }
    module2.exports = {
      resolveByDomAtPos,
      resolveTableByPoint,
      resolveReadingCurrentRange
    };
  }
});

// src/find-bar.js
var require_find_bar = __commonJS({
  "src/find-bar.js"(exports2, module2) {
    "use strict";
    var { MarkdownView: MarkdownView2, Menu, setIcon } = require("obsidian");
    var {
      DEBOUNCE_MS,
      DEFAULT_FIND_OPTIONS,
      HL_ALL: HL_ALL2,
      HL_CURRENT: HL_CURRENT2,
      MAX_DOM_HIGHLIGHTS
    } = require_constants();
    var { headingLevelLabel, headingLevelMenuLabel } = require_options();
    var { debugWarn: debugWarn2, debounce } = require_utils();
    var { buildMatcher, normalizePlainQuery } = require_matcher();
    var { findSourceMatches } = require_source_search();
    var { getEditorView, getRenderRoot, getScroller, isLivePreviewMode } = require_view();
    var { findRenderedMatches, limitDomHighlightsAroundCurrent } = require_dom_highlights();
    var { isDelimiterRow, locateInTables } = require_tables();
    var {
      cleanHeadingText,
      cleanSnippet,
      headingGroupForLine,
      headingGroupKey,
      hiddenSpansInReading,
      isInsideSpan,
      nearestHeading
    } = require_markdown();
    var { appendHighlightedSnippet, buildSnippetData } = require_snippets();
    var {
      resolveByDomAtPos,
      resolveReadingCurrentRange,
      resolveTableByPoint
    } = require_positioning();
    var FindBar2 = class {
      constructor(plugin, view) {
        this.plugin = plugin;
        this.view = view;
        this.editor = view.editor;
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
        this.domMode = false;
        this.renderedTextMode = false;
        this.currentDomRange = null;
        this.highlightToken = 0;
        this.barEl = null;
        this.resultsEl = null;
      }
      isOpen() {
        return !!this.barEl;
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
      syncToggleButtons() {
        if (this.caseBtn) this.caseBtn.toggleClass("is-on", this.caseSensitive);
        if (this.regexBtn) this.regexBtn.toggleClass("is-on", this.useRegex);
        if (this.wordBtn) this.wordBtn.toggleClass("is-on", this.wholeWord);
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
            showResultHeadings: this.showResultHeadings
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
        const menu = new Menu();
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
        this.groupBtn = bar.createEl("button", { cls: "lf-btn lf-toggle lf-heading-toggle", text: "H-" });
        this.groupBtn.title = "Group results by heading";
        this.syncToggleButtons();
        this.countEl = bar.createSpan({ cls: "lf-count", text: "" });
        this.sepEl = bar.createDiv({ cls: "lf-sep" });
        const prev = bar.createEl("button", { cls: "lf-btn" });
        const next = bar.createEl("button", { cls: "lf-btn" });
        const close = bar.createEl("button", { cls: "lf-btn" });
        setIcon(prev, "chevron-up");
        setIcon(next, "chevron-down");
        setIcon(close, "x");
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
        this.groupBtn.onclick = (evt) => this.showHeadingGroupMenu(evt);
        this.resultsEl = host.createDiv({ cls: "lf-results" });
        this.resultsEl.style.display = "none";
        this.updateCount();
        this.onInput = debounce(
          () => this.search(this.input.value),
          DEBOUNCE_MS
        );
        this.input.addEventListener("input", this.onInput);
        this.onPaste = (e) => {
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
          const start = this.input.selectionStart ?? this.input.value.length;
          const end = this.input.selectionEnd ?? start;
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
        this.onScroll = debounce(
          () => this.refreshHighlights(),
          DEBOUNCE_MS
        );
        this.updateScroller();
        this.lastViewMode = this.view.getMode();
        this.layoutEvt = this.plugin.app.workspace.on("layout-change", () => {
          if (!this.barEl) return;
          const mode = this.view.getMode();
          if (mode === this.lastViewMode) return;
          this.lastViewMode = mode;
          this.updateScroller();
          this.refreshCurrentSearch();
        });
        this.onEditorChange = debounce(() => {
          if (!this.barEl) return;
          const active = this.plugin.app.workspace.getActiveViewOfType(MarkdownView2);
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
          debugWarn2("read initial selection", e);
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
        this.onEditorChange = null;
        this.matches = [];
        this.current = -1;
        this.query = "";
        this.matcher = null;
      }
      clearHighlights() {
        if (window.CSS && CSS.highlights) {
          CSS.highlights.delete(HL_ALL2);
          CSS.highlights.delete(HL_CURRENT2);
        }
      }
      domApply(dom, currentRange) {
        CSS.highlights.set(HL_ALL2, new Highlight(...dom.map((d) => d.range)));
        if (currentRange) {
          const hl = new Highlight(currentRange);
          hl.priority = 1;
          CSS.highlights.set(HL_CURRENT2, hl);
        } else {
          CSS.highlights.delete(HL_CURRENT2);
        }
      }
      refreshHighlights(token = this.highlightToken) {
        if (token !== this.highlightToken) return;
        if (!this.barEl) return;
        if (!(window.CSS && CSS.highlights && window.Highlight)) return;
        if (!this.query || !this.matcher || this.matcher.invalid)
          return this.clearHighlights();
        if (this.domMode) {
          const root2 = getRenderRoot(this.view);
          const m2 = this.matches[this.current];
          const scroller2 = getScroller(this.view);
          let cur = m2 ? resolveReadingCurrentRange(root2, this.docLines, m2, this.matcher, scroller2) : null;
          if (!cur && this.currentDomRange && this.currentDomRange.startContainer && this.currentDomRange.startContainer.isConnected)
            cur = this.currentDomRange;
          let dom2 = findRenderedMatches(root2, this.matcher);
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
            debugWarn2("posToOffset", e);
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
                debugWarn2("coordsAtPos fallback", e);
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
        if (!dom) dom = findRenderedMatches(root, this.matcher);
        dom = limitDomHighlightsAroundCurrent(
          dom,
          currentRange,
          MAX_DOM_HIGHLIGHTS,
          scroller
        );
        this.domApply(dom, currentRange);
      }
      search(query, options = {}) {
        if (!this.barEl || !this.resultsEl) return;
        const previousCurrent = this.current;
        const previousMatch = options.preserveCurrent ? this.matches[previousCurrent] : null;
        const shouldJump = options.jump !== false;
        const effectiveQuery = this.useRegex ? query : normalizePlainQuery(query);
        this.query = effectiveQuery;
        this.matcher = buildMatcher(effectiveQuery, this.caseSensitive, this.useRegex, this.wholeWord);
        this.domMode = this.view.getMode() === "preview";
        this.renderedTextMode = this.domMode || isLivePreviewMode(this.view);
        const text = this.editor.getValue();
        this.docLines = text.split("\n");
        this.matches = findSourceMatches(this.docLines, this.matcher);
        this.matchGroupInfo = null;
        if (this.renderedTextMode && this.matches.length) {
          const cache = /* @__PURE__ */ new Map();
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
        this.current = this.matches.length ? options.preserveCurrent ? this.closestMatchIndex(previousMatch, previousCurrent) : 0 : -1;
        this.currentDomRange = null;
        this.renderList();
        this.updateCount();
        const token = this.nextHighlightToken();
        if (this.current >= 0 && shouldJump) this.jumpToCurrent(token);
        else if (this.current >= 0) this.refreshHighlights(token);
        else this.clearHighlights();
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
            if (pm && typeof pm.applyScroll === "function") pm.applyScroll(m.line);
          } catch (e) {
            debugWarn2("applyScroll", e);
          }
          this.currentDomRange = null;
          this.refreshHighlights(token);
          setTimeout(() => this.refreshHighlights(token), 90);
          setTimeout(() => this.refreshHighlights(token), 220);
          return;
        }
        const from = { line: m.line, ch: m.ch };
        const to = { line: m.line, ch: m.ch + m.len };
        try {
          this.editor.scrollIntoView({ from, to }, true);
        } catch (e) {
          debugWarn2("scrollIntoView", e);
        }
        this.refreshHighlights(token);
        setTimeout(() => this.refreshHighlights(token), 60);
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
          (m) => headingGroupForLine(this.docLines || [], m.line, groupLevel)
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
        if (!el) return;
        el.empty();
        if (!this.query || !this.matches.length) {
          el.style.display = "none";
          return;
        }
        el.style.display = "block";
        const groupInfo = this.getMatchGroupInfo();
        let lastGroupKey = null;
        this.matches.forEach((m, i) => {
          const groupItem = groupInfo ? groupInfo.items[i] : null;
          const group = groupItem ? groupItem.group : null;
          if (groupItem) {
            if (groupItem.key !== lastGroupKey) {
              lastGroupKey = groupItem.key;
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
          }
          const row = el.createDiv({ cls: "lf-row" });
          row.dataset.matchIndex = String(i);
          if (i === this.current) row.addClass("is-active");
          const head = this.showResultHeadings ? nearestHeading(this.docLines, m.line) : null;
          if (head) row.addClass("has-head");
          const main = row.createDiv({ cls: "lf-main" });
          main.createSpan({ cls: "lf-line", text: `Line ${m.line + 1}` });
          const sn = main.createSpan({ cls: "lf-snippet" });
          const snippet = buildSnippetData(
            m,
            this.docLines || [],
            this.matcher,
            this.renderedTextMode
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
        });
        this.updateGroupCounts();
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
      markActiveRow() {
        if (!this.resultsEl) return;
        const rows = this.resultsEl.querySelectorAll(".lf-row");
        for (const row of rows) {
          const i = Number(row.dataset.matchIndex);
          const active = i === this.current;
          row.toggleClass("is-active", active);
          if (active) row.scrollIntoView({ block: "nearest" });
        }
        this.updateGroupCounts();
      }
    };
    module2.exports = { FindBar: FindBar2 };
  }
});

// src/plugin.js
var { Plugin, MarkdownView, Notice } = require("obsidian");
var { HL_ALL, HL_CURRENT } = require_constants();
var { normalizeFindOptions } = require_options();
var { debugWarn } = require_utils();
var { FindBar } = require_find_bar();
module.exports = class LiveFindPlugin extends Plugin {
  async onload() {
    await this.loadPluginData();
    this.bar = null;
    this.addCommand({
      id: "open-find-bar",
      name: "Open find bar",
      callback: () => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return new Notice("Open a Markdown note first.");
        if (!(window.CSS && CSS.highlights && window.Highlight))
          return new Notice("This Obsidian version lacks the CSS Highlight API.");
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
    if (window.CSS && CSS.highlights) {
      CSS.highlights.delete(HL_ALL);
      CSS.highlights.delete(HL_CURRENT);
    }
  }
};
