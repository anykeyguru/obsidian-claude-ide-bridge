'use strict';

// node build-review.cjs <file> [--title <text>] [--lang ru|en]
// Writes <name>.review.html next to the file, reading <name>.fields.yaml if present.

const fs = require('fs');
const path = require('path');
const { buildReviewHtml, parseMeta, isGeneratedPage } = require('./build');

const TEMPLATE_FILE = 'template.html';
const META_SUFFIXES = ['.fields.yaml', '.fields.yml', '.fields.json'];

function parseArgs(argv) {
  const options = { file: null, title: undefined, lang: 'en' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--title' || argv[i] === '--lang') {
      options[argv[i].slice(2)] = argv[i + 1];
      i += 1;
    } else {
      options.file = argv[i];
    }
  }
  return options;
}

function readMeta(base) {
  for (const suffix of META_SUFFIXES) {
    if (fs.existsSync(base + suffix)) return parseMeta(fs.readFileSync(base + suffix, 'utf8'));
  }
  return {};
}

function run(argv, templateDir) {
  const options = parseArgs(argv);
  if (!options.file) throw new Error('usage: build-review <file> [--title <text>] [--lang ru|en]');
  const extension = path.extname(options.file).slice(1);
  const base = options.file.slice(0, -(extension.length + 1));
  const output = `${base}.review.html`;
  if (fs.existsSync(output) && !isGeneratedPage(fs.readFileSync(output, 'utf8'))) {
    throw new Error(`${output} exists and was not generated; move it first`);
  }
  fs.writeFileSync(output, buildReviewHtml({
    template: fs.readFileSync(path.join(templateDir, TEMPLATE_FILE), 'utf8'),
    text: fs.readFileSync(options.file, 'utf8'),
    extension,
    name: path.basename(base),
    title: options.title,
    lang: options.lang,
    meta: readMeta(base),
  }));
  return output;
}

/* node:coverage disable */
if (require.main === module) {
  try {
    console.log(run(process.argv.slice(2), __dirname));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
/* node:coverage enable */

module.exports = { run, parseArgs };
