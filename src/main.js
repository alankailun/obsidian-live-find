import { MarkdownView, Notice, Plugin } from "obsidian";
import { debugWarn, normalizeFindOptions } from "./constants.js";
import { FindBar } from "./find-bar.js";
import { getHighlightSupport } from "./highlighter.js";

export default class LiveFindPlugin extends Plugin {
  async onload() {
    await this.loadPluginData();


    this.bar = null;

    this.addCommand({
      id: "open-find-bar",
      name: "Open find bar",
      callback: () => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return new Notice("Open a Markdown note first.");
        if (!getHighlightSupport(view))
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
  }
};
