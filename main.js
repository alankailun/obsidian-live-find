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
    for (const mt of findAll(node.nodeValue, matcher)) {
      const range = document.createRange();
      range.setStart(node, mt.index);
      range.setEnd(node, mt.index + mt.length);
      matches.push({ range });
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
    this.clearHighlights();
    if (this.barEl) this.barEl.remove();
    if (this.resultsEl) this.resultsEl.remove();
    this.barEl = null;
    this.resultsEl = null;
    this.matches = [];
    this.current = -1;
  }

  clearHighlights() {
    if (window.CSS && CSS.highlights) {
      CSS.highlights.delete(HL_ALL);
      CSS.highlights.delete(HL_CURRENT);
    }
  }

  refreshHighlights() {
    if (!(window.CSS && CSS.highlights && window.Highlight)) return;
    if (!this.query || !this.matcher || this.matcher.invalid)
      return this.clearHighlights();
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
    const text = this.editor.getValue();
    this.docLines = text.split("\n");
    this.matcher = buildMatcher(query, this.caseSensitive, this.useRegex);
    this.matches = findSourceMatches(this.docLines, this.matcher);
    this.current = this.matches.length ? 0 : -1;
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
      row.createSpan({ cls: "tf-line", text: `行 ${m.line + 1}` });
      const sn = row.createSpan({ cls: "tf-snippet" });

      // Context window around the match, with the hit bolded.
      const s = Math.max(0, m.ch - 24);
      const e = Math.min(m.lineText.length, m.ch + m.len + 60);
      let before = m.lineText.slice(s, m.ch);
      const hit = m.lineText.slice(m.ch, m.ch + m.len);
      const after = m.lineText.slice(m.ch + m.len, e);
      if (s === 0) before = before.replace(/^\s+/, "");
      if (s > 0) sn.appendText("…");
      sn.appendText(before);
      sn.createEl("strong", { text: hit });
      sn.appendText(after);
      if (e < m.lineText.length) sn.appendText("…");

      row.onclick = () => {
        this.current = i;
        this.jumpToCurrent();
        this.updateCount();
        this.markActiveRow();
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
        display: flex; align-items: baseline; gap: 6px;
        padding: 5px 8px; cursor: pointer; border-radius: 6px; font-size: 13px;
        white-space: nowrap; overflow: hidden;
      }
      .tf-results .tf-snippet { overflow: hidden; text-overflow: ellipsis; }
      .tf-results .tf-snippet strong { color: var(--text-accent); }
      .tf-results .tf-row:hover { background: var(--background-modifier-hover); }
      .tf-results .tf-row.is-active {
        background: var(--background-modifier-active-hover, var(--background-modifier-hover));
      }
      .tf-results .tf-line {
        color: var(--text-faint); flex: 0 0 auto;
        font-variant-numeric: tabular-nums;
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
