import { debugWarn, HL_ALL, HL_CURRENT } from "./constants.js";
import { getViewWindow } from "./dom-resolve.js";

export function getHighlightSupport(view) {
  const win = getViewWindow(view);
  const css = win && win.CSS;
  if (!css || !css.highlights || !win.Highlight) return null;
  return {
    Highlight: win.Highlight,
    registry: css.highlights,
  };
}

export function clearHighlights(view, previousRegistry = null) {
  const registries = [previousRegistry];
  const support = getHighlightSupport(view);
  if (support) registries.push(support.registry);
  const seen = new Set();
  for (const registry of registries) {
    if (!registry || seen.has(registry)) continue;
    seen.add(registry);
    registry.delete(HL_ALL);
    registry.delete(HL_CURRENT);
  }
}

export function applyHighlights(view, previousRegistry, dom, currentRange) {
  const support = getHighlightSupport(view);
  if (!support) return null;
  if (previousRegistry && previousRegistry !== support.registry) {
    previousRegistry.delete(HL_ALL);
    previousRegistry.delete(HL_CURRENT);
  }
  support.registry.set(HL_ALL, new support.Highlight(...dom.map((d) => d.range)));
  if (currentRange) {
    const hl = new support.Highlight(currentRange);
    hl.priority = 1;
    support.registry.set(HL_CURRENT, hl);
  } else {
    support.registry.delete(HL_CURRENT);
  }
  return support.registry;
}

export function rangeCenterY(range) {
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

export function viewportCenterY(scroller) {
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

/**
 * Keep the rendered yellow highlights centered around the current orange match.
 * The search count/list still comes from the full note source; this only limits
 * how many DOM ranges are sent to the CSS Highlight API at once.
 */
export function limitDomHighlightsAroundCurrent(dom, currentRange, max, scroller) {
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
