'use strict';

const { treeOf } = require('./tree');

function parseJsonLines(text) {
  const values = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trim()) continue;
    try {
      values.push(JSON.parse(lines[i]));
    } catch (e) {
      throw new Error(`Line ${i + 1}: ${e.message}`);
    }
  }
  return values;
}

module.exports = {
  id: 'jsonl',
  extensions: ['jsonl', 'ndjson'],
  icon: 'braces',
  mount: treeOf(parseJsonLines),
  parseJsonLines,
};
