import { debugWarn, SELECTORS } from "./constants.js";
import { findAll } from "./matcher.js";
import { cleanSnippet, hiddenSpansInReading, isInsideSpan } from "./markdown.js";
import { cellInfoForMatch, locateInTables } from "./tables.js";

export function getRenderRoot(view) {
  if (!view || !view.containerEl || typeof view.getMode !== "function") return null;
  const mode = view.getMode();
  return view.containerEl.querySelector(
    mode === "preview" ? SELECTORS.readingRoot : SELECTORS.editorRoot
  );
}

export function isLivePreviewMode(view) {
  if (!view || !view.containerEl || typeof view.getMode !== "function") return false;
  if (view.getMode() !== "source") return false;
  return !!view.containerEl.querySelector(".markdown-source-view.is-live-preview");
}

export function getScroller(view) {
  if (!view || !view.containerEl) return null;
  return view.containerEl.querySelector(SELECTORS.scroller);
}

export function getEditorView(editor) {
  return editor && editor.cm ? editor.cm : null;
}

export function getElementDocument(el) {
  return (el && el.ownerDocument) || document;
}

export function getElementWindow(el) {
  const doc = getElementDocument(el);
  return (doc && doc.defaultView) || window;
}

export function getViewDocument(view) {
  return (view && view.containerEl && view.containerEl.ownerDocument) || document;
}

export function getViewWindow(view) {
  const doc = getViewDocument(view);
  return (doc && doc.defaultView) || window;
}


/** Occurrences in the currently-rendered DOM (for highlighting). */
export function findRenderedMatches(root, matcher, options = {}) {
  const matches = [];
  if (!root || !matcher || matcher.invalid) return matches;
  
  const scroller = options.scroller;
  const margin = typeof options.viewportMargin === "number" ? options.viewportMargin : Infinity;
  let viewTop = -Infinity;
  let viewBottom = Infinity;
  if (scroller && margin !== Infinity) {
    const rect = scroller.getBoundingClientRect();
    viewTop = rect.top - margin;
    viewBottom = rect.bottom + margin;
  }
  
  const doc = getElementDocument(root);
  const win = getElementWindow(root);
  const filter = win.NodeFilter;
  const walker = doc.createTreeWalker(root, filter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim())
        return filter.FILTER_REJECT;
      const tag = node.parentElement && node.parentElement.tagName;
      if (tag === "SCRIPT" || tag === "STYLE") return filter.FILTER_REJECT;
      return filter.FILTER_ACCEPT;
    },
  });
  let node;
  while ((node = walker.nextNode())) {
    if (scroller && margin !== Infinity) {
      const elRect = node.parentElement.getBoundingClientRect();
      if (elRect.bottom < viewTop || elRect.top > viewBottom) {
        continue;
      }
    }
    const text = node.nodeValue;
    for (const mt of findAll(text, matcher)) {
      const range = doc.createRange();
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

export function scrollRangeIntoView(range) {
  try {
    if (!range || !range.startContainer) return false;
    const node = range.startContainer;
    const el =
      node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!el || typeof el.scrollIntoView !== "function") return false;
    const target =
      (el.closest &&
        el.closest(
          ".cm-line, td, th, tr, p, li, h1, h2, h3, h4, h5, h6, dd, dt, blockquote"
        )) ||
      el;
    target.scrollIntoView({ behavior: "auto", block: "center", inline: "nearest" });
    return true;
  } catch (e) {
    debugWarn("scrollRangeIntoView", e);
    return false;
  }
}

export function centerEditorOffset(view, editor, off) {
  try {
    const pos = editor.offsetToPos(off);
    editor.setCursor(pos);
    const cm = getEditorView(editor);
    const scroller = getScroller(view) || (cm && cm.scrollDOM);
    if (!cm || typeof cm.coordsAtPos !== "function" || !scroller || off == null) return false;
    
    // give Obsidian a frame to update the DOM for the new cursor position
    requestAnimationFrame(() => {
      const coords = cm.coordsAtPos(off);
      if (coords) {
        const targetY = coords.top + scroller.scrollTop - scroller.getBoundingClientRect().top;
        scroller.scrollTop = targetY - scroller.clientHeight / 2;
      }
    });
    return true;
  } catch (e) {
    debugWarn("centerEditorOffset", e);
    return false;
  }
}

export function findKthOccurrenceRange(el, matcher, k) {
  const doc = getElementDocument(el);
  const win = getElementWindow(el);
  const walker = doc.createTreeWalker(el, win.NodeFilter.SHOW_TEXT);
  let node;
  let count = 0;
  while ((node = walker.nextNode())) {
    for (const mt of findAll(node.nodeValue, matcher)) {
      if (count === k) {
        const r = doc.createRange();
        r.setStart(node, mt.index);
        r.setEnd(node, mt.index + mt.length);
        return r;
      }
      count++;
    }
  }
  return null;
}

export function resolveByDomAtPos(cm, off, matcher) {
  try {
    if (!cm || typeof cm.domAtPos !== "function") return null;
    const d = cm.domAtPos(off);
    const node = d.node;
    if (!node || node.nodeType !== 3) return null;
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
    const r = getElementDocument(node).createRange();
    r.setStart(node, best.index);
    r.setEnd(node, best.index + best.length);
    return r;
  } catch (e) {
    debugWarn("resolveByDomAtPos", e);
    return null;
  }
}

export function closestElementFromNode(node) {
  if (!node) return null;
  return node.nodeType === 1 ? node : node.parentElement;
}

export function tableFromDomAtPos(cm, off) {
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

export function tableFromPoint(cm, off) {
  try {
    if (!cm || typeof cm.coordsAtPos !== "function") return null;
    const doc = getElementDocument(cm.dom);
    const win = getElementWindow(cm.dom);
    const coords = cm.coordsAtPos(off);
    if (!coords) return null;
    const y = (coords.top + coords.bottom) / 2;
    const xs = [coords.left + 1, coords.left + 20, 120, win.innerWidth / 2];
    for (const x of xs) {
      const el = doc.elementFromPoint(x, y);
      const t = el && el.closest && el.closest("table");
      if (t) return t;
    }
    return null;
  } catch (e) {
    debugWarn("tableFromPoint", e);
    return null;
  }
}

export function resolveTableByPoint(cm, off, lines, m, matcher) {
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

/**
 * True if `ch` should be treated as a "word" boundary for snippet purposes:
 * whitespace, table pipes, CJK punctuation, full-width forms, or any CJK char
 * (each Chinese character is its own word).
 */

export function resolveReadingCurrentRange(root, lines, m, matcher, scroller) {
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
