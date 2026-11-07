'use strict';

require('./support/setup');

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { KIT_FILES } = require('../src/kit');

test('kit files stay inside .claude and have content', () => {
  for (const { path, content } of KIT_FILES) {
    assert.ok(path.startsWith('.claude/') && !path.includes('..'), path);
    assert.ok(content.length > 100, path);
  }
});

test('kit paths are unique', () => {
  const paths = KIT_FILES.map((f) => f.path);
  assert.equal(new Set(paths).size, paths.length);
});
