'use strict';

const { sandboxFrame } = require('./frame');

// Reports text selected inside the sandboxed page to the plugin.
const SELECTION_SCRIPT = `<script>(function(){var t;document.addEventListener('selectionchange',function(){clearTimeout(t);t=setTimeout(function(){parent.postMessage({frameSelection:String(document.getSelection())},'*')},100)})})()</script>`;

function withSelectionScript(html) {
  const head = /<head(\s[^>]*)?>/i;
  return head.test(html) ? html.replace(head, (m) => m + SELECTION_SCRIPT) : SELECTION_SCRIPT + html;
}

module.exports = {
  id: 'html',
  extensions: ['html', 'htm'],
  icon: 'file-code',
  pageBridge: true,
  mount(host) {
    // No allow-same-origin: the page's scripts run, but it cannot reach Obsidian.
    const frame = sandboxFrame(host, 'allow-scripts allow-downloads');
    return {
      frame,
      update(html) { frame.srcdoc = withSelectionScript(html); },
    };
  },
  withSelectionScript,
};
