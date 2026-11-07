'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const { isFileView } = require('./selection');

const str = (description) => ({ type: 'string', description });

function selectRange(ed, args) {
  const content = ed.getValue();
  const start = content.indexOf(args.startText);
  if (start < 0) return;
  let end = start + args.startText.length;
  if (args.endText) {
    const found = content.indexOf(args.endText, start);
    if (found >= 0) end = found + args.endText.length;
  }
  const from = ed.offsetToPos(start);
  const to = ed.offsetToPos(end);
  if (args.selectToEndOfLine) to.ch = ed.getLine(to.line).length;
  ed.setSelection(from, to);
  ed.scrollIntoView({ from, to }, true);
}

async function openFile(ctx, args) {
  const { filePath } = args;
  if (!filePath) throw new Error('filePath is required');
  const rel = path.isAbsolute(filePath) ? path.relative(ctx.basePath, filePath) : filePath;
  if (rel.startsWith('..')) throw new Error(`File is outside the vault: ${filePath}`);
  const file = ctx.app.vault.getAbstractFileByPath(rel.split(path.sep).join('/'));
  if (!file || file.children) throw new Error(`File not found in vault: ${filePath}`);

  const leaf = ctx.app.workspace.getLeaf(args.preview === true ? false : 'tab');
  await leaf.openFile(file, { active: args.makeFrontmost !== false });
  if (args.startText && leaf.view.getViewType() === 'markdown') selectRange(leaf.view.editor, args);
  return `Opened file: ${filePath}`;
}

function openEditors(ctx) {
  const active = ctx.currentView();
  const tabs = [];
  ctx.app.workspace.iterateAllLeaves((leaf) => {
    const v = leaf.view;
    if (!isFileView(v)) return;
    tabs.push({
      uri: pathToFileURL(ctx.abs(v.file.path)).href,
      isActive: v === active,
      label: v.file.name,
      languageId: v.getViewType() === 'markdown' ? 'markdown' : (v.file.extension || 'plaintext'),
      isDirty: false,
    });
  });
  return { tabs };
}

const TOOLS = [
  {
    name: 'getCurrentSelection',
    run: (ctx) => {
      const snap = ctx.snapshot();
      return snap ? { success: true, ...snap } : { success: false, message: 'No active editor found' };
    },
    description: 'Get the current text selection in the active Obsidian note',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'getLatestSelection',
    run: (ctx) => (ctx.latest ? { success: true, ...ctx.latest } : { success: false, message: 'No selection available' }),
    description: 'Get the most recent text selection (even if focus moved away from the note)',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'getOpenEditors',
    run: openEditors,
    description: 'Get the notes currently open in Obsidian',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'getWorkspaceFolders',
    run: (ctx) => ({
      success: true,
      folders: [{ name: path.basename(ctx.basePath), uri: pathToFileURL(ctx.basePath).href, path: ctx.basePath }],
      rootPath: ctx.basePath,
    }),
    description: 'Get the vault root folder',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'openFile',
    run: openFile,
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
    run: () => [],
    description: 'Get diagnostics (always empty for Obsidian)',
    inputSchema: { type: 'object', properties: { uri: str('Optional file URI') } },
  },
  {
    name: 'checkDocumentDirty',
    run: (ctx, { filePath }) => ({ success: true, filePath, isDirty: false, isUntitled: false }),
    description: 'Check if a document has unsaved changes (Obsidian autosaves)',
    inputSchema: { type: 'object', properties: { filePath: str('Path to the file') }, required: ['filePath'] },
  },
  {
    name: 'saveDocument',
    run: (ctx, { filePath }) => ({ success: true, filePath, saved: true, message: 'Obsidian saves automatically' }),
    description: 'Save a document (no-op, Obsidian autosaves)',
    inputSchema: { type: 'object', properties: { filePath: str('Path to the file') }, required: ['filePath'] },
  },
  {
    name: 'closeAllDiffTabs',
    run: () => 'CLOSED_0_DIFF_TABS',
    description: 'Close all diff tabs (no-op)',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'close_tab',
    run: () => 'TAB_CLOSED',
    description: 'Close a tab by name (no-op)',
    inputSchema: { type: 'object', properties: { tab_name: str('Tab name') }, required: ['tab_name'] },
  },
];

module.exports = { TOOLS };
