'use strict';

const { parse } = require('smol-toml');
const { treeOf } = require('./tree');

// Dates arrive as Date subclasses, which the tree would show as empty objects.
function withTextDates(value) {
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) value[key] = withTextDates(value[key]);
  }
  return value;
}

const parseToml = (text) => withTextDates(parse(text));

module.exports = {
  id: 'toml',
  extensions: ['toml'],
  icon: 'file-text',
  mount: treeOf(parseToml),
  parseToml,
};
