"use strict";

const { Plugin, MarkdownView, Notice } = require("obsidian");
const { HL_ALL, HL_CURRENT } = require("./constants");
const { normalizeFindOptions } = require("./options");
const { debugWarn } = require("./utils");
const { FindBar } = require("./find-bar");

module.exports = class LiveFindPlugin extends Plugin {
  async onload() {
    await this.loadPluginData();


    this.bar = null;

    this.addCommand({
      id: "open-find-bar",
      name: "Open find bar",
      callback: () => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return new Notice("Open a Markdown note first.");
        if (!(window.CSS && CSS.highlights && window.Highlight))
          return new Notice("This Obsidian version lacks the CSS Highlight API.");
        if (this.bar && this.bar.view !== view) this.bar.close();
        if (!this.bar || !this.bar.isOpen()) this.bar = new FindBar(this, view);
        this.bar.open();
      },
    });

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        if (this.bar) this.bar.close();
      })
    );
  }

  async loadPluginData() {
    try {
      this.data = (await this.loadData()) || {};
    } catch (e) {
      debugWarn("loadData", e);
      this.data = {};
    }
    this.findOptions = normalizeFindOptions(this.data.findOptions);
  }

  getFindOptions() {
    return normalizeFindOptions(this.findOptions);
  }

  saveFindOptions(options) {
    this.findOptions = normalizeFindOptions(options);
    const data = this.data && typeof this.data === "object" ? this.data : {};
    this.data = { ...data, findOptions: this.findOptions };
    this.saveData(this.data).catch((e) => debugWarn("save find options", e));
  }

  onunload() {
    if (this.bar) this.bar.close();
    if (window.CSS && CSS.highlights) {
      CSS.highlights.delete(HL_ALL);
      CSS.highlights.delete(HL_CURRENT);
    }
  }
};
