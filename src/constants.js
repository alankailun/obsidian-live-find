export const HL_ALL = "live-find-all";
export const HL_CURRENT = "live-find-current";

// Hard-coded knobs. Flip DEBUG to true while developing; the others are
// reasonable defaults — adjust here if you ever need to tune them.
export const DEBUG = false;
export const DEBOUNCE_MS = 100;
export const SCROLL_HIGHLIGHT_MIN_INTERVAL_MS = 120;
export const DOM_HIGHLIGHT_VIEWPORT_MARGIN = 6000;
export const MAX_DOM_HIGHLIGHTS = 2500;
export const DEFAULT_RESULT_ROW_HEIGHT = 42;

export const SELECTORS = {
  readingRoot: ".markdown-reading-view, .markdown-preview-view",
  editorRoot: ".cm-content",
  scroller: ".cm-scroller, .markdown-preview-view",
};

export const DEFAULT_FIND_OPTIONS = {
  caseSensitive: false,
  useRegex: false,
  wholeWord: false,
  groupResults: false,
  headingGroupLevel: 2,
  showResultHeadings: true,
  jumpNearest: true,
};

export function normalizeHeadingGroupLevel(value) {
  const n = Number(value);
  if (Number.isInteger(n) && n >= 1 && n <= 6) return n;
  return DEFAULT_FIND_OPTIONS.headingGroupLevel;
}

export function headingLevelLabel(level) {
  return `H${normalizeHeadingGroupLevel(level)}`;
}

export function headingLevelMenuLabel(level) {
  return `Heading ${normalizeHeadingGroupLevel(level)}`;
}

export function normalizeFindOptions(options) {
  const src = options && typeof options === "object" ? options : {};
  const savedRemovedTopLevel = src.headingGroupLevel === "top";
  return {
    caseSensitive:
      typeof src.caseSensitive === "boolean"
        ? src.caseSensitive
        : DEFAULT_FIND_OPTIONS.caseSensitive,
    useRegex:
      typeof src.useRegex === "boolean"
        ? src.useRegex
        : DEFAULT_FIND_OPTIONS.useRegex,
    wholeWord:
      typeof src.wholeWord === "boolean"
        ? src.wholeWord
        : DEFAULT_FIND_OPTIONS.wholeWord,
    groupResults:
      typeof src.groupResults === "boolean"
        ? src.groupResults && !savedRemovedTopLevel
        : DEFAULT_FIND_OPTIONS.groupResults,
    headingGroupLevel: normalizeHeadingGroupLevel(src.headingGroupLevel),
    showResultHeadings:
      typeof src.showResultHeadings === "boolean"
        ? src.showResultHeadings
        : DEFAULT_FIND_OPTIONS.showResultHeadings,
    jumpNearest:
      typeof src.jumpNearest === "boolean"
        ? src.jumpNearest
        : DEFAULT_FIND_OPTIONS.jumpNearest,
  };
}

export function debugWarn(where, err) {
  if (!DEBUG) return;
  console.warn(`[LiveFind] ${where}`, err);
}

export function debounce(fn, ms) {
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
