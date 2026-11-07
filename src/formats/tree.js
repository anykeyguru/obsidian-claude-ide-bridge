'use strict';

const { TREE_PAGE_ITEMS } = require('../limits');

// Collapsible view of any JSON-like value. Children are built on first expand
// and in pages, so a very long array stays cheap.
function valueTree(parent, key, value) {
  const label = (el) => key !== null && el.createSpan({ cls: 'cib-tree-key', text: `${key}: ` });
  if (value === null || typeof value !== 'object') {
    const row = parent.createDiv('cib-tree-leaf');
    label(row);
    const kind = value === null ? 'null' : typeof value;
    row.createSpan({ cls: `cib-tree-${kind}`, text: JSON.stringify(value) });
    return null;
  }
  const keys = Object.keys(value);
  const branch = parent.createEl('details', { cls: 'cib-tree-branch' });
  const summary = branch.createEl('summary');
  label(summary);
  summary.createSpan({ cls: 'cib-tree-size', text: Array.isArray(value) ? `[${keys.length}]` : `{${keys.length}}` });
  let shown = 0;
  const showPage = () => {
    const end = Math.min(shown + TREE_PAGE_ITEMS, keys.length);
    for (; shown < end; shown += 1) valueTree(branch, keys[shown], value[keys[shown]]);
    if (shown === keys.length) return;
    const more = branch.createEl('button', { cls: 'cib-more', text: `Show ${Math.min(TREE_PAGE_ITEMS, keys.length - shown)} more` });
    more.addEventListener('click', () => {
      more.remove();
      showPage();
    });
  };
  branch.addEventListener('toggle', () => {
    if (branch.open && shown === 0) showPage();
  });
  return branch;
}

// Renderer for a format whose content parses into a value. `parse` may be async.
const treeOf = (parse) => (host) => {
  const root = host.createDiv('cib-tree');
  return {
    async update(content, file, isCurrent) {
      root.replaceChildren();
      const value = await parse(content);
      if (!isCurrent()) return;
      const branch = valueTree(root, null, value);
      if (branch) branch.open = true;
    },
  };
};

module.exports = { treeOf };
