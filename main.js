"use strict";

const { Plugin, MarkdownView, Notice, setIcon } = require("obsidian");

const HL_ALL = "table-finder-all";
const HL_CURRENT = "table-finder-current";

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* ----------------------------- matching engine ----------------------------- */

/** Build a matcher from query + flags. Returns null if no query. */
function buildMatcher(query, caseSensitive, useRegex) {
  if (!query) return null;
  if (useRegex) {
    try {
      return { regex: new RegExp(query, "g" + (caseSensitive ? "" : "i")) };
    } catch (e) {
      return { invalid: true };
    }
  }
  return { needle: caseSensitive ? query : query.toLowerCase(), caseSensitive };
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
      out.push({ index: m.index, length: m[0].length });
    }
  } else {
    const hay = matcher.caseSensitive ? text : text.toLowerCase();
    const n = matcher.needle;
    let from = 0;
    while (true) {
      const i = hay.indexOf(n, from);
      if (i === -1) break;
      out.push({ index: i, length: n.length });
      from = i + n.length;
    }
  }
  return out;
}

/* ----------------------------- view helpers ----------------------------- */

function getRenderRoot(view) {
  const mode = view.getMode();
  if (mode === "preview") {
    return view.containerEl.querySelector(
      ".markdown-reading-view, .markdown-preview-view"
    );
  }
  return view.containerEl.querySelector(".cm-content");
}

function getScroller(view) {
  return view.containerEl.querySelector(".cm-scroller, .markdown-preview-view");
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

/* ----------------------------- table cell mapping ----------------------------- */

function isTableRow(line) {
  return line.trim().startsWith("|");
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
    tableIdx++;
    const blockStart = i;
    let j = i;
    while (j < lines.length && isTableRow(lines[j])) j++;
    if (lineIdx >= blockStart && lineIdx < j) {
      const offset = lineIdx - blockStart;
      let delimOffset = -1;
      for (let k = blockStart; k < j; k++) {
        if (isDelimiterRow(lines[k])) {
          delimOffset = k - blockStart;
          break;
        }
      }
      if (offset === 0) return { tableIdx, kind: "header" };
      if (offset === delimOffset) return { tableIdx, kind: "delim" };
      const bodyRowIdx = offset - (delimOffset >= 0 ? delimOffset + 1 : 1);
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
    return null;
  }
}

function resolveTableByPoint(cm, off, lines, m, matcher) {
  try {
    if (!cm || typeof cm.coordsAtPos !== "function") return null;
    const coords = cm.coordsAtPos(off);
    if (!coords) return null;
    const y = (coords.top + coords.bottom) / 2;
    let tableEl = null;
    for (const x of [coords.left + 1, coords.left + 20, 120, window.innerWidth / 2]) {
      const el = document.elementFromPoint(x, y);
      const t = el && el.closest && el.closest("table");
      if (t) {
        tableEl = t;
        break;
      }
    }
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

/**
 * Source-level ranges occupied by Markdown image syntax on a line:
 *   ![[path.png]]   (Obsidian wikilink embed, optionally |size)
 *   ![alt](path)    (standard image)
 * Used in reading mode to drop matches that fall inside an image, since the
 * rendered preview shows an <img>, not the link text.
 */
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
    .replace(/^[\s>#*+\-]+/, "")
    .replace(/[*_`]/g, "")
    .replace(/\|/g, " ")
    .replace(/[│├└─]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Reading mode: map a source match to its exact rendered range by content.
 * Find the rendered element (table row / heading / paragraph / list item) whose
 * full text equals the source line, then take the k-th query occurrence in it
 * (k = occurrences before the match within the same source line). Robust to
 * virtualization and duplicate cells (ordering is within one line).
 */
function resolveReadingCurrentRange(root, lines, m, matcher) {
  try {
    if (!root) return null;
    const line = lines[m.line] || "";
    // Images render as <img>, not text — so they're absent from textContent.
    // Count only non-image preceding matches to align with what's in the DOM.
    const spans = imageSpansIn(line);
    let kInLine = 0;
    for (const mt of findAll(line.slice(0, m.ch), matcher)) {
      if (!isInsideSpan(mt.index, spans)) kInLine++;
    }
    const want = cleanSnippet(line).replace(/\s+/g, "").toLowerCase();
    if (!want) return null;
    const els = root.querySelectorAll(
      "tr, p, li, h1, h2, h3, h4, h5, h6, dd, dt, td, th, blockquote"
    );
    for (const el of els) {
      const got = (el.textContent || "").replace(/\s+/g, "").toLowerCase();
      if (got === want) {
        const r = findKthOccurrenceRange(el, matcher, kInLine);
        if (r) return r;
      }
    }
    return null;
  } catch (e) {
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
    this.domMode = false; // reading mode: jump via applyScroll, highlight on DOM
    this.currentDomRange = null; // anchored current range in reading mode
    this.barEl = null;
    this.resultsEl = null;
  }

  isOpen() {
    return !!this.barEl;
  }

  open() {
    if (this.barEl) {
      this.input.focus();
      this.input.select();
      return;
    }
    const host = this.view.containerEl;

    const bar = host.createDiv({ cls: "tf-find-bar" });
    this.barEl = bar;
    this.input = bar.createEl("input", {
      cls: "tf-input",
      type: "text",
      placeholder: "Find in note…",
    });

    this.caseBtn = bar.createEl("button", { cls: "tf-btn tf-toggle", text: "Aa" });
    this.caseBtn.title = "Match case";
    this.regexBtn = bar.createEl("button", { cls: "tf-btn tf-toggle", text: ".*" });
    this.regexBtn.title = "Use regular expression";

    this.countEl = bar.createSpan({ cls: "tf-count", text: "" });
    this.sepEl = bar.createDiv({ cls: "tf-sep" });
    const prev = bar.createEl("button", { cls: "tf-btn" });
    const next = bar.createEl("button", { cls: "tf-btn" });
    const close = bar.createEl("button", { cls: "tf-btn" });
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

    this.resultsEl = host.createDiv({ cls: "tf-results" });
    this.resultsEl.style.display = "none";
    this.updateCount(); // collapse the empty count/separator on open

    this.onInput = debounce(() => this.search(this.input.value), 100);
    this.input.addEventListener("input", this.onInput);
    this.input.addEventListener("keydown", (e) => {
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
    });

    this.scroller = getScroller(this.view);
    this.onScroll = debounce(() => this.refreshHighlights(), 100);
    if (this.scroller)
      this.scroller.addEventListener("scroll", this.onScroll, { passive: true });

    // Re-run search when the user toggles Source / Live Preview / Reading
    // inside the same tab, so domMode, highlights and snippets stay accurate.
    this.lastViewMode = this.view.getMode();
    this.layoutEvt = this.plugin.app.workspace.on("layout-change", () => {
      if (!this.barEl) return;
      const mode = this.view.getMode();
      if (mode === this.lastViewMode) return;
      this.lastViewMode = mode;
      this.scroller = getScroller(this.view);
      if (this.query) this.search(this.query);
      else this.clearHighlights();
    });
    this.plugin.registerEvent(this.layoutEvt);

    // Prefill from the current selection, like a browser / editor find.
    let initial = "";
    try {
      const sel = this.editor.getSelection();
      if (sel && !sel.includes("\n")) initial = sel;
    } catch (e) {}
    if (initial) {
      this.input.value = initial;
      this.search(initial);
    }
    setTimeout(() => {
      this.input.focus();
      this.input.select();
    }, 0);
  }

  close() {
    if (this.scroller && this.onScroll)
      this.scroller.removeEventListener("scroll", this.onScroll);
    if (this.layoutEvt) this.plugin.app.workspace.offref(this.layoutEvt);
    this.layoutEvt = null;
    this.clearHighlights();
    if (this.barEl) this.barEl.remove();
    if (this.resultsEl) this.resultsEl.remove();
    this.barEl = null;
    this.resultsEl = null;
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
    // cells). Falls back to the kept range, then nearest-to-top.
    if (this.domMode) {
      const root = getRenderRoot(this.view);
      const dom = findRenderedMatches(root, this.matcher);
      const m = this.matches[this.current];
      let cur = m
        ? resolveReadingCurrentRange(root, this.docLines, m, this.matcher)
        : null;
      if (
        !cur &&
        this.currentDomRange &&
        this.currentDomRange.startContainer &&
        this.currentDomRange.startContainer.isConnected
      )
        cur = this.currentDomRange;
      if (!cur && dom.length) {
        const scroller = getScroller(this.view);
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
      this.domApply(dom, cur);
      return;
    }

    const root = getRenderRoot(this.view);
    const dom = findRenderedMatches(root, this.matcher);
    CSS.highlights.set(HL_ALL, new Highlight(...dom.map((d) => d.range)));

    let currentRange = null;
    const m = this.matches[this.current];
    const lines = this.docLines || [];
    if (m) {
      const line = lines[m.line] || "";
      const isTable = isTableRow(line) && !isDelimiterRow(line);
      const cm = this.editor.cm;
      let off = null;
      try {
        off = this.editor.posToOffset({ line: m.line, ch: m.ch });
      } catch (e) {}

      if (off != null && cm) {
        if (isTable)
          currentRange = resolveTableByPoint(cm, off, lines, m, this.matcher);
        if (!currentRange) currentRange = resolveByDomAtPos(cm, off, this.matcher);
        if (!currentRange && dom.length) {
          let coords = null;
          try {
            if (typeof cm.coordsAtPos === "function") coords = cm.coordsAtPos(off);
          } catch (e) {}
          if (coords) {
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
    if (currentRange) {
      const hl = new Highlight(currentRange);
      hl.priority = 1;
      CSS.highlights.set(HL_CURRENT, hl);
    } else {
      CSS.highlights.delete(HL_CURRENT);
    }
  }

  search(query) {
    this.query = query;
    this.matcher = buildMatcher(query, this.caseSensitive, this.useRegex);
    this.domMode = this.view.getMode() === "preview";
    // Both modes: complete whole-note search from the source.
    const text = this.editor.getValue();
    this.docLines = text.split("\n");
    this.matches = findSourceMatches(this.docLines, this.matcher);
    // Reading mode: image links render as <img>, so their alt/path text isn't
    // visible — drop matches that fall inside Markdown image syntax.
    if (this.domMode && this.matches.length) {
      const cache = new Map();
      this.matches = this.matches.filter((m) => {
        let spans = cache.get(m.line);
        if (!spans) {
          spans = imageSpansIn(this.docLines[m.line] || "");
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
      } catch (e) {}
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
    } catch (e) {}
    this.refreshHighlights();
    setTimeout(() => this.refreshHighlights(), 60);
  }

  updateCount() {
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
      this.countEl.setText("regex?");
      this.countEl.addClass("is-empty");
      return;
    }
    if (!this.matches.length) {
      this.countEl.setText("0/0");
      this.countEl.addClass("is-empty");
      return;
    }
    this.countEl.removeClass("is-empty");
    this.countEl.setText(`${this.current + 1}/${this.matches.length}`);
  }

  renderList() {
    const el = this.resultsEl;
    el.empty();
    if (!this.query || !this.matches.length) {
      el.style.display = "none";
      return;
    }
    el.style.display = "block";
    this.matches.forEach((m, i) => {
      const row = el.createDiv({ cls: "tf-row" });
      if (i === this.current) row.addClass("is-active");

      // Second line: nearest heading above this match (always on).
      const head = nearestHeading(this.docLines, m.line);
      if (head) row.addClass("has-head");

      const main = row.createDiv({ cls: "tf-main" });
      main.createSpan({ cls: "tf-line", text: `行 ${m.line + 1}` });
      const sn = main.createSpan({ cls: "tf-snippet" });

      // Both modes: snippet starts at the *word boundary before this exact hit*
      // so a hit inside "Involuntary" reads "Involuntary…" not "voluntary…".
      const source = this.domMode ? cleanSnippet(m.lineText) : m.lineText;
      // In reading mode the source line is cleaned, so locate the same hit in
      // the cleaned text by occurrence index within the line.
      let hitIdx, hitLen;
      if (this.domMode) {
        // Count matches BEFORE this one within the same line, skipping any
        // inside image syntax (cleanSnippet strips them out of `source`, so
        // the cleaned-source indexing must agree).
        const spans = imageSpansIn(m.lineText);
        let kInLine = 0;
        for (const mt of findAll(m.lineText.slice(0, m.ch), this.matcher)) {
          if (!isInsideSpan(mt.index, spans)) kInLine++;
        }
        const all = findAll(source, this.matcher);
        const pick = all[kInLine] || all[0];
        if (!pick) {
          sn.appendText(source.slice(0, 100));
          row.onclick = () => {
            this.current = i;
            this.jumpToCurrent();
            this.updateCount();
            this.markActiveRow();
          };
          return;
        }
        hitIdx = pick.index;
        hitLen = pick.length;
      } else {
        hitIdx = m.ch;
        hitLen = m.len;
      }

      // A: for table-row hits, prepend the previous cell as a semantic anchor
      // (e.g. column label) so duplicate cells in the list are distinguishable.
      const prevCell = previousCellOf(m.lineText, m.ch);
      if (prevCell) {
        sn.createSpan({ cls: "tf-col", text: prevCell + "·" });
      }

      // Snippet starts at the word containing the hit. Only when the hit IS the
      // whole word (inWord == 0, e.g. "Cavity" matching "Cavity") do we extend
      // backward for more context like "Ventral Cavity". When the hit sits
      // inside a longer word ("voluntary" inside "Involuntary"), the word
      // itself is already enough context — extending would walk past it into a
      // neighboring match.
      let s = wordStartBefore(source, hitIdx);
      if (hitIdx - s === 0) s = extendPrefixWords(source, s, 2);
      const e = Math.min(source.length, hitIdx + hitLen + 80);
      const win = source.slice(s, e);
      if (s > 0) sn.appendText("…");
      // Bold only the hit this entry represents — other matches that happen to
      // fall in the same window are left as plain text so the user can tell
      // which match a row stands for.
      const ls = hitIdx - s;
      const le = ls + hitLen;
      if (ls > 0) sn.appendText(win.slice(0, ls));
      sn.createEl("strong", { text: win.slice(ls, le) });
      if (le < win.length) sn.appendText(win.slice(le));
      if (e < source.length) sn.appendText("…");

      if (head) {
        const clean = head.text.replace(/[*_`]/g, "").trim();
        row.createDiv({ cls: "tf-head" }).setText(clean);
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
      .tf-find-bar {
        position: absolute; top: 10px; right: 18px;
        z-index: var(--layer-popover, 30);
        display: flex; align-items: center; gap: 2px;
        background: var(--background-primary);
        border: 1px solid var(--background-modifier-border);
        border-radius: 10px; padding: 5px 8px;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18);
      }
      .tf-find-bar .tf-input {
        border: none !important; background: transparent !important;
        box-shadow: none !important; color: var(--text-normal);
        outline: none; width: 200px; font-size: 14px; padding: 2px 4px; margin: 0;
      }
      .tf-find-bar .tf-count {
        font-size: 12px; color: var(--text-muted);
        min-width: 46px; text-align: right; padding: 0 4px;
        font-variant-numeric: tabular-nums; white-space: nowrap;
      }
      .tf-find-bar .tf-count.is-empty { color: var(--text-error); }
      .tf-find-bar .tf-sep {
        width: 1px; height: 18px; margin: 0 4px;
        background: var(--background-modifier-border);
      }
      .tf-find-bar .tf-btn {
        display: flex; align-items: center; justify-content: center;
        width: 26px; height: 26px; padding: 0;
        background: transparent !important; border: none !important;
        box-shadow: none !important; cursor: pointer;
        border-radius: 6px; color: var(--text-muted);
      }
      .tf-find-bar .tf-btn:hover {
        background: var(--background-modifier-hover) !important;
        color: var(--text-normal);
      }
      .tf-find-bar .tf-btn svg { width: 16px; height: 16px; }
      .tf-find-bar .tf-toggle {
        width: auto; min-width: 26px; padding: 0 6px;
        font-size: 11px; font-weight: 600;
      }
      .tf-find-bar .tf-toggle.is-on {
        background: var(--interactive-accent) !important;
        color: var(--text-on-accent) !important;
      }
      .tf-results {
        position: absolute; top: 50px; right: 18px;
        z-index: var(--layer-popover, 30);
        width: 340px; max-height: 320px; overflow-y: auto;
        background: var(--background-primary);
        border: 1px solid var(--background-modifier-border);
        border-radius: 10px;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18); padding: 4px;
      }
      .tf-results .tf-row {
        display: flex; flex-direction: column; gap: 2px;
        padding: 5px 8px; cursor: pointer; border-radius: 6px; font-size: 13px;
      }
      .tf-results .tf-main {
        display: flex; align-items: baseline; gap: 6px;
        white-space: nowrap; overflow: hidden;
      }
      .tf-results .tf-snippet { overflow: hidden; text-overflow: ellipsis; }
      .tf-results .tf-snippet strong { color: var(--text-accent); }
      .tf-results .tf-col {
        color: var(--text-muted); margin-right: 2px;
      }
      .tf-results .tf-row:hover { background: var(--background-modifier-hover); }
      .tf-results .tf-row.is-active {
        background: var(--background-modifier-active-hover, var(--background-modifier-hover));
      }
      .tf-results .tf-line {
        color: var(--text-faint); flex: 0 0 auto;
        font-variant-numeric: tabular-nums;
      }
      .tf-results .tf-head {
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
