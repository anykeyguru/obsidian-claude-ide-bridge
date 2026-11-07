# Claude IDE Bridge for Obsidian

Obsidian desktop plugin that implements the Claude Code IDE integration protocol (lock file in `~/.claude/ide` + MCP over a local WebSocket). Run `claude` in a terminal, type `/ide`, pick **Obsidian** — Claude sees the active note and the current selection. It also opens structured files inside Obsidian and turns them into review pages.

## Install

You need Obsidian desktop and the Claude Code CLI. Pick one way.

**With BRAT, inside Obsidian.** Updates arrive by themselves.

1. Settings → Community plugins → Browse. Search for `BRAT`, then press **Install** and **Enable**.
2. Open **BRAT: Add a beta plugin**, enter `anykeyguru/obsidian-claude-ide-bridge`.
3. Enable **Claude IDE Bridge** in Community plugins.

**By hand.** Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/anykeyguru/obsidian-claude-ide-bridge/releases/latest) into `<vault>/.obsidian/plugins/claude-ide-bridge/`, then enable the plugin.

**From source.** Needs Node:

```sh
./deploy.sh "/path/to/vault"
```

Then run `claude` in a terminal, type `/ide` and pick **Obsidian**.

## Supported files

- Markdown notes: editor selection, `Send to Claude` command and context menu.
- PDF, in Obsidian's own viewer: the text selection is remembered, and the page range is reported.
- HTML: **Editor**, **Viewer** or **Both** on one screen. The selection from either pane reaches Claude.
- JSON, YAML, TOML, JSONL: the same three modes, with a collapsible tree as the viewer.
- CSV and TSV: a table; the separator (`,`, `;`, tab) is detected.
- Mermaid (`.mmd`, `.mermaid`): the diagram, drawn by Obsidian's own Mermaid.
- Safetensors: header, metadata and tensor list, without loading the weights.
- SQL, JSONC, XML, TXT, LOG and INI: an editor tab inside Obsidian instead of the system default app.

If another plugin already owns an extension, use **Open in Claude IDE Bridge** from the file menu.

HTML pages run in a sandboxed iframe with an opaque origin: their scripts work, but they cannot reach Obsidian or the vault. A page can read and write only its neighbour `<name>.comments.json`, over `postMessage` on the `comments` channel (`ping`, `theme`, `read`, `write`).

## Review pages

**Build review page** in the file menu turns JSON, JSONL, YAML, TOML, CSV, TSV or SQL into `<name>.review.html`: each key is coloured by class, and a click opens a field passport with comments and approval. SQL reads `CREATE TABLE` statements or a list of `name type` lines, and fills the passport with type, nullability, keys, defaults, references and comments.

No model is involved: the same input always gives the same page. Rebuilding keeps the discussion in `<name>.review.comments.json` and marks changed fields as changed. Fields the data says nothing about get empty inputs in the passport.

To add what the data cannot say, write `<name>.fields.yaml` next to the file:

```yaml
title: Scoring response
fields:
  result.score: { class: model, title: Model score, status: partly, owner: Data science }
  orders:id: { class: static, title: Order number }
```

Keys are paths, or `table:column` for SQL. The file may also set `lang`, `groups`, `classes`, `statuses`, `statusLabel` and `attributes`.

Outside Obsidian, the same generator runs from the skill folder:

```sh
node .claude/skills/html-review-doc/build-review.cjs data.yaml --lang ru
```

## Skills

On load the plugin writes its skills into the vault's `.claude/` folder, where Claude Code finds them in any session started in the vault. Files you changed or deleted are left alone.

- `html-review-doc`: builds review pages from structured data, and single-file HTML documents with tabs, per-item comments and approvals.

## Limits

The plugin shares a process with Obsidian, so large files are handled with care. All limits live in `src/limits.js`.

- A text file over 32 MB opens as its first 256 KB, read-only, and is never written back.
- Viewers parse up to 16 MB of text, YAML up to 4 MB. Larger files stay in the Editor.
- Trees, tables and long JSON arrays show pages, and the rest loads on request.
- Binary formats read only the bytes they need.
- A review page embeds its data: sources over 8 MB are refused, and CSV, TSV and JSONL are sampled to their first 20 rows.

## Develop

```sh
npm ci
npm test
npm run coverage
npm run build
```

`main.js` is generated from `src/` and is not tracked. Every file type is one record in `src/formats`. Pushing a tag equal to the version in `manifest.json` runs the tests and publishes a release. Benchmarks behind performance decisions are in `docs/perf/`.
