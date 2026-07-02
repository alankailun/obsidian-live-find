"use strict";

const { isTableRow, parseCells } = require("./tables");

function imageSpansIn(line) {
  const spans = [];
  let re = /!\[\[[^\]\n]*\]\]/g;
  let m;
  while ((m = re.exec(line)) !== null)
    spans.push([m.index, m.index + m[0].length]);
  re = /!\[[^\]\n]*\]\([^)\n]*\)/g;
  while ((m = re.exec(line)) !== null)
    spans.push([m.index, m.index + m[0].length]);
  return spans;
}

function hiddenSpansInReading(line) {
  const spans = [...imageSpansIn(line)];
  let m;

  // Standard Markdown links. Keep only the label between [ and ] visible.
  const mdLink = /(?<!!)\[([^\]\n]*)\]\(([^)\n]*)\)/g;
  while ((m = mdLink.exec(line)) !== null) {
    const textStart = m.index + 1;
    const textEnd = textStart + m[1].length;
    spans.push([m.index, textStart]);
    spans.push([textEnd, m.index + m[0].length]);
  }

  // Obsidian wikilinks. [[Page]] shows Page; [[Page|Alias]] shows Alias.
  const wiki = /(?<!!)\[\[([^|\]\n]*)(?:\|([^\]\n]*))?\]\]/g;
  while ((m = wiki.exec(line)) !== null) {
    if (m[2] != null) {
      const aliasStart = m.index + m[0].indexOf("|") + 1;
      const aliasEnd = m.index + m[0].length - 2;
      spans.push([m.index, aliasStart]);
      spans.push([aliasEnd, m.index + m[0].length]);
    } else {
      spans.push([m.index, m.index + 2]);
      spans.push([m.index + m[0].length - 2, m.index + m[0].length]);
    }
  }

  return spans.sort((a, b) => a[0] - b[0]);
}

function isInsideSpan(ch, spans) {
  for (const [a, b] of spans) if (ch >= a && ch < b) return true;
  return false;
}

function previousCellOf(line, ch) {
  if (!isTableRow(line)) return null;
  const cells = parseCells(line);
  for (let c = 0; c < cells.length; c++) {
    const cell = cells[c];
    if (ch >= cell.start && ch <= cell.start + cell.text.length) {
      for (let p = c - 1; p >= 0; p--) {
        const t = cells[p].text.trim();
        if (t) return t.replace(/[*_`]/g, "").replace(/\s+/g, " ").slice(0, 24);
      }
      return null;
    }
  }
  return null;
}

function parseHeading(line, lineIdx) {
  const m = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line || "");
  if (!m) return null;
  return { level: m[1].length, text: m[2], line: lineIdx };
}

function nearestHeading(lines, lineIdx, maxLevel = 6) {
  for (let i = lineIdx; i >= 0; i--) {
    const heading = parseHeading(lines[i], i);
    if (heading && heading.level <= maxLevel) return heading;
  }
  return null;
}

function cleanHeadingText(text) {
  return (text || "").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
}

function headingGroupForLine(lines, lineIdx, maxLevel) {
  const heading = nearestHeading(lines, lineIdx, maxLevel);
  if (heading) return { ...heading, text: cleanHeadingText(heading.text) };
  return { level: 0, line: -1, text: "No heading" };
}

function headingGroupKey(group) {
  return `${group.line}:${group.level}:${group.text}`;
}

function cleanSnippet(line) {
  return line
    .replace(/!\[\[[^\]\n]*\]\]/g, "") // Obsidian image embeds
    .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, "") // standard images
    .replace(/(?<!!)\[([^\]\n]*)\]\([^)\n]*\)/g, "$1") // standard links
    .replace(/(?<!!)\[\[([^|\]\n]*)(?:\|([^\]\n]*))?\]\]/g, (_, target, alias) => alias || target)
    .replace(/^[\s>#*+\-]+/, "")
    .replace(/[*_`]/g, "")
    .replace(/\|/g, " ")
    .replace(/[│├└─]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function visibleInlineText(text) {
  return (text || "")
    .replace(/!\[\[[^\]\n]*\]\]/g, "") // image embed: not readable text
    .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, "") // standard image
    .replace(/(?<!!)\[([^\]\n]*)\]\([^)\n]*\)/g, "$1") // [label](url) -> label
    .replace(/(?<!!)\[\[([^|\]\n]*)(?:\|([^\]\n]*))?\]\]/g, (_, target, alias) => alias || target)
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/[*_`~]/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

module.exports = {
  hiddenSpansInReading,
  isInsideSpan,
  previousCellOf,
  nearestHeading,
  cleanHeadingText,
  headingGroupForLine,
  headingGroupKey,
  cleanSnippet,
  visibleInlineText,
};
