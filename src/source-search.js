"use strict";

const { findAll } = require("./matcher");

function findSourceMatches(lines, matcher) {
  const res = [];
  if (!matcher || matcher.invalid) return res;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const mt of findAll(line, matcher)) {
      res.push({ line: i, ch: mt.index, len: mt.length, lineText: line });
    }
  }
  return res;
}

module.exports = { findSourceMatches };
