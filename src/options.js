"use strict";

const { DEFAULT_FIND_OPTIONS } = require("./constants");

function normalizeHeadingGroupLevel(value) {
  const n = Number(value);
  if (Number.isInteger(n) && n >= 1 && n <= 6) return n;
  return DEFAULT_FIND_OPTIONS.headingGroupLevel;
}

function headingLevelLabel(level) {
  return `H${normalizeHeadingGroupLevel(level)}`;
}

function headingLevelMenuLabel(level) {
  return `Heading ${normalizeHeadingGroupLevel(level)}`;
}

function normalizeFindOptions(options) {
  const src = options && typeof options === "object" ? options : {};
  const savedRemovedTopLevel = src.headingGroupLevel === "top";
  return {
    caseSensitive:
      typeof src.caseSensitive === "boolean"
        ? src.caseSensitive
        : DEFAULT_FIND_OPTIONS.caseSensitive,
    useRegex:
      typeof src.useRegex === "boolean"
        ? src.useRegex
        : DEFAULT_FIND_OPTIONS.useRegex,
    wholeWord:
      typeof src.wholeWord === "boolean"
        ? src.wholeWord
        : DEFAULT_FIND_OPTIONS.wholeWord,
    groupResults:
      typeof src.groupResults === "boolean"
        ? src.groupResults && !savedRemovedTopLevel
        : DEFAULT_FIND_OPTIONS.groupResults,
    headingGroupLevel: normalizeHeadingGroupLevel(src.headingGroupLevel),
    showResultHeadings:
      typeof src.showResultHeadings === "boolean"
        ? src.showResultHeadings
        : DEFAULT_FIND_OPTIONS.showResultHeadings,
  };
}

module.exports = {
  normalizeHeadingGroupLevel,
  headingLevelLabel,
  headingLevelMenuLabel,
  normalizeFindOptions,
};
