"use strict";

const { findAll } = require("./matcher");
const { debugWarn } = require("./utils");

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

module.exports = {
  findRenderedMatches,
  limitDomHighlightsAroundCurrent,
};
