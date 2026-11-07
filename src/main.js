'use strict';

// Claude IDE Bridge: implements the Claude Code IDE integration protocol
// (lock file in ~/.claude/ide + MCP over a local WebSocket) so that the
// terminal `claude` can connect via /ide and see the active note/selection,
// and opens every supported file type inside Obsidian.

const {
  Plugin, Notice, FileSystemAdapter, TFile, debounce,
} = require('obsidian');
const crypto = require('crypto');

const { WsConnection } = require('./ws');
const { TOOLS } = require('./tools');
const { KIT_FILES, TEMPLATE } = require('./kit');
const { installKit } = require('./kit/install');
const {
  buildReviewHtml, parseMeta, isGeneratedPage, SOURCE_EXTENSIONS,
} = require('./review/build');
const { FORMATS, formatFor } = require('./formats');
const { TextFormatView, BinaryFormatView, viewTypeOf } = require('./views');
const { TEXT_VIEW, BINARY_VIEW } = require('./view-types');
const { handleMcpMessage } = require('./mcp');
const { handlePageMessage } = require('./page-bridge');
const { startIdeServer } = require('./ide-server');
const { writeLockFile, removeLockFile } = require('./lock-file');
const {
  isDomView, isFileView, shadowSelection, pageOf, selectionPayload, sameSelection,
} = require('./selection');

const { MAX_REVIEW_SOURCE_BYTES } = require('./limits');

const DEFAULT_SETTINGS = { modes: {}, kit: {} };
const PUSH_DELAY_MS = 100;
const CAPTURE_DELAY_MS = 50;

module.exports = class ClaudeIdeBridge extends Plugin {
  async onload() {
    if (!(this.app.vault.adapter instanceof FileSystemAdapter)) {
      new Notice('Claude IDE Bridge: desktop only');
      return;
    }
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
    this.registerFileViews();
    this.basePath = this.app.vault.adapter.getBasePath();
    this.installKit();
    this.clients = new Set();
    this.lastView = null;
    this.latest = null;
    this.domSel = null;
    this.authToken = crypto.randomUUID();
    this.mcpHost = {
      version: this.manifest.version,
      tools: TOOLS,
      context: this,
      onInitialized: () => this.pushSelection(true),
    };

    this.server = await startIdeServer(this.authToken, (socket) => this.addClient(socket));
    this.port = this.server.address().port;
    writeLockFile(this.port, this.basePath, this.authToken);

    // Shells spawned from Obsidian after this point (e.g. the Terminal
    // plugin) inherit these, so `claude` started there auto-connects.
    process.env.CLAUDE_CODE_SSE_PORT = String(this.port);
    process.env.ENABLE_IDE_INTEGRATION = 'true';

    this.schedulePush = debounce(() => this.pushSelection(false), PUSH_DELAY_MS, true);
    this.scheduleCapture = debounce(() => this.captureDomSelection(), CAPTURE_DELAY_MS, true);
    const schedule = () => this.schedulePush();
    this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => {
      if (leaf && isFileView(leaf.view)) this.lastView = leaf.view;
      schedule();
    }));
    this.registerEvent(this.app.workspace.on('editor-change', schedule));
    this.registerEvent(this.app.workspace.on('file-open', schedule));
    this.registerDomEvent(document, 'selectionchange', () => {
      this.scheduleCapture();
      schedule();
    });
    this.registerDomEvent(window, 'message', (e) => this.onPageMessage(e));
    this.registerDomEvent(document, 'mouseup', schedule);
    this.registerDomEvent(document, 'keyup', schedule);
    this.registerDomEvent(window, 'beforeunload', () => removeLockFile(this.port));

    this.addCommand({
      id: 'send-selection',
      name: 'Send selection to Claude',
      editorCallback: (editor, view) => this.sendAtMention(editor, view),
    });
    this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, view) => {
      menu.addItem((item) => item
        .setTitle('Send to Claude')
        .setIcon('bot')
        .onClick(() => this.sendAtMention(editor, view)));
    }));

    this.currentView();
    console.log(`[claude-ide-bridge] listening on 127.0.0.1:${this.port}`);
  }

  onunload() {
    if (this.schedulePush) this.schedulePush.cancel();
    if (this.scheduleCapture) this.scheduleCapture.cancel();
    if (this.clients) for (const c of this.clients) c.close();
    if (this.server) this.server.close();
    if (this.port) removeLockFile(this.port);
    if (process.env.CLAUDE_CODE_SSE_PORT === String(this.port)) {
      delete process.env.CLAUDE_CODE_SSE_PORT;
      delete process.env.ENABLE_IDE_INTEGRATION;
    }
  }

  addClient(socket) {
    this.clients.add(new WsConnection(
      socket,
      (conn, raw) => handleMcpMessage(this.mcpHost, conn, raw),
      (conn) => this.clients.delete(conn),
    ));
  }

  // Skills are a convenience: failing to write them must not stop the bridge.
  async installKit() {
    try {
      this.settings.kit = await installKit(this.basePath, KIT_FILES, this.settings.kit);
      await this.saveData(this.settings);
    } catch (e) {
      console.warn('[claude-ide-bridge] could not install skills', e);
    }
  }

  registerFileViews() {
    this.registerView(TEXT_VIEW, (leaf) => new TextFormatView(leaf, this));
    this.registerView(BINARY_VIEW, (leaf) => new BinaryFormatView(leaf, this));
    for (const format of FORMATS) {
      for (const extension of format.extensions) {
        // Throws when another plugin already owns the extension; the file
        // menu item and the command below still open the file here.
        try {
          this.registerExtensions([extension], viewTypeOf(format));
        } catch (e) {
          console.warn(`[claude-ide-bridge] .${extension} is handled by another plugin`);
        }
      }
    }
    const open = (file) => this.app.workspace.getLeaf(false)
      .setViewState({ type: viewTypeOf(formatFor(file.extension)), state: { file: file.path }, active: true });
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (!(file instanceof TFile) || !formatFor(file.extension)) return;
      menu.addItem((item) => item
        .setTitle('Open in Claude IDE Bridge')
        .setIcon('file-code')
        .onClick(() => open(file)));
    }));
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (!(file instanceof TFile) || !SOURCE_EXTENSIONS.includes(file.extension.toLowerCase())) return;
      menu.addItem((item) => item
        .setTitle('Build review page')
        .setIcon('file-check')
        .onClick(() => this.buildReviewPage(file)));
    }));
    this.addCommand({
      id: 'build-review-page',
      name: 'Build review page from current file',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !SOURCE_EXTENSIONS.includes(file.extension.toLowerCase())) return false;
        if (!checking) this.buildReviewPage(file);
        return true;
      },
    });
    this.addCommand({
      id: 'open-in-bridge',
      name: 'Open current file in Claude IDE Bridge',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !formatFor(file.extension)) return false;
        if (!checking) open(file);
        return true;
      },
    });
  }

  // ---- review pages -------------------------------------------------------

  async readReviewMeta(base) {
    const { adapter } = this.app.vault;
    for (const suffix of ['.fields.yaml', '.fields.yml', '.fields.json']) {
      if (await adapter.exists(base + suffix)) return parseMeta(await adapter.read(base + suffix));
    }
    return {};
  }

  // Rebuilding replaces only a page this command made; the discussion lives in
  // its own file and survives.
  async buildReviewPage(file) {
    const { adapter } = this.app.vault;
    const base = file.path.slice(0, -(file.extension.length + 1));
    const target = `${base}.review.html`;
    try {
      if (file.stat.size > MAX_REVIEW_SOURCE_BYTES) throw new Error(`File is over ${MAX_REVIEW_SOURCE_BYTES / (1024 * 1024)} MB`);
      if (await adapter.exists(target) && !isGeneratedPage(await adapter.read(target))) {
        throw new Error(`${target} exists and was not generated; move it first`);
      }
      await adapter.write(target, buildReviewHtml({
        template: TEMPLATE,
        text: await adapter.read(file.path),
        extension: file.extension,
        name: file.basename,
        lang: window.localStorage.getItem('language') === 'ru' ? 'ru' : 'en',
        meta: await this.readReviewMeta(base),
      }));
      new Notice(`Claude IDE Bridge: built ${target}`);
    } catch (e) {
      new Notice(`Claude IDE Bridge: ${e.message}`);
    }
  }

  // ---- messages from sandboxed pages --------------------------------------

  findView(predicate) {
    let found = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (!found && predicate(leaf.view)) found = leaf.view;
    });
    return found;
  }

  onPageMessage(e) {
    if (!e.data || !e.source) return;
    const view = this.findView((v) => v.renderer && v.renderer.frame && v.renderer.frame.contentWindow === e.source);
    if (!view) return;
    // Pages run with an opaque origin, so their selection cannot be read from
    // here; the injected script reports it instead.
    if (typeof e.data.frameSelection === 'string') {
      this.setSelection(view.file.path, e.data.frameSelection);
      this.schedulePush();
    }
    if (view.format.pageBridge) {
      handlePageMessage(e.data, view.file, this.app.vault.adapter, window.localStorage, (m) => e.source.postMessage(m, '*'));
    }
  }

  // ---- selection tracking -------------------------------------------------

  abs(vaultPath) {
    return this.app.vault.adapter.getFullPath(vaultPath);
  }

  // The note or PDF the user is working with. When focus is elsewhere
  // (terminal, sidebar), the last one they used.
  currentView() {
    const ws = this.app.workspace;
    const active = ws.activeLeaf;
    if (active && isFileView(active.view)) {
      this.lastView = active.view;
      return active.view;
    }
    const last = this.lastView;
    if (last && last.file && last.leaf && last.leaf.view === last) return last;
    const recent = ws.getMostRecentLeaf(ws.rootSplit);
    if (recent && isFileView(recent.view)) {
      this.lastView = recent.view;
      return recent.view;
    }
    return null;
  }

  // Remembers a selection made outside a Markdown editor; empty text forgets it.
  setSelection(path, text, pageStart = 1, pageEnd = pageStart) {
    if (text.trim()) this.domSel = { path, text, pageStart, pageEnd };
    else if (this.domSel && this.domSel.path === path) this.domSel = null;
  }

  // In PDFs the text selection lives in the DOM (pdf.js text layer, sometimes
  // inside a shadow root), not in an editor, and is lost as soon as focus moves
  // to the terminal. Remember it while it is inside such a view; clear it only
  // when the user clicks there without selecting anything.
  captureDomSelection() {
    // The editor pane reports its own selection with line numbers.
    const active = document.activeElement;
    if (active && active.classList.contains('cib-editor')) return;
    const docSel = window.getSelection();
    const node = docSel && docSel.anchorNode;
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    if (!el) return;
    const view = this.findView((v) => isDomView(v) && v.containerEl.contains(el));
    if (!view) return;
    let text = docSel.toString();
    let sel = docSel;
    if (!text.trim()) {
      sel = shadowSelection(view.containerEl);
      if (!sel) {
        this.setSelection(view.file.path, '');
        return;
      }
      text = sel.toString();
    }
    const [a, b] = [pageOf(sel.anchorNode), pageOf(sel.focusNode)];
    this.setSelection(view.file.path, text, Math.min(a, b), Math.max(a, b));
  }

  snapshot() {
    const view = this.currentView();
    if (!view) return null;
    const filePath = this.abs(view.file.path);
    if (isDomView(view)) {
      // Lines stand for pages here: the CLI only shows them as a range, and
      // the text plus the file path is what matters.
      const sel = this.domSel && this.domSel.path === view.file.path ? this.domSel : null;
      const start = sel ? sel.pageStart - 1 : 0;
      const end = sel ? sel.pageEnd - 1 : 0;
      return selectionPayload(filePath, sel ? sel.text : '', { line: start, character: 0 }, { line: end, character: sel ? 1 : 0 });
    }
    const ed = view.editor;
    const from = ed.getCursor('from');
    const to = ed.getCursor('to');
    return selectionPayload(filePath, ed.getSelection(), { line: from.line, character: from.ch }, { line: to.line, character: to.ch });
  }

  pushSelection(force) {
    if (this.clients.size === 0) return;
    const snap = this.snapshot();
    if (!snap || (!force && sameSelection(snap, this.latest))) return;
    this.latest = snap;
    this.broadcast({ jsonrpc: '2.0', method: 'selection_changed', params: snap });
  }

  sendAtMention(editor, view) {
    if (!view || !view.file) return;
    if (this.clients.size === 0) {
      new Notice('Claude IDE Bridge: no Claude session connected (run /ide in claude)');
      return;
    }
    const from = editor.getCursor('from');
    const to = editor.getCursor('to');
    this.broadcast({
      jsonrpc: '2.0',
      method: 'at_mentioned',
      params: { filePath: this.abs(view.file.path), lineStart: from.line, lineEnd: to.line },
    });
  }

  broadcast(msg) {
    const payload = Buffer.from(JSON.stringify(msg), 'utf8');
    for (const client of this.clients) {
      if (!client.congested) client.sendEncoded(payload);
    }
  }
};
