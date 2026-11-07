'use strict';

const { sandboxFrame } = require('./frame');

let lastId = 0;

// Obsidian ships Mermaid, so the plugin does not have to. Output goes into an
// empty sandbox: a diagram is vault content and must not run as app markup.
function mount(host) {
  const { loadMermaid } = require('obsidian');
  const frame = sandboxFrame(host, '');
  return {
    frame,
    async update(text, file, isCurrent) {
      lastId += 1;
      const id = `cib-mermaid-${lastId}`;
      try {
        const mermaid = await loadMermaid();
        const { svg } = await mermaid.render(id, text);
        if (isCurrent()) frame.srcdoc = `<!doctype html><meta charset="utf-8"><body style="margin:16px">${svg}`;
      } catch (e) {
        frame.removeAttribute('srcdoc');
        throw e;
      } finally {
        // A failed render leaves its scratch node in the document.
        document.getElementById(`d${id}`)?.remove();
      }
    },
  };
}

module.exports = {
  id: 'mermaid',
  extensions: ['mmd', 'mermaid'],
  icon: 'git-fork',
  mount,
};
