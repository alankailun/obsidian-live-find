"use strict";

const { DEBUG } = require("./constants");

function debugWarn(where, err) {
  if (!DEBUG) return;
  console.warn(`[LiveFind] ${where}`, err);
}

function debounce(fn, ms) {
  let t;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => {
    clearTimeout(t);
    t = null;
  };
  return wrapped;
}

module.exports = { debugWarn, debounce };
