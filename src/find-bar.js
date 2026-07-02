"use strict";

const { MarkdownView, Menu, setIcon } = require("obsidian");
const {
  DEBOUNCE_MS,
  DEFAULT_FIND_OPTIONS,
  HL_ALL,
  HL_CURRENT,
  MAX_DOM_HIGHLIGHTS,
} = require("./constants");
const { headingLevelLabel, headingLevelMenuLabel } = require("./options");
const { debugWarn, debounce } = require("./utils");
const { buildMatcher, normalizePlainQuery } = require("./matcher");
const { findSourceMatches } = require("./source-search");
const { getEditorView, getRenderRoot, getScroller, isLivePreviewMode } = require("./view");
const { findRenderedMatches, limitDomHighlightsAroundCurrent } = require("./dom-highlights");
const { isDelimiterRow, locateInTables } = require("./tables");
const {
  cleanHeadingText,
  cleanSnippet,
  headingGroupForLine,
  headingGroupKey,
  hiddenSpansInReading,
  isInsideSpan,
  nearestHeading,
} = require("./markdown");
const { appendHighlightedSnippet, buildSnippetData } = require("./snippets");
const {
  resolveByDomAtPos,
  resolveReadingCurrentRange,
  resolveTableByPoint,
} = require("./positioning");

class FindBar {
  constructor(plugin, view) {
    this.plugin = plugin;
    this.view = view;
    this.editor = view.editor;
    this.matches = [];
    this.current = -1;
    this.query = "";
    this.matcher = null;
    const options =
      plugin && typeof plugin.getFindOptions === "function"
        ? plugin.getFindOptions()
        : DEFAULT_FIND_OPTIONS;
    this.caseSensitive = options.caseSensitive;
    this.useRegex = options.useRegex;
    this.wholeWord = options.wholeWord;
    this.groupResults = options.groupResults;
    this.headingGroupLevel = options.headingGroupLevel;
    this.showResultHeadings = options.showResultHeadings;
    this.domMode = false; // reading mode: jump via applyScroll, highlight on DOM
    this.renderedTextMode = false; // reading/live preview hide some Markdown syntax
    this.currentDomRange = null; // anchored current range in reading mode
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
      const distance =
        Math.abs(m.line - previousMatch.line) * 100000 +
        Math.abs(m.ch - previousMatch.ch);
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
      this.groupBtn.title = this.groupResults
        ? `Grouped by ${headingLevelMenuLabel(this.headingGroupLevel)}`
        : "Group results by heading";
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
      item
        .setTitle("Show row headings")
        .setChecked(this.showResultHeadings)
        .onClick(() => this.setResultHeadingDisplay(!this.showResultHeadings));
    });
    if (typeof menu.addSeparator === "function") menu.addSeparator();
    menu.addItem((item) => {
      item
        .setTitle("Group: Off")
        .setChecked(!this.groupResults)
        .onClick(() => this.setHeadingGrouping(false));
    });
    if (typeof menu.addSeparator === "function") menu.addSeparator();
    const levels = [1, 2, 3, 4, 5, 6];
    for (const level of levels) {
      menu.addItem((item) => {
        item
          .setTitle(`Group by ${headingLevelMenuLabel(level)}`)
          .setChecked(this.groupResults && this.headingGroupLevel === level)
          .onClick(() => this.setHeadingGrouping(true, level));
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
      placeholder: "Search current note...",
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
    prev.title = "Previous (Shift+Enter / ↑)";
    next.title = "Next (Enter / ↓)";
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
    this.updateCount(); // collapse the empty count/separator on open

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
      this.refreshCurrentSearch({ preserveCurrent: true, jump: false });
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

  refreshHighlights(token = this.highlightToken) {
    if (token !== this.highlightToken) return;
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
    // Both modes: complete whole-note search from the source.
    const text = this.editor.getValue();
    this.docLines = text.split("\n");
    this.matches = findSourceMatches(this.docLines, this.matcher);
    this.matchGroupInfo = null;
    // Rendered modes hide some Markdown source syntax. Drop matches inside
    // those hidden ranges so jump/search defaults land on visible text.
    if (this.renderedTextMode && this.matches.length) {
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
    this.current = this.matches.length
      ? options.preserveCurrent
        ? this.closestMatchIndex(previousMatch, previousCurrent)
        : 0
      : -1;
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
      // Scroll the rendered preview to the match's source line, then let
      // refreshHighlights map the current match by content.
      try {
        const pm = this.view.previewMode || this.view.currentMode;
        if (pm && typeof pm.applyScroll === "function") pm.applyScroll(m.line);
      } catch (e) {
        debugWarn("applyScroll", e);
      }
      this.currentDomRange = null; // recompute fresh for the new selection
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
      debugWarn("scrollIntoView", e);
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
    if (
      this.matchGroupInfo &&
      this.matchGroupInfo.matchCount === this.matches.length &&
      this.matchGroupInfo.headingGroupLevel === this.headingGroupLevel
    ) {
      return this.matchGroupInfo;
    }

    const groupLevel = normalizeHeadingGroupLevel(this.headingGroupLevel);
    const groups = this.matches.map((m) =>
      headingGroupForLine(this.docLines || [], m.line, groupLevel)
    );
    const totals = new Map();
    for (const group of groups) {
      const key = headingGroupKey(group);
      totals.set(key, (totals.get(key) || 0) + 1);
    }

    const seen = new Map();
    const items = groups.map((group) => {
      const key = headingGroupKey(group);
      const indexInGroup = (seen.get(key) || 0) + 1;
      seen.set(key, indexInGroup);
      return {
        group,
        key,
        indexInGroup,
        totalInGroup: totals.get(key) || 0,
      };
    });

    this.matchGroupInfo = {
      headingGroupLevel: this.headingGroupLevel,
      matchCount: this.matches.length,
      items,
      totals,
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
            text: String(groupItem.totalInGroup),
          });
        }
      }

      const row = el.createDiv({ cls: "lf-row" });
      row.dataset.matchIndex = String(i);
      if (i === this.current) row.addClass("is-active");

      // Second line: nearest precise heading above this match.
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
        if (this.input) this.input.focus(); // keep keyboard nav alive
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
      groupEl.title = isActive
        ? `${active.group.text}: ${active.indexInGroup}/${active.totalInGroup}`
        : `${groupEl.dataset.groupTitle || "Heading"}: ${total}`;
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
}

module.exports = { FindBar };
