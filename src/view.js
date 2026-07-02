"use strict";

const { SELECTORS } = require("./constants");

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

module.exports = {
  getRenderRoot,
  isLivePreviewMode,
  getScroller,
  getEditorView,
};
