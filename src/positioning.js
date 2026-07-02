"use strict";

const { findAll } = require("./matcher");
const { debugWarn } = require("./utils");
const {
  cellInfoForMatch,
  isDelimiterRow,
  locateInTables,
} = require("./tables");
const { cleanSnippet, hiddenSpansInReading, isInsideSpan } = require("./markdown");

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
    debugWarn("resolveByDomAtPos", e);
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
    debugWarn("tableFromDomAtPos", e);
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
    debugWarn("tableFromPoint", e);
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
    debugWarn("resolveTableByPoint", e);
    return null;
  }
}

function resolveReadingCurrentRange(root, lines, m, matcher, scroller) {
  try {
    if (!root) return null;
    const line = lines[m.line] || "";
    // Count only matches that are visible in Reading mode, so the k-th match in
    // the source line aligns with the k-th visible match in the DOM.
    const spans = hiddenSpansInReading(line);
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

    // If the same row/paragraph text appears multiple times, choose the rendered
    // occurrence nearest the current scroll target instead of blindly taking the
    // first duplicate in the DOM.
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

module.exports = {
  resolveByDomAtPos,
  resolveTableByPoint,
  resolveReadingCurrentRange,
};
