'use strict';

// Skills and agents shipped with the plugin. Claude Code discovers them in the
// vault's .claude folder; each entry is one file written there on load.
const TEMPLATE = require('./skills/html-review-doc/template.html');

const KIT_FILES = [
  { path: '.claude/skills/html-review-doc/SKILL.md', content: require('./skills/html-review-doc/SKILL.md') },
  { path: '.claude/skills/html-review-doc/template.html', content: TEMPLATE },
];

// The build embeds the page generator, compiled to one file, as a text constant.
/* global KIT_BUILD_SCRIPT */
if (typeof KIT_BUILD_SCRIPT === 'string') {
  KIT_FILES.push({ path: '.claude/skills/html-review-doc/build-review.cjs', content: KIT_BUILD_SCRIPT });
}

module.exports = { KIT_FILES, TEMPLATE };
