import { MarkdownView, Menu, setIcon } from "obsidian";
import { DEFAULT_FIND_OPTIONS, DEBOUNCE_MS, DOM_HIGHLIGHT_VIEWPORT_MARGIN, MAX_DOM_HIGHLIGHTS, SCROLL_HIGHLIGHT_MIN_INTERVAL_MS, debugWarn, debounce, headingLevelLabel, headingLevelMenuLabel, normalizeHeadingGroupLevel } from "./constants.js";
import { buildMatcher, findSourceMatches, normalizePlainQuery } from "./matcher.js";
import { buildTableLookup, isDelimiterRow, locateInTables } from "./tables.js";
import { buildHeadingLookup, cleanHeadingText, cleanSnippet, headingGroupForLine, headingGroupKey, hiddenSpansInReading, isInsideSpan, nearestHeading } from "./markdown.js";
import { appendHighlightedSnippet, buildSnippetData } from "./snippets.js";
import { centerEditorOffset, findRenderedMatches, getEditorView, getElementWindow, getRenderRoot, getScroller, getViewWindow, isLivePreviewMode, resolveByDomAtPos, resolveReadingCurrentRange, resolveTableByPoint, scrollRangeIntoView } from "./dom-resolve.js";
import { applyHighlights, clearHighlights as clearRegisteredHighlights, getHighlightSupport, limitDomHighlightsAroundCurrent } from "./highlighter.js";
import { VirtualResultList } from "./results-list.js";

export class FindBar {
  constructor(plugin, view) {
    this.plugin = plugin;
    this.view = view;
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
    this.jumpNearest = options.jumpNearest;
    this.domMode = false; // reading mode: jump via applyScroll, highlight on DOM
    this.renderedTextMode = false; // reading/live preview hide some Markdown syntax
    this.currentDomRange = null; // anchored current range in reading mode
    this.highlightToken = 0;
    this.highlightRegistry = null;
    this.resultList = null;
    this.docCache = null;
    this.docDirty = true;
    this.perfStats = {};
    this.perfSeq = 0;
    this.renderObserver = null;
    this.observedRenderRoot = null;
    this.hlFrame = null;
    this.hlTrailingTimer = null;
    this.hlTrailingWindow = null;
    this.lastHlRefreshAt = 0;
    this.barEl = null;
    this.resultsEl = null;
  }

  get editor() {
    return this.view && this.view.editor;
  }

  performanceApi() {
    const win = getElementWindow(
      this.barEl || (this.view && this.view.containerEl)
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
    if (this.docCache && !this.docDirty) {
      this.docLines = this.docCache.lines;
      this.tableLookup = this.docCache.tables;
      this.headingLookup = this.docCache.headings;
      return this.docCache;
    }

    const text = this.editor.getValue();
    if (this.docCache && this.docCache.text === text) {
      this.docDirty = false;
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
      hiddenSpansByLine: new Map(),
      version: this.docCache ? this.docCache.version + 1 : 1,
    };
    this.docCache = cache;
    this.docDirty = false;
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

  updateRenderObserver() {
    this.disconnectRenderObserver();
    if (!this.barEl) return;

    const root = getRenderRoot(this.view);
    if (!root) return;

    const win = getElementWindow(root);
    if (!win || typeof win.MutationObserver !== "function") return;

    this.observedRenderRoot = root;
    this.renderObserver = new win.MutationObserver((mutations) => {
      const hasNoteMutation = mutations.some((mutation) => {
        const target = mutation.target;
        const el =
          target && target.nodeType === 1 ? target : target && target.parentElement;
        return !(
          el &&
          el.closest &&
          el.closest(".lf-find-bar, .lf-results")
        );
      });
      if (!hasNoteMutation) return;
      this.scheduleHighlightRefresh();
    });
    this.renderObserver.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  disconnectRenderObserver() {
    if (this.renderObserver) this.renderObserver.disconnect();
    this.renderObserver = null;
    this.observedRenderRoot = null;
  }

  scheduleHighlightRefresh() {
    if (!this.barEl || !this.query || !this.matcher || this.matcher.invalid)
      return;
    if (this.hlFrame != null) return;

    const win = getViewWindow(this.view);
    const perf =
      win.performance ||
      (typeof performance !== "undefined" ? performance : null);
    this.hlFrame = win.requestAnimationFrame(() => {
      this.hlFrame = null;
      const now = perf ? perf.now() : Date.now();
      const since = now - (this.lastHlRefreshAt || 0);
      if (since >= SCROLL_HIGHLIGHT_MIN_INTERVAL_MS) {
        this.cancelHighlightTrailing();
        this.runHighlightRefresh();
        return;
      }

      this.cancelHighlightTrailing();
      this.hlTrailingWindow = win;
      this.hlTrailingTimer = win.setTimeout(() => {
        this.hlTrailingTimer = null;
        this.hlTrailingWindow = null;
        this.runHighlightRefresh();
      }, SCROLL_HIGHLIGHT_MIN_INTERVAL_MS - since);
    });
  }

  runHighlightRefresh() {
    const win = getViewWindow(this.view);
    const perf =
      win.performance ||
      (typeof performance !== "undefined" ? performance : null);
    this.lastHlRefreshAt = perf ? perf.now() : Date.now();
    this.refreshHighlights(this.highlightToken, { fromScroll: true });
  }

  cancelHighlightTrailing() {
    if (this.hlTrailingTimer == null) return;
    const win = this.hlTrailingWindow || getViewWindow(this.view);
    win.clearTimeout(this.hlTrailingTimer);
    this.hlTrailingTimer = null;
    this.hlTrailingWindow = null;
  }

  cancelHighlightRefresh() {
    if (this.hlFrame != null) {
      const win = getViewWindow(this.view);
      win.cancelAnimationFrame(this.hlFrame);
      this.hlFrame = null;
    }
    this.cancelHighlightTrailing();
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

  /**
   * Best-effort source line currently at the center of the viewport. Used to
   * start a fresh search near what the user is reading instead of always
   * yanking to the first match in the note. Returns null if it can't be
   * determined (callers then fall back to the first match).
   */
  anchorLineFromViewport() {
    try {
      // Reading mode: the preview renderer reports scroll as a (fractional)
      // source-line number, symmetric with applyScroll(line).
      if (this.view.getMode() === "preview") {
        const pm = this.view.previewMode || this.view.currentMode;
        const renderer = pm && pm.renderer;
        let s = null;
        if (renderer && typeof renderer.getScroll === "function") s = renderer.getScroll();
        else if (pm && typeof pm.getScroll === "function") s = pm.getScroll();
        return Number.isFinite(s) ? Math.max(0, Math.round(s)) : null;
      }

      // Editor (source / live preview): map the viewport center to a line.
      const cm = getEditorView(this.editor);
      const scroller = getScroller(this.view) || (cm && cm.scrollDOM);
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
      const dist = Math.abs(m.line - line) * 100000 + m.ch;
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
        jumpNearest: this.jumpNearest,
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
    this.nearestBtn = bar.createEl("button", { cls: "lf-btn lf-toggle" });
    setIcon(this.nearestBtn, "locate-fixed");
    this.nearestBtn.title =
      "Jump to the match nearest the current view (off: always jump to the first match)";
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
      renderRow: (index, groupInfo, state, parent) =>
        this.createResultRow(index, groupInfo, state, parent),
    });
    this.updateCount(); // collapse the empty count/separator on open

    this.composing = false;
    this.onInput = debounce(() => {
      // While an IME is composing (e.g. Chinese pinyin), the field's value
      // is an in-progress candidate, not real text — searching it would
      // just chase garbage. Wait for compositionend instead, same as
      // Chrome's own in-page find.
      if (this.composing) return;
      this.search(this.input.value);
    }, DEBOUNCE_MS);
    this.input.addEventListener("input", this.onInput);
    this.onCompositionStart = () => {
      this.composing = true;
    };
    this.onCompositionEnd = () => {
      this.composing = false;
      this.flushInputSearch();
    };
    this.input.addEventListener("compositionstart", this.onCompositionStart);
    this.input.addEventListener("compositionend", this.onCompositionEnd);
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

    this.onScroll = () => this.scheduleHighlightRefresh();
    this.updateScroller();
    this.updateRenderObserver();

    // Re-run search when the user toggles Source / Live Preview / Reading
    // inside the same tab, so domMode, highlights and snippets stay accurate.
    this.lastViewMode = this.viewModeKey();
    this.layoutEvt = this.plugin.app.workspace.on("layout-change", () => {
      if (!this.barEl) return;
      const mode = this.viewModeKey();
      if (mode === this.lastViewMode) return;
      this.lastViewMode = mode;
      this.updateScroller();
      this.updateRenderObserver();
      this.refreshCurrentSearch({ preserveCurrent: true });
    });

    // Keep results in sync if the note is edited while the find bar is open.
    const refreshAfterEditorChange = debounce(() => {
      if (!this.barEl) return;
      this.refreshCurrentSearch({ preserveCurrent: true, jump: false });
    }, DEBOUNCE_MS);
    this.onEditorChange = () => {
      if (!this.barEl) return;
      const active = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
      if (active !== this.view) return;
      this.docDirty = true;
      refreshAfterEditorChange();
    };
    this.onEditorChange.cancel = refreshAfterEditorChange.cancel;
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
    this.cancelHighlightRefresh();
    if (this.onEditorChange && this.onEditorChange.cancel)
      this.onEditorChange.cancel();

    if (this.input && this.onInput) {
      this.input.removeEventListener("input", this.onInput);
    }
    if (this.input && this.onCompositionStart) {
      this.input.removeEventListener("compositionstart", this.onCompositionStart);
    }
    if (this.input && this.onCompositionEnd) {
      this.input.removeEventListener("compositionend", this.onCompositionEnd);
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
    this.disconnectRenderObserver();
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
    this.onCompositionStart = null;
    this.onCompositionEnd = null;
    this.composing = false;
    this.onResultsScroll = null;
    this.onEditorChange = null;
    this.matches = [];
    this.current = -1;
    this.query = ""; // ensure late timers can't repaint highlights
    this.matcher = null;
    this.tableLookup = null;
    this.headingLookup = null;
    this.docCache = null;
    this.docDirty = true;
    this.snippetCache = new Map();
  }

  clearHighlights() {
    clearRegisteredHighlights(this.view, this.highlightRegistry);
    this.highlightRegistry = null;
  }

  domApply(dom, currentRange) {
    const registry = applyHighlights(this.view, this.highlightRegistry, dom, currentRange);
    if (registry) this.highlightRegistry = registry;
  }

  refreshHighlights(token = this.highlightToken, options = {}) {
    if (token !== this.highlightToken) return null;
    if (!this.barEl) return null; // bail if a late timer fires after close()
    if (!getHighlightSupport(this.view)) return null;
    if (!this.query || !this.matcher || this.matcher.invalid)
      return this.clearHighlights(), null;

    const fromScroll = !!options.fromScroll;

    // Reading mode: list/count/nav come from the source (complete). The current
    // match is mapped to the rendered DOM by content (exact, even with duplicate
    // cells). Yellow highlights are limited around the current match, not just
    // the first N matches in the document.
    if (this.domMode) {
      const root = getRenderRoot(this.view);
      const m = this.matches[this.current];
      const scroller = getScroller(this.view);
      let cur = m
        ? resolveReadingCurrentRange(
            root,
            this.docLines,
            m,
            this.matcher,
            scroller,
            this.docCache && this.docCache.hiddenSpansByLine
          )
        : null;
      if (
        !cur &&
        this.currentDomRange &&
        this.currentDomRange.startContainer &&
        this.currentDomRange.startContainer.isConnected
      )
        cur = this.currentDomRange;

      const domOptions =
        fromScroll || options.viewportOnly
          ? { scroller, viewportMargin: DOM_HIGHLIGHT_VIEWPORT_MARGIN }
          : {};

      let dom = findRenderedMatches(root, this.matcher, domOptions);

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
      const isTable =
        !!locateInTables(lines, m.line, this.tableLookup) && !isDelimiterRow(line);
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
          const domOptions = fromScroll || options.viewportOnly
            ? { scroller, viewportMargin: DOM_HIGHLIGHT_VIEWPORT_MARGIN }
            : {};
          dom = findRenderedMatches(root, this.matcher, domOptions);
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

    const domOptions = fromScroll || options.viewportOnly
      ? { scroller, viewportMargin: DOM_HIGHLIGHT_VIEWPORT_MARGIN }
      : {};
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
    // Both modes: complete whole-note search from the source.
    const cachePerf = this.beginPerf("document-cache");
    const docCache = this.updateDocumentCache();
    this.endPerf(cachePerf);
    this.snippetCache = new Map();
    const matchPerf = this.beginPerf("match-source");
    this.matches = findSourceMatches(
      docCache.lines,
      this.matcher,
      docCache.lowerLines
    );
    this.endPerf(matchPerf);
    this.matchGroupInfo = null;
    // Rendered modes hide some Markdown source syntax. Drop matches inside
    // those hidden ranges so jump/search defaults land on visible text.
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
    this.current = this.matches.length
      ? options.preserveCurrent
        ? this.closestMatchIndex(previousMatch, previousCurrent)
        : this.jumpNearest
          ? this.nearestMatchIndexToLine(this.anchorLineFromViewport())
          : 0
      : -1;
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
      // Scroll the rendered preview to the match's source line, then let
      // refreshHighlights map the current match by content.
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
      this.currentDomRange = null; // recompute fresh for the new selection
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
      if (
        cm &&
        typeof cm.dispatch === "function" &&
        fromOffset != null &&
        toOffset != null
      ) {
        cm.dispatch({
          selection: { anchor: fromOffset, head: toOffset },
          scrollIntoView: true,
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
    if (
      this.matchGroupInfo &&
      this.matchGroupInfo.matchCount === this.matches.length &&
      this.matchGroupInfo.headingGroupLevel === this.headingGroupLevel
    ) {
      return this.matchGroupInfo;
    }

    const groupLevel = normalizeHeadingGroupLevel(this.headingGroupLevel);
    const groups = this.matches.map((m) =>
      headingGroupForLine(this.docLines || [], m.line, groupLevel, this.headingLookup)
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
    if (!el || !this.resultList) return;
    if (!this.query || !this.matches.length) {
      this.resultList.clear();
      el.style.display = "none";
      return;
    }
    el.style.display = "block";
    this.resultList.setItems(this.matches.length, this.current);
  }

  createResultRow(i, groupInfo, state, parent = null) {
    const el = parent || this.resultsEl;
    if (!el) return null;
    state = state || {};

    const m = this.matches[i];
    const groupItem = groupInfo ? groupInfo.items[i] : null;
    const group = groupItem ? groupItem.group : null;
    if (
      groupItem &&
      groupItem.key !== state.lastGroupKey &&
      !(state && state.suppressGroupHeader)
    ) {
      state.lastGroupKey = groupItem.key;
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

    const row = el.createDiv({ cls: "lf-row" });
    row.dataset.matchIndex = String(i);

    // Second line: nearest precise heading above this match.
    const head = this.showResultHeadings
      ? nearestHeading(this.docLines, m.line, 6, this.headingLookup)
      : null;
    if (head) row.addClass("has-head");

    const main = row.createDiv({ cls: "lf-main" });
    main.createSpan({ cls: "lf-line", text: `Line ${m.line + 1}` });
    const sn = main.createSpan({ cls: "lf-snippet" });

    let snippet = this.snippetCache.get(i);
    if (snippet === undefined) {
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
      groupEl.title = isActive
        ? `${active.group.text}: ${active.indexInGroup}/${active.totalInGroup}`
        : `${groupEl.dataset.groupTitle || "Heading"}: ${total}`;
    }
  }

  markActiveRow(options = {}) {
    if (!this.resultList) return;
    this.resultList.setActive(this.current, options);
    this.updateGroupCounts();
  }
}
