import {
  Virtualizer,
  elementScroll,
  measureElement,
  observeElementOffset,
  observeElementRect,
} from "@tanstack/virtual-core";
import { DEFAULT_RESULT_ROW_HEIGHT } from "./constants.js";

const GROUP_ROW_HEIGHT = 30;
const RESULT_OVERSCAN = 10;

function emptyElement(el) {
  if (!el) return;
  if (typeof el.empty === "function") el.empty();
  else el.textContent = "";
}

function createDiv(parent, cls) {
  if (typeof parent.createDiv === "function") return parent.createDiv({ cls });
  const el = parent.ownerDocument.createElement("div");
  el.className = cls;
  parent.appendChild(el);
  return el;
}

function createSpan(parent, cls, text) {
  if (typeof parent.createSpan === "function")
    return parent.createSpan({ cls, text });
  const el = parent.ownerDocument.createElement("span");
  el.className = cls;
  el.textContent = text;
  parent.appendChild(el);
  return el;
}

function setText(el, text) {
  if (!el) return;
  if (typeof el.setText === "function") el.setText(text);
  else el.textContent = text;
}

function setClass(el, cls, on) {
  if (!el) return;
  if (typeof el.toggleClass === "function") el.toggleClass(cls, on);
  else el.classList.toggle(cls, on);
}

function scrollAlignFromBlock(block) {
  if (block === "center") return "center";
  if (block === "start") return "start";
  if (block === "end") return "end";
  return "auto";
}

export class VirtualResultList {
  constructor({ container, getCurrent, getGroupInfo, onAfterRender, renderRow }) {
    this.el = container;
    this.getCurrent = getCurrent;
    this.getGroupInfo = getGroupInfo;
    this.onAfterRender = onAfterRender;
    this.renderRow = renderRow;

    this.itemCount = 0;
    this.rows = [];
    this.matchRowByIndex = new Map();
    this.groupInfo = null;
    this.innerEl = null;
    this.stickyEl = null;
    this.renderedItems = new Map();
    this.activeRow = null;
    this.renderFrame = null;
    this.cleanupVirtualizer = null;

    this.virtualizer = new Virtualizer(this.virtualizerOptions(0));
    this.cleanupVirtualizer = this.virtualizer._didMount();
    this.virtualizer._willUpdate();
  }

  destroy() {
    this.cancelRender();
    if (this.cleanupVirtualizer) this.cleanupVirtualizer();
    this.cleanupVirtualizer = null;
    this.virtualizer = null;
    this.clearDom();
    this.el = null;
    this.rows = [];
    this.matchRowByIndex = new Map();
    this.activeRow = null;
  }

  clear() {
    this.cancelRender();
    this.itemCount = 0;
    this.rows = [];
    this.matchRowByIndex = new Map();
    this.groupInfo = null;
    this.activeRow = null;
    this.clearDom();
    this.configureVirtualizer(0);
  }

  setItems(itemCount, activeIndex) {
    this.cancelRender();
    this.itemCount = Math.max(0, Number(itemCount) || 0);
    this.rebuildRows();
    this.activeRow = null;
    this.clearDom();
    if (!this.itemCount || !this.rows.length) {
      this.configureVirtualizer(0);
      return;
    }

    this.createDom();
    this.configureVirtualizer(this.rows.length);
    if (this.virtualizer) this.virtualizer.measure();
    this.scheduleRender();
    this.setActive(activeIndex, { block: "center" });
  }

  virtualizerOptions(count) {
    return {
      count,
      getScrollElement: () => this.el,
      estimateSize: (index) => this.estimateSize(index),
      getItemKey: (index) => this.rowKey(index),
      overscan: RESULT_OVERSCAN,
      observeElementRect,
      observeElementOffset,
      scrollToFn: elementScroll,
      measureElement,
      onChange: () => this.scheduleRender(),
      initialRect: {
        width: this.el ? this.el.clientWidth || 340 : 340,
        height: this.el ? this.el.clientHeight || 320 : 320,
      },
    };
  }

  configureVirtualizer(count) {
    if (!this.virtualizer) return;
    this.virtualizer.setOptions(this.virtualizerOptions(count));
    this.virtualizer._willUpdate();
  }

  rebuildRows() {
    this.rows = [];
    this.matchRowByIndex = new Map();
    this.groupInfo = this.getGroupInfo ? this.getGroupInfo() : null;

    let lastGroupKey = null;
    for (let i = 0; i < this.itemCount; i++) {
      const groupItem =
        this.groupInfo && this.groupInfo.items ? this.groupInfo.items[i] : null;
      if (groupItem && groupItem.key !== lastGroupKey) {
        lastGroupKey = groupItem.key;
        this.rows.push({
          type: "group",
          key: groupItem.key,
          group: groupItem.group,
          totalInGroup: groupItem.totalInGroup,
        });
      }

      const rowIndex = this.rows.length;
      this.matchRowByIndex.set(i, rowIndex);
      this.rows.push({
        type: "match",
        key: `match:${i}`,
        matchIndex: i,
        groupKey: groupItem ? groupItem.key : null,
      });
    }
  }

  createDom() {
    if (!this.el) return;
    this.stickyEl = createDiv(this.el, "lf-virtual-sticky-group is-hidden");
    this.innerEl = createDiv(this.el, "lf-virtual-inner");
  }

  clearDom() {
    if (!this.el) return;
    this.renderedItems.clear();
    this.innerEl = null;
    this.stickyEl = null;
    emptyElement(this.el);
    if (this.virtualizer) this.virtualizer.measureElement(null);
  }

  estimateSize(index) {
    const row = this.rows[index];
    return row && row.type === "group" ? GROUP_ROW_HEIGHT : DEFAULT_RESULT_ROW_HEIGHT;
  }

  rowKey(index) {
    const row = this.rows[index];
    if (!row) return `row:${index}`;
    return row.type === "group" ? `group:${row.key}` : row.key;
  }

  rowIndexForMatch(matchIndex) {
    const rowIndex = this.matchRowByIndex.get(matchIndex);
    return Number.isFinite(rowIndex) ? rowIndex : -1;
  }

  current() {
    const current = this.getCurrent ? this.getCurrent() : -1;
    return Number.isFinite(current) ? current : -1;
  }

  scheduleRender() {
    const el = this.el;
    if (!el || this.renderFrame != null) return;
    const win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    this.renderFrame = win.requestAnimationFrame(() => {
      this.renderFrame = null;
      this.render();
    });
  }

  cancelRender() {
    if (this.renderFrame == null || !this.el) {
      this.renderFrame = null;
      return;
    }
    const win = (this.el.ownerDocument && this.el.ownerDocument.defaultView) || window;
    win.cancelAnimationFrame(this.renderFrame);
    this.renderFrame = null;
  }

  render() {
    if (!this.el || !this.innerEl || !this.virtualizer) return;

    const virtualItems = this.virtualizer.getVirtualItems();
    const totalSize = this.virtualizer.getTotalSize();
    this.innerEl.style.height = `${Math.max(0, totalSize)}px`;

    const liveKeys = new Set();
    for (const virtualRow of virtualItems) {
      const key = String(virtualRow.key);
      liveKeys.add(key);
      let itemEl = this.renderedItems.get(key);
      if (!itemEl) {
        itemEl = createDiv(this.innerEl, "lf-virtual-item");
        this.renderedItems.set(key, itemEl);
      }

      itemEl.dataset.index = String(virtualRow.index);
      itemEl.style.transform = `translateY(${virtualRow.start}px)`;
      if (itemEl.dataset.rowKey !== key) {
        itemEl.dataset.rowKey = key;
        this.renderVirtualRow(itemEl, virtualRow.index);
      }
      this.virtualizer.measureElement(itemEl);
    }

    for (const [key, itemEl] of this.renderedItems) {
      if (liveKeys.has(key)) continue;
      itemEl.remove();
      this.renderedItems.delete(key);
    }
    this.virtualizer.measureElement(null);

    this.updateStickyGroup(virtualItems);
    this.applyActiveClass(false);
    if (this.onAfterRender) this.onAfterRender();
  }

  renderVirtualRow(itemEl, rowIndex) {
    const row = this.rows[rowIndex];
    emptyElement(itemEl);
    if (!row) return;

    if (row.type === "group") {
      this.renderGroup(itemEl, row);
      return;
    }

    const state = {
      lastGroupKey: row.groupKey,
      suppressGroupHeader: true,
    };
    const rendered = this.renderRow
      ? this.renderRow(row.matchIndex, this.groupInfo, state, itemEl)
      : null;
    if (rendered && row.matchIndex === this.current()) {
      rendered.addClass ? rendered.addClass("is-active") : rendered.classList.add("is-active");
      this.activeRow = rendered;
    }
  }

  renderGroup(parent, row) {
    const groupEl = createDiv(parent, "lf-group");
    groupEl.dataset.groupKey = row.key;
    groupEl.dataset.groupTitle = row.group ? row.group.text : "";
    groupEl.dataset.groupTotal = String(row.totalInGroup || 0);
    createSpan(groupEl, "lf-group-title", row.group ? row.group.text : "No heading");
    createSpan(groupEl, "lf-group-count", String(row.totalInGroup || 0));
  }

  updateStickyGroup(virtualItems) {
    if (!this.stickyEl) return;
    if (!this.groupInfo || !this.rows.length || !virtualItems.length) {
      setClass(this.stickyEl, "is-hidden", true);
      emptyElement(this.stickyEl);
      return;
    }

    const first = virtualItems[0];
    const scrollOffset = this.virtualizer ? this.virtualizer.scrollOffset || 0 : 0;
    const firstRow = this.rows[first.index];
    if (
      firstRow &&
      firstRow.type === "group" &&
      Math.abs(first.start - scrollOffset) < 4
    ) {
      setClass(this.stickyEl, "is-hidden", true);
      emptyElement(this.stickyEl);
      return;
    }

    let groupRow = null;
    for (let i = first.index; i >= 0; i--) {
      const row = this.rows[i];
      if (row && row.type === "group") {
        groupRow = row;
        break;
      }
    }

    if (!groupRow) {
      setClass(this.stickyEl, "is-hidden", true);
      emptyElement(this.stickyEl);
      return;
    }

    emptyElement(this.stickyEl);
    this.renderGroup(this.stickyEl, groupRow);
    setClass(this.stickyEl, "is-hidden", false);
  }

  applyActiveClass(scroll) {
    if (!this.el) return;
    const current = this.current();
    const row =
      current >= 0
        ? this.el.querySelector(`.lf-row[data-match-index="${current}"]`)
        : null;
    if (this.activeRow && this.activeRow !== row && this.activeRow.isConnected) {
      this.activeRow.classList.remove("is-active");
    }
    if (row) row.classList.add("is-active");
    this.activeRow = row || null;
    if (scroll && row) {
      row.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  setActive(index, options = {}) {
    if (!this.el || !this.virtualizer) return;
    const rowIndex = this.rowIndexForMatch(index);
    if (rowIndex < 0) {
      this.applyActiveClass(false);
      if (this.onAfterRender) this.onAfterRender();
      return;
    }

    if (options.scroll !== false) {
      this.virtualizer.scrollToIndex(rowIndex, {
        align: scrollAlignFromBlock(options.block),
      });
    }
    this.scheduleRender();
    this.applyActiveClass(false);
    if (this.onAfterRender) this.onAfterRender();
  }
}
