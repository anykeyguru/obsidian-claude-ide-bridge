'use strict';

// Every resource limit in one place. All of them protect the app: the plugin
// shares the renderer process with Obsidian.
module.exports = {
  // Larger text files open as a read-only head instead of being loaded.
  MAX_TEXT_BYTES: 32 * 1024 * 1024,
  OVERSIZE_HEAD_BYTES: 256 * 1024,
  // Viewers parse the whole text; formats may lower this with `previewLimit`.
  PREVIEW_LIMIT_CHARS: 16 * 1024 * 1024,
  TREE_PAGE_ITEMS: 500,
  TABLE_PAGE_ROWS: 1000,
  // A review page embeds its data, so the source stays small and samples of
  // rows stand in for long tables.
  MAX_REVIEW_SOURCE_BYTES: 8 * 1024 * 1024,
  REVIEW_SAMPLE_ROWS: 20,
  MAX_WS_MESSAGE_BYTES: 64 * 1024 * 1024,
  MAX_WS_SEND_QUEUE_BYTES: 16 * 1024 * 1024,
};
