import {
  DEFAULT_RESULT_ROW_HEIGHT,
  RESULT_DISPLAY_CAP,
  RESULT_IDLE_PREFETCH_BATCH,
  RESULT_RENDER_AHEAD_PX,
  RESULT_RENDER_BATCH,
} from "./constants.js";
import { getElementWindow } from "./dom-resolve.js";

export class VirtualResultList {
  constructor({ container, getCurrent, getGroupInfo, onAfterRender, renderRow }) {
    this.el = container;
    this.getCurrent = getCurrent;
    this.getGroupInfo = getGroupInfo;
    this.onAfterRender = onAfterRender;
    this.renderRow = renderRow;

    this.itemCount = 0;
    this.renderLimit = RESULT_RENDER_BATCH;
    this.renderedCount = 0;
    this.renderedGroupKey = null;
    this.activeRow = null;
    this.observer = null;
    this.sentinelEl = null;
    this.spacerEl = null;
    this.moreBtnEl = null;
    this.displayLimit = 0;
    this.averageRowHeight = DEFAULT_RESULT_ROW_HEIGHT;
    this.renderToken = 0;
    this.scrollFrame = null;
    this.scrollWindow = null;
    this.prefetchId = null;
    this.prefetchKind = null;
    this.prefetchWindow = null;
    this.catchupFrame = null;
    this.catchupWindow = null;
    this.onScroll = null;

    this.setupObserver();
  }

  destroy() {
    this.disconnectObserver();
    this.cancelPrefetch();
    this.cancelCatchup();
    this.cancelScrollCheck();
    this.clearTail();
    if (this.el) this.el.empty();
    this.el = null;
    this.itemCount = 0;
    this.activeRow = null;
  }

  clear() {
    this.renderToken += 1;
    this.cancelPrefetch();
    this.cancelCatchup();
    this.cancelScrollCheck();
    this.clearTail();
    if (this.el) this.el.empty();
    this.renderLimit = RESULT_RENDER_BATCH;
    this.renderedCount = 0;
    this.renderedGroupKey = null;
    this.activeRow = null;
    this.displayLimit = 0;
    this.averageRowHeight = DEFAULT_RESULT_ROW_HEIGHT;
  }

  setItems(itemCount, activeIndex) {
    const el = this.el;
    if (!el) return;
    this.clear();
    this.itemCount = Math.max(0, Number(itemCount) || 0);
    if (!this.itemCount) return;

    el.scrollTop = 0;
    this.displayLimit = Math.min(this.itemCount, RESULT_DISPLAY_CAP);
    this.ensureCapCovers(activeIndex);
    this.renderLimit = Math.min(
      this.displayLimit || this.itemCount,
      Math.max(RESULT_RENDER_BATCH, activeIndex + 1)
    );
    this.renderChunk(this.renderLimit);
    this.setActive(activeIndex, { block: "center" });
    this.schedulePrefetch();
  }

  ensureCapCovers(index) {
    if (index == null || index < 0) return;
    if (index < this.displayLimit) return;
    const steps = Math.ceil((index + 1) / RESULT_DISPLAY_CAP);
    this.displayLimit = Math.min(this.itemCount, steps * RESULT_DISPLAY_CAP);
  }

  renderChunk(targetCount) {
    const el = this.el;
    if (!el || !this.itemCount) return false;

    const groupInfo = this.getGroupInfo ? this.getGroupInfo() : null;
    const start = this.renderedCount || 0;
    const limit = Math.min(this.displayLimit || this.itemCount, this.itemCount);
    const end = Math.min(limit, targetCount);
    if (end <= start) return false;

    const keepScrollTop = el.scrollTop;
    this.clearTail();

    const state = { lastGroupKey: this.renderedGroupKey };
    const activeIndex = this.current();
    for (let i = start; i < end; i++) {
      const row = this.renderRow ? this.renderRow(i, groupInfo, state) : null;
      if (row && i === activeIndex) {
        row.addClass("is-active");
        this.activeRow = row;
      }
    }

    this.renderedCount = end;
    this.renderedGroupKey = state.lastGroupKey;
    this.updateAverageHeight(el.scrollHeight, this.renderedCount);
    this.updateTail();
    el.scrollTop = keepScrollTop;
    return true;
  }

  ensureRendered(index) {
    if (index < 0 || index >= this.itemCount) return false;
    if (index < (this.renderedCount || 0)) return true;
    this.ensureCapCovers(index);
    this.renderLimit = Math.min(
      this.displayLimit || this.itemCount,
      Math.max(index + 1, (this.renderedCount || 0) + RESULT_RENDER_BATCH)
    );
    const changed = this.renderChunk(this.renderLimit);
    if (changed && this.onAfterRender) this.onAfterRender();
    return index < (this.renderedCount || 0);
  }

  setupObserver() {
    const el = this.el;
    if (!el) return;
    this.disconnectObserver();

    this.onScroll = () => this.scheduleScrollCheck();
    el.addEventListener("scroll", this.onScroll, { passive: true });

    const win = getElementWindow(el);
    if (win && typeof win.IntersectionObserver === "function") {
      this.observer = new win.IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            this.maybeRenderMore({ force: true });
          }
        },
        {
          root: el,
          rootMargin: `0px 0px ${RESULT_RENDER_AHEAD_PX}px 0px`,
          threshold: 0,
        }
      );
    }
  }

  disconnectObserver() {
    if (this.observer) this.observer.disconnect();
    this.observer = null;
    this.cancelScrollCheck();

    if (this.el && this.onScroll) {
      this.el.removeEventListener("scroll", this.onScroll);
    }
    this.onScroll = null;
    this.sentinelEl = null;
    this.spacerEl = null;
    this.moreBtnEl = null;
  }

  scheduleScrollCheck() {
    const el = this.el;
    if (!el || this.scrollFrame != null) return;
    const win = getElementWindow(el);
    this.scrollWindow = win;
    this.scrollFrame = win.requestAnimationFrame(() => {
      this.scrollFrame = null;
      this.scrollWindow = null;
      this.maybeRenderMore();
    });
  }

  cancelScrollCheck() {
    if (this.scrollFrame == null) return;
    const win = this.scrollWindow || (this.el ? getElementWindow(this.el) : null);
    if (win && typeof win.cancelAnimationFrame === "function") {
      win.cancelAnimationFrame(this.scrollFrame);
    }
    this.scrollFrame = null;
    this.scrollWindow = null;
  }

  clearTail() {
    if (this.sentinelEl) {
      if (this.observer) this.observer.unobserve(this.sentinelEl);
      this.sentinelEl.remove();
      this.sentinelEl = null;
    }
    if (this.spacerEl) {
      this.spacerEl.remove();
      this.spacerEl = null;
    }
    if (this.moreBtnEl) {
      this.moreBtnEl.remove();
      this.moreBtnEl = null;
    }
  }

  updateAverageHeight(totalRowsHeight, renderedCount) {
    if (renderedCount <= 0 || totalRowsHeight <= 0) return;
    const sample = totalRowsHeight / renderedCount;
    if (!Number.isFinite(sample) || sample < 12) return;
    this.averageRowHeight = sample;
  }

  updateTail() {
    const el = this.el;
    if (!el || !this.itemCount) return;
    this.clearTail();

    const limit = Math.min(this.displayLimit || this.itemCount, this.itemCount);
    const rendered = this.renderedCount || 0;

    if (rendered < limit) {
      this.sentinelEl = el.createDiv({ cls: "lf-sentinel" });
      if (this.observer) this.observer.observe(this.sentinelEl);
      this.spacerEl = el.createDiv({ cls: "lf-spacer" });
      this.spacerEl.style.height = `${Math.max(
        0,
        Math.round(
          (limit - rendered) *
            (this.averageRowHeight || DEFAULT_RESULT_ROW_HEIGHT)
        )
      )}px`;
    }

    if (limit < this.itemCount) {
      this.moreBtnEl = el.createEl("button", { cls: "lf-btn lf-more-btn" });
      this.moreBtnEl.setText(`Show more (${this.itemCount - limit} hidden)`);
      this.moreBtnEl.onclick = () => this.expandCap();
    }
  }

  expandCap() {
    if (!this.el || this.displayLimit >= this.itemCount) return;
    this.displayLimit = Math.min(
      this.itemCount,
      this.displayLimit + RESULT_DISPLAY_CAP
    );
    this.renderLimit = Math.max(
      this.renderLimit || RESULT_RENDER_BATCH,
      (this.renderedCount || 0) + RESULT_RENDER_BATCH
    );
    if (!this.renderChunk(this.renderLimit)) this.updateTail();
    if (this.onAfterRender) this.onAfterRender();
    this.schedulePrefetch();
  }

  isNearBottom() {
    const el = this.el;
    if (!el) return false;
    const tailTop = this.sentinelEl ? this.sentinelEl.offsetTop : el.scrollHeight;
    return el.scrollTop + el.clientHeight >= tailTop - RESULT_RENDER_AHEAD_PX;
  }

  maybeRenderMore(options = {}) {
    const limit = Math.min(this.displayLimit || this.itemCount, this.itemCount);
    if (!this.el || !this.itemCount || (this.renderedCount || 0) >= limit) return;
    if (!options.force && !this.isNearBottom()) return;

    this.renderLimit = Math.min(
      limit,
      Math.max(
        this.renderLimit || RESULT_RENDER_BATCH,
        (this.renderedCount || 0) + RESULT_RENDER_BATCH
      )
    );
    if (this.renderChunk(this.renderLimit)) {
      if (this.onAfterRender) this.onAfterRender();
      this.schedulePrefetch();
      if (this.isNearBottom()) this.scheduleCatchup();
    }
  }

  schedulePrefetch() {
    const el = this.el;
    if (!el || this.prefetchId != null || !this.itemCount) return;

    const cap = Math.min(this.displayLimit || this.itemCount, this.itemCount);
    if ((this.renderedCount || 0) >= cap) return;

    const win = getElementWindow(el);
    const token = this.renderToken;
    const run = () => {
      this.prefetchId = null;
      this.prefetchKind = null;
      this.prefetchWindow = null;

      if (token !== this.renderToken || !this.el || !this.itemCount) return;

      const limit = Math.min(this.displayLimit || this.itemCount, this.itemCount);
      if ((this.renderedCount || 0) >= limit) return;

      const scrollTop = this.el.scrollTop;
      const target = Math.min(
        limit,
        (this.renderedCount || 0) + RESULT_IDLE_PREFETCH_BATCH
      );
      if (this.renderChunk(target)) {
        this.el.scrollTop = scrollTop;
        if (this.onAfterRender) this.onAfterRender();
      }
      this.schedulePrefetch();
    };

    if (win && typeof win.requestIdleCallback === "function") {
      this.prefetchKind = "idle";
      this.prefetchId = win.requestIdleCallback(run, { timeout: 350 });
    } else {
      this.prefetchKind = "timeout";
      this.prefetchId = win.setTimeout(run, 80);
    }
    this.prefetchWindow = win;
  }

  cancelPrefetch() {
    if (this.prefetchId == null) return;
    const win = this.prefetchWindow || (this.el ? getElementWindow(this.el) : null);
    if (
      this.prefetchKind === "idle" &&
      win &&
      typeof win.cancelIdleCallback === "function"
    ) {
      win.cancelIdleCallback(this.prefetchId);
    } else if (win && typeof win.clearTimeout === "function") {
      win.clearTimeout(this.prefetchId);
    }
    this.prefetchId = null;
    this.prefetchKind = null;
    this.prefetchWindow = null;
  }

  scheduleCatchup() {
    const el = this.el;
    if (!el || this.catchupFrame != null) return;
    const win = getElementWindow(el);
    this.catchupWindow = win;
    this.catchupFrame = win.requestAnimationFrame(() => {
      this.catchupFrame = null;
      this.catchupWindow = null;
      this.maybeRenderMore();
    });
  }

  cancelCatchup() {
    if (this.catchupFrame == null) return;
    const win = this.catchupWindow || (this.el ? getElementWindow(this.el) : null);
    if (win && typeof win.cancelAnimationFrame === "function") {
      win.cancelAnimationFrame(this.catchupFrame);
    }
    this.catchupFrame = null;
    this.catchupWindow = null;
  }

  current() {
    const current = this.getCurrent ? this.getCurrent() : -1;
    return Number.isFinite(current) ? current : -1;
  }

  setActive(index, options = {}) {
    if (!this.el) return;
    const shouldScroll = options.scroll !== false;
    this.ensureRendered(index);
    const previous =
      this.activeRow && this.activeRow.isConnected ? this.activeRow : null;
    const row =
      index >= 0
        ? this.el.querySelector(`.lf-row[data-match-index="${index}"]`)
        : null;
    if (previous && previous !== row) previous.classList.remove("is-active");
    if (row) {
      row.classList.add("is-active");
      if (shouldScroll) {
        row.scrollIntoView({
          block: options.block || "nearest",
          inline: "nearest",
        });
      }
    }
    this.activeRow = row || null;
    if (this.onAfterRender) this.onAfterRender();
  }
}
