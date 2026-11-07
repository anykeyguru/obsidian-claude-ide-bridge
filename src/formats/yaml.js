'use strict';

const { parseAllDocuments } = require('yaml');
const { treeOf } = require('./tree');

// A Kubernetes manifest holds several documents separated by `---`.
function parseYaml(text) {
  const documents = parseAllDocuments(text);
  const failed = documents.find((doc) => doc.errors.length);
  if (failed) throw new Error(failed.errors[0].message);
  const values = documents.map((doc) => doc.toJS());
  return values.length === 1 ? values[0] : values;
}

module.exports = {
  id: 'yaml',
  extensions: ['yaml', 'yml'],
  icon: 'file-text',
  // Its document model costs far more memory than the text.
  previewLimit: 4 * 1024 * 1024,
  mount: treeOf(parseYaml),
  parseYaml,
};
