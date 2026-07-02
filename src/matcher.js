"use strict";

const TOKEN_CHAR_RE = (() => {
  try {
    return new RegExp("[\\p{L}\\p{M}\\p{N}_]", "u");
  } catch (e) {
    return /[A-Za-z0-9_]/;
  }
})();

const BOUNDARYLESS_SCRIPT_RE = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;

function normalizePlainQuery(query) {
  return (query || "").trim();
}

/** Build a matcher from query + flags. Returns null if no query. */
function buildMatcher(query, caseSensitive, useRegex, wholeWord) {
  if (!query) return null;
  if (useRegex) {
    const useWordBoundaries = !!wholeWord && queryUsesWordBoundaries(query);
    try {
      return {
        regex: new RegExp(query, "g" + (caseSensitive ? "" : "i")),
        wholeWord: !!wholeWord,
        useWordBoundaries,
      };
    } catch (e) {
      return { invalid: true, error: e && e.message ? e.message : "Invalid regular expression" };
    }
  }

  const plainQuery = normalizePlainQuery(query);
  if (!plainQuery) return null;
  const useWordBoundaries = !!wholeWord && queryUsesWordBoundaries(plainQuery);
  return {
    needle: caseSensitive ? plainQuery : plainQuery.toLowerCase(),
    caseSensitive,
    wholeWord: !!wholeWord,
    useWordBoundaries,
  };
}

function isBoundarylessScriptChar(ch) {
  return !!ch && BOUNDARYLESS_SCRIPT_RE.test(ch);
}

function isSearchTokenChar(ch) {
  return !!ch && TOKEN_CHAR_RE.test(ch) && !isBoundarylessScriptChar(ch);
}

function edgeCharBefore(text, index) {
  if (index <= 0) return "";
  const chars = [...text.slice(Math.max(0, index - 2), index)];
  return chars[chars.length - 1] || "";
}

function edgeCharAfter(text, index) {
  if (index >= text.length) return "";
  return [...text.slice(index, index + 2)][0] || "";
}

function queryUsesWordBoundaries(query) {
  let hasTokenChar = false;
  for (const ch of query) {
    if (isBoundarylessScriptChar(ch)) return false;
    if (isSearchTokenChar(ch)) hasTokenChar = true;
  }
  return hasTokenChar;
}

function isWholeWordMatch(text, index, length, matcher) {
  if (!matcher.useWordBoundaries) return true;
  return (
    !isSearchTokenChar(edgeCharBefore(text, index)) &&
    !isSearchTokenChar(edgeCharAfter(text, index + length))
  );
}

/** Find every match of matcher in text. Returns [{ index, length }]. */
function findAll(text, matcher) {
  const out = [];
  if (!text || !matcher || matcher.invalid) return out;
  if (matcher.regex) {
    matcher.regex.lastIndex = 0;
    let m;
    while ((m = matcher.regex.exec(text)) !== null) {
      if (m[0].length === 0) {
        matcher.regex.lastIndex++;
        continue;
      }
      if (!matcher.wholeWord || isWholeWordMatch(text, m.index, m[0].length, matcher))
        out.push({ index: m.index, length: m[0].length });
    }
  } else {
    const hay = matcher.caseSensitive ? text : text.toLowerCase();
    const n = matcher.needle;
    let from = 0;
    while (true) {
      const i = hay.indexOf(n, from);
      if (i === -1) break;
      if (!matcher.wholeWord || isWholeWordMatch(text, i, n.length, matcher))
        out.push({ index: i, length: n.length });
      from = i + n.length;
    }
  }
  return out;
}

module.exports = {
  normalizePlainQuery,
  buildMatcher,
  findAll,
};
