import { findAll } from "./matcher.js";

export function isTableRow(line) {
  const t = line.trim();
  return t.startsWith("|") && t.includes("|", 1);
}

export function isDelimiterRow(line) {
  return /^\s*\|?[\s:|\-]+\|?\s*$/.test(line) && line.includes("-");
}

export function parseCells(line) {
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

/**
 * One O(lines) pass over the note: for every line, which Markdown table block
 * (if any) contains it. Passing the result into locateInTables /
 * tableBlockForLine turns their per-call full-document scans into O(1)
 * lookups — the dominant cost when building thousands of result snippets.
 */
export function buildTableLookup(lines) {
  const lookup = new Array(lines.length).fill(null);
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

    let delimLine = -1;
    for (let k = blockStart; k < j; k++) {
      if (isDelimiterRow(lines[k])) {
        delimLine = k;
        break;
      }
    }

    if (delimLine !== -1) {
      tableIdx++;
      const block = { tableIdx, blockStart, blockEnd: j, delimLine };
      for (let k = blockStart; k < j; k++) lookup[k] = block;
    }
    i = j;
  }
  return lookup;
}

export function locateInTables(lines, lineIdx, lookup) {
  if (lookup) {
    const block = lookup[lineIdx];
    if (!block) return null;
    if (lineIdx === block.blockStart)
      return { tableIdx: block.tableIdx, kind: "header" };
    if (lineIdx === block.delimLine)
      return { tableIdx: block.tableIdx, kind: "delim" };
    return {
      tableIdx: block.tableIdx,
      kind: "body",
      bodyRowIdx: lineIdx - block.delimLine - 1,
    };
  }
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

export function cellInfoForMatch(line, ch, matcher) {
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

export function tableDataCells(line) {
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

export function tableBlockForLine(lines, lineIdx, lookup) {
  if (lookup) {
    const block = lookup[lineIdx];
    if (!block) return null;
    return {
      blockStart: block.blockStart,
      blockEnd: block.blockEnd,
      headerLine: block.blockStart,
      delimLine: block.delimLine,
    };
  }
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
