'use strict';

// No viewer yet: an editor tab inside Obsidian beats the system default app,
// which is where Obsidian sends any extension nobody registered.
module.exports = {
  id: 'plain-text',
  extensions: ['sql', 'jsonc', 'xml', 'txt', 'log', 'ini'],
  icon: 'file-text',
};
