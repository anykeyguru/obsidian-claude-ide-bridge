'use strict';

// Every supported file type is one record here.
//   id, extensions, icon   identity
//   binary                 opens in the binary view, otherwise as editable text
//   mount(host)            builds the viewer in `host` and returns { update }.
//                          update(content, file, isCurrent) gets the text, or a
//                          file reader for binary formats, and throws what it
//                          cannot show. Without `mount` a format is editor only.
//                          A renderer showing a page exposes it as `frame`.
//   previewLimit           characters a viewer accepts; see limits.js for the default
//   pageBridge             the page in `frame` may use the comments channel
const FORMATS = [
  require('./html'),
  require('./json'),
  require('./yaml'),
  require('./toml'),
  require('./jsonl'),
  require('./csv'),
  require('./mermaid'),
  require('./safetensors'),
  require('./plain-text'),
];

const byExtension = new Map(FORMATS.flatMap((f) => f.extensions.map((e) => [e, f])));
const formatFor = (extension) => byExtension.get(extension.toLowerCase()) || null;

module.exports = { FORMATS, formatFor };
