'use strict';

const { treeOf } = require('./tree');

module.exports = {
  id: 'json',
  extensions: ['json'],
  icon: 'braces',
  mount: treeOf((text) => JSON.parse(text)),
};
