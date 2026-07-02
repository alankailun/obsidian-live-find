"use strict";

const { findAll } = require("./matcher");
const {
  cellInfoForMatch,
  locateInTables,
  tableBlockForLine,
  tableDataCells,
} = require("./tables");
const {
  cleanSnippet,
  hiddenSpansInReading,
  isInsideSpan,
  visibleInlineText,
} = require("./markdown");

function isWordSep(ch) {
  if (!ch) return true;
  if (/\s/.test(ch)) return true;
  if (ch === "|" || ch === "│") return true;
  const code = ch.charCodeAt(0);
  if (code >= 0x3000 && code <= 0x303f) return true; // CJK symbols & punctuation
  if (code >= 0xff00 && code <= 0xffef) return true; // full-width forms
  if (code >= 0x4e00 && code <= 0x9fff) return true; // CJK unified ideographs
  return false;
}

function wordStartBefore(text, idx) {
  let i = idx;
  while (i > 0 && !isWordSep(text.charAt(i - 1))) i--;
  return i;
}

function extendPrefixWords(text, start, n) {
  let cursor = start;
  while (n > 0 && cursor > 0) {
    let p = cursor;
    while (p > 0 && isWordSep(text.charAt(p - 1)) && text.charAt(p - 1) !== "|") p--;
    if (p === cursor) break; // no separators to skip
    if (p > 0 && text.charAt(p - 1) === "|") break; // don't cross table cells
    const end = p;
    while (p > 0 && !isWordSep(text.charAt(p - 1))) p--;
    if (p === end) break;
    cursor = p;
    n--;
  }
  return cursor;
}

function isMostlyCJK(text) {
  const compact = (text || "").replace(/\s+/g, "");
  if (!compact) return false;
  const cjk = (compact.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  return cjk >= 2 && cjk / compact.length >= 0.25;
}

function snippetWindow(source, hitIdx, hitLen, keepShort = false) {
  if (keepShort && source.length <= 180) return { s: 0, e: source.length };

  if (isMostlyCJK(source)) {
    const s = Math.max(0, hitIdx - 14);
    const e = Math.min(source.length, hitIdx + hitLen + 34);
    return { s, e };
  }

  let s = wordStartBefore(source, hitIdx);
  if (hitIdx - s === 0) s = extendPrefixWords(source, s, 2);
  const e = Math.min(source.length, hitIdx + hitLen + 80);
  return { s, e };
}

function appendHighlightedSnippet(container, source, hitIdx, hitLen, keepShort = false) {
  if (!source) return;
  if (hitIdx == null || hitIdx < 0 || hitLen <= 0) {
    container.appendText(source.slice(0, 120));
    if (source.length > 120) container.appendText("…");
    return;
  }

  const { s, e } = snippetWindow(source, hitIdx, hitLen, keepShort);
  const win = source.slice(s, e);
  const ls = hitIdx - s;
  const le = ls + hitLen;

  if (s > 0) container.appendText("…");
  if (ls > 0) container.appendText(win.slice(0, ls));
  container.createEl("strong", { text: win.slice(ls, le) });
  if (le < win.length) container.appendText(win.slice(le));
  if (e < source.length) container.appendText("…");
}

function normalizeSnippetPart(text) {
  return visibleInlineText(text).replace(/\s+/g, " ").trim();
}

function ellipsizeMiddle(text, maxLen = 42) {
  const t = normalizeSnippetPart(text);
  if (t.length <= maxLen) return t;
  const head = Math.max(8, Math.floor((maxLen - 1) * 0.62));
  const tail = Math.max(6, maxLen - 1 - head);
  return t.slice(0, head).trimEnd() + "…" + t.slice(t.length - tail).trimStart();
}

function pushUniquePart(parts, text, opts = {}) {
  const t = opts.noEllipsis
    ? normalizeSnippetPart(text)
    : ellipsizeMiddle(text, opts.maxLen || 42);
  if (!t) return;
  const key = t.toLowerCase();
  if (parts.some((p) => p.text.toLowerCase() === key)) return;
  parts.push({ text: t, hit: null, role: opts.role || "context" });
}

function pushMatchedPart(parts, text, hit, opts = {}) {
  const full = normalizeSnippetPart(text);
  if (!full || !hit) return null;

  // Keep the matched cell near the beginning of the visible snippet. If the cell
  // is long, crop around the exact hit, but keep hit.index aligned to the cropped
  // text so the result list highlights the same occurrence the user selected.
  const maxLen = opts.maxLen || 96;
  let display = full;
  let adjustedHit = { ...hit };
  if (full.length > maxLen) {
    const before = isMostlyCJK(full) ? 18 : 28;
    let s = Math.max(0, hit.index - before);
    let e = Math.min(full.length, hit.index + hit.length + (maxLen - before));

    // Prefer not to start in the middle of an English word.
    if (!isMostlyCJK(full)) s = wordStartBefore(full, s);
    display = (s > 0 ? "â€¦" : "") + full.slice(s, e) + (e < full.length ? "â€¦" : "");
    adjustedHit = {
      index: hit.index - s + (s > 0 ? 1 : 0),
      length: hit.length,
    };
  }

  const key = display.toLowerCase();
  const duplicateIdx = parts.findIndex((p) => p.text.toLowerCase() === key);
  const part = { text: display, hit: adjustedHit, role: opts.role || "match" };
  if (duplicateIdx >= 0) parts[duplicateIdx] = part;
  else parts.push(part);
  return part;
}

function buildTableSnippetData(m, lines, matcher) {
  const loc = locateInTables(lines, m.line);
  if (!loc || (loc.kind !== "body" && loc.kind !== "header")) return null;

  const block = tableBlockForLine(lines, m.line);
  if (!block) return null;

  const rowCells = tableDataCells(lines[m.line] || "");
  const headerCells = tableDataCells(lines[block.headerLine] || "");
  const info = cellInfoForMatch(lines[m.line] || "", m.ch, matcher);
  if (!info || info.col < 0) return null;

  const cell = rowCells[info.col];
  if (!cell) return null;

  const displayCell = normalizeSnippetPart(cell.text);
  if (!displayCell) return null;

  // Estimate the occurrence index inside the visible cell. This is usually more
  // stable than using the raw Markdown cell because links/emphasis may disappear.
  const sourceOffsetInCell = Math.max(0, m.ch - cell.start);
  const visibleBefore = normalizeSnippetPart(cell.text.slice(0, sourceOffsetInCell));
  const visibleK = findAll(visibleBefore, matcher).length;
  const cellMatches = findAll(displayCell, matcher);
  const pick = cellMatches[visibleK] || cellMatches[info.kInCell] || cellMatches[0];
  if (!pick) return null;

  const parts = [];
  const header = headerCells[info.col] ? headerCells[info.col].text : "";
  const rowLabel = rowCells[0] && info.col !== 0 ? rowCells[0].text : "";

  // Cell-level table snippets: put the column + matched cell first so the exact
  // hit is always visible in the one-line result list. The row label is still
  // included as trailing context, but shortened so it cannot hide the hit.
  // Example: 控制 · 自主 (Voluntary) · ① 口腔期 (Voluntary / Buccal…)
  pushUniquePart(parts, header, { maxLen: 24, role: "header" });
  pushMatchedPart(parts, displayCell, pick, { maxLen: 88, role: "match" });
  pushUniquePart(parts, rowLabel, { maxLen: 36, role: "row" });

  const sep = " · ";
  let source = "";
  let hitIdx = -1;
  let hitLen = pick.length;
  for (const part of parts) {
    if (source) source += sep;
    const start = source.length;
    source += part.text;
    if (part.hit && hitIdx < 0) {
      hitIdx = start + part.hit.index;
      hitLen = part.hit.length;
    }
  }

  if (hitIdx < 0) return null;
  // The hit is now near the beginning by construction, so keeping the short
  // table snippet is safe and avoids jumping back to the long row label.
  return { source, hitIdx, hitLen, keepShort: true };
}

function buildLineSnippetData(m, matcher, domMode) {
  const source = domMode ? cleanSnippet(m.lineText) : m.lineText;
  if (!source) return null;

  let hitIdx;
  let hitLen;
  if (domMode) {
    // Count matches before this one within the same source line, skipping hidden
    // Markdown spans, then select the same occurrence in the visible text.
    const spans = hiddenSpansInReading(m.lineText);
    let kInLine = 0;
    for (const mt of findAll(m.lineText.slice(0, m.ch), matcher)) {
      if (!isInsideSpan(mt.index, spans)) kInLine++;
    }
    const all = findAll(source, matcher);
    const pick = all[kInLine] || all[0];
    if (!pick) return { source, hitIdx: -1, hitLen: 0, keepShort: false };
    hitIdx = pick.index;
    hitLen = pick.length;
  } else {
    hitIdx = m.ch;
    hitLen = m.len;
  }

  return { source, hitIdx, hitLen, keepShort: false };
}

function buildSnippetData(m, lines, matcher, domMode) {
  return (
    buildTableSnippetData(m, lines, matcher) ||
    buildLineSnippetData(m, matcher, domMode)
  );
}

module.exports = {
  appendHighlightedSnippet,
  buildSnippetData,
};
