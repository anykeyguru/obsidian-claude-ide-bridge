'use strict';

// Stands in for the `obsidian` module. TextFileView copies the real save and
// reload logic: tests of large files depend on when Obsidian writes to disk.

class Component {
  constructor() { this.events = []; this.commands = []; }

  registerEvent(ref) { this.events.push(ref); }

  registerDomEvent(target, type, handler) {
    target.addEventListener(type, handler);
    this.events.push(() => target.removeEventListener(type, handler));
  }
}

class Plugin extends Component {
  constructor(app, manifest) {
    super();
    this.app = app;
    this.manifest = manifest;
    this.views = {};
    this.extensions = {};
    this.stored = null;
  }

  registerView(type, factory) { this.views[type] = factory; }

  registerExtensions(extensions, type) {
    for (const e of extensions) {
      if (this.app.taken && this.app.taken.includes(e)) throw new Error(`Attempting to register an existing file extension "${e}"`);
      this.extensions[e] = type;
    }
  }

  addCommand(command) { this.commands.push(command); }

  async loadData() { return this.stored; }

  async saveData(data) { this.stored = JSON.parse(JSON.stringify(data)); }

  teardown() {
    for (const event of this.events) if (typeof event === 'function') event();
  }
}

class View extends Component {
  constructor(leaf) {
    super();
    this.leaf = leaf;
    this.app = leaf.app;
    this.containerEl = document.createElement('div');
    this.contentEl = this.containerEl.createDiv('view-content');
  }
}

class FileView extends View {
  async onLoadFile(file) { this.loaded = file; }

  async onUnloadFile() { this.loaded = null; }
}

class TextFileView extends FileView {
  constructor(leaf) {
    super(leaf);
    this.data = '';
    this.lastSavedData = null;
  }

  requestSave() { this.dirty = true; }

  async onLoadFile(file) {
    await super.onLoadFile(file);
    await this.loadFileInternal(file, true);
  }

  async loadFileInternal(file, clear) {
    const content = await this.app.vault.read(file);
    this.lastSavedData = content;
    this.data = content;
    this.setViewData(content, clear);
  }

  async onUnloadFile(file) {
    await this.save(true);
    await super.onUnloadFile(file);
  }

  async save(clear) {
    const content = this.getViewData();
    if (this.lastSavedData !== content && this.lastSavedData !== null) {
      this.lastSavedData = content;
      await this.app.vault.modify(this.file, content);
    }
    if (clear) {
      this.data = null;
      this.lastSavedData = null;
      this.clear();
    }
  }

  onModify(file) {
    if (file === this.file) return this.loadFileInternal(file, false);
    return undefined;
  }
}

class Notice {
  constructor(message) { Notice.shown.push(message); }
}
Notice.shown = [];

class FileSystemAdapter {
  constructor(basePath = '/vault') { this.basePath = basePath; this.files = new Map(); }

  getBasePath() { return this.basePath; }

  getFullPath(path) { return `${this.basePath}/${path}`; }

  async exists(path) { return this.files.has(path); }

  async read(path) { return this.files.get(path); }

  async write(path, content) { this.files.set(path, content); }
}

class TFile {
  constructor(path, size = 10) {
    this.path = path;
    this.name = path.split('/').pop();
    this.extension = this.name.split('.').pop();
    this.basename = this.name.slice(0, -(this.extension.length + 1));
    this.stat = { size };
  }
}

// Runs nothing until flushed, so tests decide when a debounced call happens.
function debounce(callback) {
  let pending = false;
  const debounced = () => { pending = true; debounced.calls += 1; return debounced; };
  debounced.calls = 0;
  debounced.flush = () => { if (pending) { pending = false; callback(); } };
  debounced.cancel = () => { pending = false; };
  return debounced;
}

const mermaid = { render: async (id, text) => ({ svg: `<svg data-source="${text}"></svg>` }) };
const loadMermaid = async () => mermaid;

module.exports = {
  Plugin, FileView, TextFileView, Notice, FileSystemAdapter, TFile, debounce, loadMermaid, mermaid,
};
