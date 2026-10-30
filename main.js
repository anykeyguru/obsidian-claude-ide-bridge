'use strict';

// Claude IDE Bridge: implements the Claude Code IDE integration protocol
// (lock file in ~/.claude/ide + MCP over a local WebSocket) so that the
// terminal `claude` can connect via /ide and see the active note/selection.
// No dependencies, no build step: plain CommonJS for Obsidian desktop.

const { Plugin, MarkdownView, Notice, FileSystemAdapter, TFile } = require('obsidian');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const IDE_NAME = 'Obsidian';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const PROTOCOL_VERSION = '2024-11-05';

// ---------------------------------------------------------------------------
// Minimal WebSocket server-side connection (RFC 6455, text frames only)
// ---------------------------------------------------------------------------

class WsConnection {
  constructor(socket, onMessage, onClose) {
    this.socket = socket;
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.buf = Buffer.alloc(0);
    this.fragments = null;
    this.closed = false;
    socket.setNoDelay(true);
    socket.on('data', (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.parse();
    });
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
  }

  finish() {
    if (this.closed) return;
    this.closed = true;
    this.onClose(this);
  }

  parse() {
    for (;;) {
      const buf = this.buf;
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      let mask = null;
      if (masked) {
        if (buf.length < off + 4) return;
        mask = buf.subarray(off, off + 4);
        off += 4;
      }
      if (buf.length < off + len) return;
      const payload = Buffer.from(buf.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = buf.subarray(off + len);
      this.handleFrame(fin, opcode, payload);
    }
  }

  handleFrame(fin, opcode, payload) {
    switch (opcode) {
      case 0x0: // continuation
        if (!this.fragments) return;
        this.fragments.push(payload);
        if (fin) {
          const msg = Buffer.concat(this.fragments).toString('utf8');
          this.fragments = null;
          this.onMessage(this, msg);
        }
        return;
      case 0x1: // text
      case 0x2: // binary
        if (fin) this.onMessage(this, payload.toString('utf8'));
        else this.fragments = [payload];
        return;
      case 0x8: // close
        this.sendFrame(0x8, payload.subarray(0, 2));
        this.socket.end();
        return;
      case 0x9: // ping
        this.sendFrame(0xa, payload);
        return;
      default: // pong and others
        return;
    }
  }

  sendFrame(opcode, payload) {
    if (this.closed || this.socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  send(obj) {
    this.sendFrame(0x1, Buffer.from(JSON.stringify(obj), 'utf8'));
  }

  close() {
    this.sendFrame(0x8, Buffer.alloc(0));
    this.socket.end();
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

module.exports = class ClaudeIdeBridge extends Plugin {
  async onload() {
    if (!(this.app.vault.adapter instanceof FileSystemAdapter)) {
      new Notice('Claude IDE Bridge: desktop only');
      return;
    }
    this.basePath = this.app.vault.adapter.getBasePath();
    this.clients = new Set();
    this.lastView = null;
    this.latest = null;
    this.latestKey = '';
    this.timer = null;
    this.authToken = crypto.randomUUID();

    await this.startServer();
    this.writeLockFile();

    // Shells spawned from Obsidian after this point (e.g. the Terminal
    // plugin) inherit these, so `claude` started there auto-connects.
    process.env.CLAUDE_CODE_SSE_PORT = String(this.port);
    process.env.ENABLE_IDE_INTEGRATION = 'true';

    const schedule = () => this.scheduleSelectionPush();
    this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => {
      if (leaf && isFileView(leaf.view)) this.lastView = leaf.view;
      schedule();
    }));
    this.registerEvent(this.app.workspace.on('editor-change', schedule));
    this.registerEvent(this.app.workspace.on('file-open', schedule));
    this.registerDomEvent(document, 'selectionchange', () => {
      this.captureDomSelection();
      schedule();
    });
    this.registerDomEvent(document, 'mouseup', schedule);
    this.registerDomEvent(document, 'keyup', schedule);

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

    this.onWindowUnload = () => this.removeLockFile();
    window.addEventListener('beforeunload', this.onWindowUnload);

    this.domSel = null;
    this.currentView();
    console.log(`[claude-ide-bridge] listening on 127.0.0.1:${this.port}`);
  }

  onunload() {
    if (this.timer) clearTimeout(this.timer);
    if (this.onWindowUnload) window.removeEventListener('beforeunload', this.onWindowUnload);
    if (this.clients) for (const c of this.clients) c.close();
    if (this.server) this.server.close();
    this.removeLockFile();
    if (process.env.CLAUDE_CODE_SSE_PORT === String(this.port)) {
      delete process.env.CLAUDE_CODE_SSE_PORT;
      delete process.env.ENABLE_IDE_INTEGRATION;
    }
  }

  // ---- server / lock file -------------------------------------------------

  startServer() {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        res.writeHead(426, { 'Content-Type': 'text/plain' });
        res.end('Upgrade Required');
      });
      server.on('upgrade', (req, socket) => this.handleUpgrade(req, socket));
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        this.server = server;
        this.port = server.address().port;
        resolve();
      });
    });
  }

  handleUpgrade(req, socket) {
    const key = req.headers['sec-websocket-key'];
    const token = req.headers['x-claude-code-ide-authorization'];
    if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    if (token !== this.authToken) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
    ];
    const requested = req.headers['sec-websocket-protocol'];
    if (requested) {
      const protos = requested.split(',').map((s) => s.trim());
      headers.push(`Sec-WebSocket-Protocol: ${protos.includes('mcp') ? 'mcp' : protos[0]}`);
    }
    socket.write(headers.join('\r\n') + '\r\n\r\n');
    const conn = new WsConnection(
      socket,
      (c, msg) => this.handleMessage(c, msg),
      (c) => this.clients.delete(c),
    );
    this.clients.add(conn);
  }

  get lockDir() {
    const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    return path.join(base, 'ide');
  }

  get lockPath() {
    return path.join(this.lockDir, `${this.port}.lock`);
  }

  writeLockFile() {
    fs.mkdirSync(this.lockDir, { recursive: true });
    this.cleanStaleLocks();
    const lock = {
      pid: process.pid,
      workspaceFolders: [this.basePath],
      ideName: IDE_NAME,
      transport: 'ws',
      authToken: this.authToken,
    };
    fs.writeFileSync(this.lockPath, JSON.stringify(lock), { mode: 0o600 });
  }

  removeLockFile() {
    if (!this.port) return;
    try { fs.unlinkSync(this.lockPath); } catch (e) { /* already gone */ }
  }

  cleanStaleLocks() {
    let names = [];
    try { names = fs.readdirSync(this.lockDir); } catch (e) { return; }
    for (const name of names) {
      if (!name.endsWith('.lock')) continue;
      const p = path.join(this.lockDir, name);
      try {
        const lock = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (lock.ideName !== IDE_NAME) continue;
        const sameVault = (lock.workspaceFolders || []).includes(this.basePath);
        let alive = true;
        try { process.kill(lock.pid, 0); } catch (e) { alive = false; }
        if (!alive || (sameVault && lock.pid === process.pid)) fs.unlinkSync(p);
      } catch (e) { /* ignore foreign/broken files */ }
    }
  }

  // ---- selection tracking -------------------------------------------------

  abs(vaultPath) {
    return path.join(this.basePath, vaultPath);
  }

  // The note or PDF the user is working with. When focus is elsewhere
  // (terminal, sidebar), the last one they used.
  currentView() {
    const ws = this.app.workspace;
    const activeLeaf = ws.activeLeaf;
    if (activeLeaf && isFileView(activeLeaf.view)) {
      this.lastView = activeLeaf.view;
      return activeLeaf.view;
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

  // In PDFs and Omni Viewer tabs the text selection lives in the DOM (pdf.js
  // text layer, often inside a shadow root), not in an editor, and is lost as
  // soon as focus moves to the terminal. Remember it while it is inside such a
  // view; clear it only when the user clicks there without selecting anything.
  captureDomSelection() {
    const docSel = window.getSelection();
    const node = docSel && docSel.anchorNode;
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    if (!el) return;
    let domView = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      const v = leaf.view;
      if (!domView && isDomView(v) && v.containerEl.contains(el)) domView = v;
    });
    if (!domView) return;
    const sel = docSel.toString().trim() ? docSel : shadowSelection(domView.containerEl) || docSel;
    const text = sel.toString();
    if (!text.trim()) {
      if (this.domSel && this.domSel.path === domView.file.path) this.domSel = null;
      return;
    }
    const pageOf = (n) => {
      const e = n && (n.nodeType === 1 ? n : n.parentElement);
      const page = e && e.closest('[data-page-number]');
      return page ? Number(page.getAttribute('data-page-number')) : 1;
    };
    const a = pageOf(sel.anchorNode);
    const b = pageOf(sel.focusNode);
    this.domSel = { path: domView.file.path, text, pageStart: Math.min(a, b), pageEnd: Math.max(a, b) };
  }

  snapshot() {
    const view = this.currentView();
    if (!view || !view.file) return null;
    if (isDomView(view)) return this.domSnapshot(view);
    if (!view.editor) return null;
    const ed = view.editor;
    const from = ed.getCursor('from');
    const to = ed.getCursor('to');
    const filePath = this.abs(view.file.path);
    return {
      text: ed.getSelection(),
      filePath,
      fileUrl: pathToFileURL(filePath).href,
      selection: {
        start: { line: from.line, character: from.ch },
        end: { line: to.line, character: to.ch },
        isEmpty: from.line === to.line && from.ch === to.ch,
      },
    };
  }

  // For PDFs lines are 0-based page indexes: the CLI only shows them as a
  // range, and the text plus the file path is what matters.
  domSnapshot(view) {
    const filePath = this.abs(view.file.path);
    const sel = this.domSel && this.domSel.path === view.file.path ? this.domSel : null;
    const start = sel ? sel.pageStart - 1 : 0;
    const end = sel ? sel.pageEnd - 1 : 0;
    return {
      text: sel ? sel.text : '',
      filePath,
      fileUrl: pathToFileURL(filePath).href,
      selection: {
        start: { line: start, character: 0 },
        end: { line: end, character: sel ? 1 : 0 },
        isEmpty: !sel,
      },
    };
  }

  scheduleSelectionPush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pushSelection(false);
    }, 100);
  }

  pushSelection(force) {
    const snap = this.snapshot();
    if (!snap) return;
    const key = JSON.stringify(snap);
    if (!force && key === this.latestKey) return;
    this.latest = snap;
    this.latestKey = key;
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
    for (const c of this.clients) c.send(msg);
  }

  // ---- MCP ----------------------------------------------------------------

  handleMessage(conn, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    const { id, method, params } = msg;
    if (method === undefined) return; // response to something we never sent
    const reply = (result) => { if (id !== undefined) conn.send({ jsonrpc: '2.0', id, result }); };
    const fail = (code, message) => {
      if (id !== undefined) conn.send({ jsonrpc: '2.0', id, error: { code, message } });
    };

    switch (method) {
      case 'initialize':
        reply({
          protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: true }, logging: {} },
          serverInfo: { name: 'claude-ide-bridge-obsidian', version: '0.2.0' },
        });
        return;
      case 'notifications/initialized':
        this.pushSelection(true);
        return;
      case 'ping':
        reply({});
        return;
      case 'tools/list':
        reply({ tools: TOOLS });
        return;
      case 'tools/call':
        this.callTool(params && params.name, (params && params.arguments) || {})
          .then((value) => reply({
            content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
          }))
          .catch((e) => reply({
            content: [{ type: 'text', text: String((e && e.message) || e) }],
            isError: true,
          }));
        return;
      case 'prompts/list':
        reply({ prompts: [] });
        return;
      case 'resources/list':
        reply({ resources: [] });
        return;
      default:
        if (method.startsWith('notifications/')) return;
        fail(-32601, `Method not found: ${method}`);
    }
  }

  async callTool(name, args) {
    switch (name) {
      case 'getCurrentSelection': {
        const snap = this.snapshot();
        return snap ? { success: true, ...snap } : { success: false, message: 'No active editor found' };
      }
      case 'getLatestSelection':
        return this.latest ? { success: true, ...this.latest } : { success: false, message: 'No selection available' };
      case 'getOpenEditors': {
        const active = this.currentView();
        const tabs = [];
        this.app.workspace.iterateAllLeaves((leaf) => {
          const v = leaf.view;
          if (!isFileView(v)) return;
          tabs.push({
            uri: pathToFileURL(this.abs(v.file.path)).href,
            isActive: v === active,
            label: v.file.name,
            languageId: v instanceof MarkdownView ? 'markdown' : (v.file.extension || 'plaintext'),
            isDirty: false,
          });
        });
        return { tabs };
      }
      case 'getWorkspaceFolders':
        return {
          success: true,
          folders: [{ name: path.basename(this.basePath), uri: pathToFileURL(this.basePath).href, path: this.basePath }],
          rootPath: this.basePath,
        };
      case 'openFile':
        return this.openFile(args);
      case 'getDiagnostics':
        return [];
      case 'checkDocumentDirty':
        return { success: true, filePath: args.filePath, isDirty: false, isUntitled: false };
      case 'saveDocument':
        return { success: true, filePath: args.filePath, saved: true, message: 'Obsidian saves automatically' };
      case 'closeAllDiffTabs':
        return 'CLOSED_0_DIFF_TABS';
      case 'close_tab':
        return 'TAB_CLOSED';
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  async openFile(args) {
    const filePath = args.filePath;
    if (!filePath) throw new Error('filePath is required');
    const rel = path.isAbsolute(filePath) ? path.relative(this.basePath, filePath) : filePath;
    if (rel.startsWith('..')) throw new Error(`File is outside the vault: ${filePath}`);
    const file = this.app.vault.getAbstractFileByPath(rel.split(path.sep).join('/'));
    if (!(file instanceof TFile)) throw new Error(`File not found in vault: ${filePath}`);

    const leaf = this.app.workspace.getLeaf(args.preview === true ? false : 'tab');
    await leaf.openFile(file, { active: args.makeFrontmost !== false });
    const view = leaf.view;
    if (view instanceof MarkdownView && args.startText) {
      const ed = view.editor;
      const content = ed.getValue();
      const start = content.indexOf(args.startText);
      if (start >= 0) {
        let end = start + args.startText.length;
        if (args.endText) {
          const e = content.indexOf(args.endText, start);
          if (e >= 0) end = e + args.endText.length;
        }
        const from = ed.offsetToPos(start);
        let to = ed.offsetToPos(end);
        if (args.selectToEndOfLine) to = { line: to.line, ch: ed.getLine(to.line).length };
        ed.setSelection(from, to);
        ed.scrollIntoView({ from, to }, true);
      }
    }
    return `Opened file: ${filePath}`;
  }
};

// Views without an editor whose text selection we read from the DOM: the
// built-in PDF viewer and every Omni Viewer tab (PDF, HTML, EPUB, office...).
const isDomView = (v) => {
  const type = v && v.file && v.getViewType ? v.getViewType() : '';
  return type === 'pdf' || type.startsWith('omni-viewer.');
};
const isFileView = (v) => !!(v && v.file && (v instanceof MarkdownView || isDomView(v)));

// Chromium reports a selection inside a shadow root as collapsed on the host,
// so ask the shadow roots mounted in the view (Omni Viewer renders there).
// Only the view's light DOM is scanned: a PDF text layer has thousands of nodes.
function shadowSelection(rootEl) {
  for (const host of rootEl.querySelectorAll('*')) {
    const root = host.shadowRoot;
    const sel = root && typeof root.getSelection === 'function' ? root.getSelection() : null;
    if (sel && sel.toString().trim()) return sel;
  }
  return null;
}

const str = (description) => ({ type: 'string', description });

const TOOLS = [
  {
    name: 'getCurrentSelection',
    description: 'Get the current text selection in the active Obsidian note',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'getLatestSelection',
    description: 'Get the most recent text selection (even if focus moved away from the note)',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'getOpenEditors',
    description: 'Get the notes currently open in Obsidian',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'getWorkspaceFolders',
    description: 'Get the vault root folder',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'openFile',
    description: 'Open a note in Obsidian and optionally select a range of text',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: str('Path to the file to open'),
        preview: { type: 'boolean', description: 'Open in the current tab instead of a new one', default: false },
        startText: str('Text pattern marking the start of the selection'),
        endText: str('Text pattern marking the end of the selection'),
        selectToEndOfLine: { type: 'boolean', default: false },
        makeFrontmost: { type: 'boolean', default: true },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'getDiagnostics',
    description: 'Get diagnostics (always empty for Obsidian)',
    inputSchema: { type: 'object', properties: { uri: str('Optional file URI') } },
  },
  {
    name: 'checkDocumentDirty',
    description: 'Check if a document has unsaved changes (Obsidian autosaves)',
    inputSchema: { type: 'object', properties: { filePath: str('Path to the file') }, required: ['filePath'] },
  },
  {
    name: 'saveDocument',
    description: 'Save a document (no-op, Obsidian autosaves)',
    inputSchema: { type: 'object', properties: { filePath: str('Path to the file') }, required: ['filePath'] },
  },
  {
    name: 'closeAllDiffTabs',
    description: 'Close all diff tabs (no-op)',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'close_tab',
    description: 'Close a tab by name (no-op)',
    inputSchema: { type: 'object', properties: { tab_name: str('Tab name') }, required: ['tab_name'] },
  },
];
