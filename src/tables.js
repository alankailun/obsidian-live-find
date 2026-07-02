"use strict";

function isTableRow(line) {
  const t = line.trim();
  return t.startsWith("|") && t.includes("|", 1);
}

function isDelimiterRow(line) {
  return /^\s*\|?[\s:|\-]+\|?\s*$/.test(line) && line.includes("-");
}

function parseCells(line) {
  const cells = [];
  let cur = "";
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\" && i + 1 < line.length) {
      cur += c + line[i + 1];
      i++;
      continue;
    }
    if (c === "|") {
      cells.push({ text: cur, start });
      cur = "";
      start = i + 1;
      continue;
    }
    cur += c;
  }
  cells.push({ text: cur, start });
  return cells;
}

function locateInTables(lines, lineIdx) {
  let tableIdx = -1;
  let i = 0;
  while (i < lines.length) {
    if (!isTableRow(lines[i])) {
      i++;
      continue;
    }

    const blockStart = i;
    let j = i;
    while (j < lines.length && isTableRow(lines[j])) j++;

    let delimOffset = -1;
    for (let k = blockStart; k < j; k++) {
      if (isDelimiterRow(lines[k])) {
        delimOffset = k - blockStart;
        break;
      }
    }

    // A real Markdown table needs a delimiter row. Avoid treating code / ASCII
    // art / arbitrary pipe-prefixed lines as tables.
    if (delimOffset === -1) {
      i = j;
      continue;
    }

    tableIdx++;
    if (lineIdx >= blockStart && lineIdx < j) {
      const offset = lineIdx - blockStart;
      if (offset === 0) return { tableIdx, kind: "header" };
      if (offset === delimOffset) return { tableIdx, kind: "delim" };
      const bodyRowIdx = offset - (delimOffset + 1);
      return { tableIdx, kind: "body", bodyRowIdx };
    }
    i = j;
  }
  return null;
}

function cellInfoForMatch(line, ch, matcher) {
  const cells = parseCells(line);
  let dataCol = -1;
  for (let c = 0; c < cells.length; c++) {
    const cell = cells[c];
    const isEdgeEmpty =
      (c === 0 || c === cells.length - 1) && cell.text.trim() === "";
    if (!isEdgeEmpty) dataCol++;
    const start = cell.start;
    const end = start + cell.text.length;
    if (ch >= start && ch <= end) {
      const offInCell = ch - start;
      let kInCell = 0;
      for (const mt of findAll(cell.text, matcher)) {
        if (mt.index < offInCell) kInCell++;
        else break;
      }
      return { col: dataCol, kInCell };
    }
  }
  return null;
}

function tableDataCells(line) {
  const raw = parseCells(line);
  const out = [];
  let dataCol = -1;
  for (let i = 0; i < raw.length; i++) {
    const cell = raw[i];
    const isEdgeEmpty =
      (i === 0 || i === raw.length - 1) && cell.text.trim() === "";
    if (isEdgeEmpty) continue;
    dataCol++;
    out.push({ ...cell, dataCol });
  }
  return out;
}

function tableBlockForLine(lines, lineIdx) {
  let i = 0;
  while (i < lines.length) {
    if (!isTableRow(lines[i])) {
      i++;
      continue;
    }

    const blockStart = i;
    let j = i;
    while (j < lines.length && isTableRow(lines[j])) j++;

    let delimLine = -1;
    for (let k = blockStart; k < j; k++) {
      if (isDelimiterRow(lines[k])) {
        delimLine = k;
        break;
      }
    }

    if (delimLine !== -1 && lineIdx >= blockStart && lineIdx < j) {
      return { blockStart, blockEnd: j, headerLine: blockStart, delimLine };
    }
    i = j;
  }
  return null;
}

module.exports = {
  isTableRow,
  isDelimiterRow,
  parseCells,
  locateInTables,
  cellInfoForMatch,
  tableDataCells,
  tableBlockForLine,
};
