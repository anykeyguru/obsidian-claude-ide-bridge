'use strict';

// Loads source files under node: fakes the `obsidian` module and gives them a
// DOM with the element helpers Obsidian adds.

const fs = require('fs');
const Module = require('module');
const path = require('path');
const { JSDOM } = require('jsdom');

const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === 'obsidian') return require('./obsidian');
  return originalLoad.call(this, request, ...rest);
};

for (const extension of ['.md', '.html']) {
  require.extensions[extension] = (module, file) => { module.exports = fs.readFileSync(file, 'utf8'); };
}

const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
const { window } = dom;
global.window = window;
global.document = window.document;
global.Option = window.Option;

Object.assign(window.HTMLElement.prototype, {
  addClass(cls) { this.classList.add(cls); },
  toggleClass(cls, value) { this.classList.toggle(cls, value); },
  createEl(tag, options = {}) {
    const el = document.createElement(tag);
    if (options.cls) el.className = options.cls;
    if (options.text !== undefined) el.textContent = options.text;
    for (const [k, v] of Object.entries(options.attr || {})) el.setAttribute(k, v);
    this.append(el);
    return el;
  },
  createDiv(options) { return this.createEl('div', typeof options === 'string' ? { cls: options } : options); },
  createSpan(options) { return this.createEl('span', options); },
});

const fixture = (name) => path.join(__dirname, name);

const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });

module.exports = { dom, fixture, settle };
