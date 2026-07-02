"use strict";

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

const DEFAULT_FIND_OPTIONS = {
  caseSensitive: false,
  useRegex: false,
  wholeWord: false,
  groupResults: false,
  headingGroupLevel: 2,
  showResultHeadings: true,
};

module.exports = {
  HL_ALL,
  HL_CURRENT,
  DEBUG,
  DEBOUNCE_MS,
  MAX_DOM_HIGHLIGHTS,
  SELECTORS,
  DEFAULT_FIND_OPTIONS,
};
