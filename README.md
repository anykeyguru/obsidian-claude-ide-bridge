# Claude IDE Bridge for Obsidian

Obsidian desktop plugin that implements the Claude Code IDE integration protocol (lock file in `~/.claude/ide` + MCP over a local WebSocket). Run `claude` in a terminal, type `/ide`, pick **Obsidian** — Claude sees the active note and the current selection.

Supported views:

- Markdown notes (editor selection, `Send to Claude` command and context menu).
- Built-in PDF viewer and every Omni Viewer tab: the DOM text selection is remembered, including selections inside shadow roots; for PDFs the page range is reported.
- HTML in Omni Viewer: the page runs in a sandboxed iframe, so the viewer must post `{ omniViewerSelection: <text> }` to the parent window on `selectionchange` (done in the omni-viewer fork, `fork/trusted-html`).

No dependencies, no build step: `main.js` is plain CommonJS.

## Install

```sh
./deploy.sh "/path/to/vault"
```

Then enable **Claude IDE Bridge** in Settings → Community plugins (or reload Obsidian if it is already enabled).
