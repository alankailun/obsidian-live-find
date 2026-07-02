# Live Find

A Chrome-style find bar for the current note in [Obsidian](https://obsidian.md).

Obsidian's built-in search shines across the vault, but finding and highlighting
text **within the rendered content of a single note** — especially inside tables
in Live Preview — is awkward. Live Find fixes that with a floating top-right
find bar, a complete result list, and highlighting painted directly on the
rendered text (tables included).

## Features

- **Whole-note search** from the source, so the result list and count are always
  complete — nothing is missed due to virtual scrolling.
- **Rendered highlighting** via the CSS Custom Highlight API: matches light up on
  the *rendered* content (table cells, body text) in both Live Preview and
  Reading mode, without flipping rows back to raw Markdown.
- **Precise current-match highlight in tables**, mapped cell-by-cell from the
  source so the active match never lands on the wrong word.
- **Result list** with line numbers and the matched term **bolded** in context;
  click any row to jump. Results can be grouped by a chosen heading level, and
  per-row heading hints can be toggled. Group headings stick while scrolling,
  and the active heading count shows the match's position within that group.
- **Match case** (`Aa`), **regular expression** (`.*`), and smarter
  **whole word** (`W`) toggles. Toggle choices are remembered.
- **Chrome-like plain searches** ignore leading/trailing spaces, and pasted
  search text is trimmed automatically.
- **Prefill from selection** — select a word, trigger the command, and it's
  searched instantly.
- **Keyboard navigation** — `Enter` / `↓` next, `Shift+Enter` / `↑` previous,
  `Esc` to close.

## Usage

Run the command **"Open find bar"**. The bar appears at the top-right
of the note.

To use it as a true browser-style `Cmd/Ctrl+F`, bind the command in
**Settings -> Hotkeys** (you may need to unbind Obsidian's built-in
"Search current file" first).

## Install (manual)

1. Download `main.js`, `manifest.json`, and `styles.css` from a release.
2. Copy them into `<your vault>/.obsidian/plugins/live-find/`.
3. Reload Obsidian and enable **Live Find** in
   **Settings -> Community plugins**.

## Development

Source code lives in `src/`. Run `npm install` once, then `npm run build` to
bundle the plugin into the root `main.js` file that Obsidian loads.

## Limitations

Highlighting relies on rendered DOM, and Obsidian virtualizes off-screen
content. The **result list is always complete** (it reads the source), but the
yellow "all matches" highlight only paints what is currently rendered — scroll,
and newly rendered matches light up automatically. Reading mode renders the most
completely.

## License

[MIT](LICENSE)
