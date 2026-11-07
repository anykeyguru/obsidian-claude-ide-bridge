'use strict';

const { settle } = require('./support/setup');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');

const TEMPLATE = fs.readFileSync(path.join(__dirname, '../src/kit/skills/html-review-doc/template.html'), 'utf8')
  .replaceAll('__DOC_NAME__', 'demo').replaceAll('__TITLE__', 'Demo');
const SKILL = fs.readFileSync(path.join(__dirname, '../src/kit/skills/html-review-doc/SKILL.md'), 'utf8');

const withContract = (contract) => TEMPLATE.replace(/(<script type="application\/json" id="contract">)[\s\S]*?(<\/script>)/, `$1${JSON.stringify(contract)}$2`);

// Runs the page with a host answering on the `comments` channel, as the plugin does.
async function page({ html = TEMPLATE, stored = null, bridged = true, theme = null } = {}) {
  const writes = [];
  const host = {
    theme,
    file: stored,
    respond(win, d) {
      const reply = { channel: 'comments', reply: true, reqId: d.reqId, ok: true };
      if (d.op === 'ping') reply.theme = host.theme;
      if (d.op === 'read') reply.content = host.file;
      if (d.op === 'theme') host.theme = d.theme;
      if (d.op === 'write') { host.file = d.content; writes.push(d.content); }
      if (host.failWrite && d.op === 'write') { reply.ok = false; reply.error = 'disk full'; }
      win.postMessage(reply, '*');
    },
  };
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(win) {
      win.matchMedia = () => ({ matches: false });
      win.fetch = async () => ({ ok: false });
      win.URL.createObjectURL = () => 'blob:x';
      win.URL.revokeObjectURL = () => {};
      if (bridged) {
        const parent = { postMessage: (d) => setTimeout(() => host.respond(win, d), 0) };
        Object.defineProperty(win, 'parent', { get: () => parent });
      }
    },
  });
  const { window } = dom;
  await new Promise((r) => { setTimeout(r, 20); });
  const $ = (s) => window.document.querySelector(s);
  const $$ = (s) => [...window.document.querySelectorAll(s)];
  return { window, host, writes, $, $$, status: () => $('#status').textContent };
}

const buttonIn = (root, text) => [...root.querySelectorAll('button')].find((b) => b.textContent === text);
const tick = () => new Promise((r) => { setTimeout(r, 10); });
const article = (p) => p.$('[data-item="overview.goal"]');
const parsed = (p) => JSON.parse(p.host.file);

async function comment(p, root, text) {
  root.querySelector('.controls input').value = text;
  buttonIn(root, 'Comment').click();
  await tick();
}

test('skill and template agree on the channel and placeholders', () => {
  assert.match(SKILL, /^---\nname: html-review-doc\n/);
  assert.match(SKILL, /`comments` channel/);
  assert.ok(!TEMPLATE.includes('__'.concat('DOC_NAME')));
  assert.ok(!/https?:\/\/(?!www\.w3)/.test(TEMPLATE), 'the template loads nothing external');
});

test('builds tabs and shows the first one', async () => {
  const p = await page();
  assert.deepEqual(p.$$('[role=tab]').map((t) => t.textContent), ['Overview', 'Decisions', 'Contract']);
  assert.equal(p.$('[data-tab=Overview]').hidden, false);
  assert.equal(p.$('[data-tab=Decisions]').hidden, true);
  p.$$('[role=tab]')[1].click();
  assert.equal(p.$('[data-tab=Decisions]').hidden, false);
  assert.equal(p.$$('[role=tab]')[1].getAttribute('aria-selected'), 'true');
});

test('a new document says so and shows items as new', async () => {
  const p = await page();
  assert.match(p.status(), /No file yet/);
  assert.equal(article(p).querySelector('.badge').textContent, 'new');
});

test('a comment is written next to the page with stable formatting', async () => {
  const p = await page();
  p.$('#author').value = 'Ann';
  await comment(p, article(p), 'looks <b>ok</b>');
  assert.match(p.status(), /Saved to demo\.comments\.json/);
  const saved = parsed(p);
  assert.equal(saved.format, 'html-review-comments');
  assert.equal(saved.items['overview.goal'].comments[0].author, 'Ann');
  assert.ok(p.host.file.endsWith('}\n'));
  assert.equal(article(p).querySelector('.comment b'), null, 'text is never parsed as markup');
});

test('an empty comment does nothing', async () => {
  const p = await page();
  buttonIn(article(p), 'Comment').click();
  await tick();
  assert.deepEqual(p.writes, []);
});

test('approving marks the item; changed text needs accepting and drops the approval', async () => {
  const p = await page();
  buttonIn(article(p), 'Approve').click();
  await tick();
  assert.equal(article(p).querySelector('.badge').textContent, 'approved');
  const stored = p.host.file;
  const edited = await page({ html: TEMPLATE.replace('Replace this item', 'Changed this item'), stored });
  assert.equal(article(edited).querySelector('.badge').textContent, 'changed');
  buttonIn(article(edited), 'Accept change').click();
  await tick();
  assert.equal(article(edited).querySelector('.badge').textContent, 'open');
  assert.equal(parsed(edited).items['overview.goal'].approved, null);
});

test('items keep sorted keys in the file', async () => {
  const p = await page();
  await comment(p, p.$('[data-item="overview.goal"]'), 'b');
  await comment(p, p.$('[data-item="decisions.first"]'), 'a');
  assert.deepEqual(Object.keys(parsed(p).items), ['decisions.first', 'overview.goal']);
});

test('a save failure is shown', async () => {
  const p = await page();
  p.host.failWrite = true;
  await comment(p, article(p), 'x');
  assert.match(p.status(), /Not saved: disk full/);
});

test('a foreign file on load is reported, not accepted', async () => {
  const p = await page({ stored: '{"format":"other"}' });
  assert.match(p.status(), /Not loaded: format is other/);
});

test('Save writes in Obsidian and downloads elsewhere', async () => {
  const p = await page();
  p.$('#save').click();
  await tick();
  assert.equal(p.writes.length, 1);
  const alone = await page({ bridged: false });
  assert.match(alone.status(), /until you press Save/);
  await comment(alone, article(alone), 'x');
  assert.match(alone.status(), /until you press Save/);
  let clicks = 0;
  alone.window.HTMLAnchorElement.prototype.click = () => { clicks += 1; };
  alone.$('#save').click();
  await tick();
  assert.equal(clicks, 1);
  assert.match(alone.status(), /Downloaded demo\.comments\.json/);
});

test('outside Obsidian the neighbour file is read when served', async () => {
  const html = TEMPLATE.replace("const CHANNEL = 'comments';", `const CHANNEL = 'comments'; window.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ format: 'html-review-comments', items: {} }) });`);
  const p = await page({ bridged: false, html });
  assert.match(p.status(), /read only/);
});

async function load(p, content) {
  const input = p.$('#load-file');
  Object.defineProperty(input, 'files', { configurable: true, value: [{ text: async () => content, name: 'picked.json' }] });
  input.dispatchEvent(new p.window.Event('change'));
  await tick();
}

test('Load replaces the discussion and writes it next to the page', async () => {
  const p = await page();
  await load(p, JSON.stringify({
    format: 'html-review-comments', items: { 'overview.goal': { snapshot: 'x', approved: null, comments: [{ author: 'Bob', at: '2026-01-01', text: 'hi' }] } },
  }));
  assert.equal(article(p).querySelector('.comment').textContent, 'Bob, 2026-01-01hi');
  assert.equal(article(p).querySelector('.badge').textContent, 'changed');
  assert.equal(p.writes.length, 1);
});

test('Load refuses a wrong file and keeps the discussion', async () => {
  const p = await page();
  await comment(p, article(p), 'keep');
  await load(p, '{"format":"other"}');
  assert.match(p.status(), /Not loaded/);
  assert.equal(article(p).querySelectorAll('.comment').length, 1);
});

test('Load with no file chosen does nothing', async () => {
  const p = await page();
  const input = p.$('#load-file');
  input.dispatchEvent(new p.window.Event('change'));
  await tick();
  assert.deepEqual(p.writes, []);
});

test('the Load button opens the file dialog', async () => {
  const p = await page();
  let opened = 0;
  p.$('#load-file').click = () => { opened += 1; };
  p.$('#load').click();
  assert.equal(opened, 1);
});

test('the theme switches, and the host keeps the choice', async () => {
  const p = await page();
  const root = p.window.document.documentElement;
  assert.equal(root.dataset.theme, 'light');
  assert.equal(p.$('#theme').textContent, 'Night mode');
  p.$('#theme').click();
  assert.equal(root.dataset.theme, 'dark');
  assert.equal(p.$('#theme').textContent, 'Day mode');
  await tick();
  assert.equal(p.host.theme, 'dark');
  p.$('#theme').click();
  assert.equal(root.dataset.theme, 'light');
  const again = await page({ theme: 'dark' });
  assert.equal(again.window.document.documentElement.dataset.theme, 'dark');
});

test('JSON keys take the colour of their class; an unknown field is grey', async () => {
  const p = await page();
  const color = (name) => p.$$('.key').find((b) => b.textContent === `"${name}"`).style.getPropertyValue('--field');
  assert.equal(color('version'), 'var(--k3)');
  assert.equal(color('total'), 'var(--k1)');
  assert.equal(color('segment'), '');
  assert.deepEqual(p.$$('.legend .pill').map((x) => x.textContent), ['Model', 'Dictionary', 'Static']);
  assert.deepEqual(p.$$('.legend .grp > b').map((x) => x.textContent), ['Dynamic, every run', 'Static, our dictionaries', 'Technical layer', 'Available now']);
  assert.deepEqual(p.$$('.legend [class^=tone]').map((x) => x.textContent), ['● Yes', '● Partly', '● No']);
});

test('the first field is selected, a click opens another card', async () => {
  const p = await page();
  assert.equal(p.$('.detail h3').textContent, 'version');
  assert.equal(p.$('.detail .badge').textContent, 'new');
  p.$$('.key').find((b) => b.textContent === '"total"').click();
  assert.equal(p.$('.detail h3').textContent, 'result.total');
  assert.match(p.$('.detail dl').textContent, /Typenumber.*Example0\.87/);
  assert.equal(p.$$('.detail dd input').length, 1, 'only the missing attribute is an input');
  assert.equal(p.$$('.ln.sel').length, 1);
  assert.match(p.$('.ln.sel').textContent, /"total": 0\.87/);
});

test('clicking between keys does not open a card', async () => {
  const p = await page();
  p.$('.json').click();
  assert.equal(p.$('.detail h3').textContent, 'version');
});

test('a bare field gets a card to fill; values and class are saved and restored', async () => {
  const p = await page();
  const segment = p.$$('.key').find((b) => b.textContent === '"segment"');
  segment.click();
  const select = p.$('.detail select');
  select.value = 'dictionary';
  select.dispatchEvent(new p.window.Event('change'));
  await tick();
  const input = p.$('.detail .biz input');
  input.value = 'Client segment';
  input.dispatchEvent(new p.window.Event('change'));
  await tick();
  assert.equal(segment.style.getPropertyValue('--field'), 'var(--k2)');
  assert.equal(segment.title, 'Dictionary');
  await comment(p, p.$('.detail'), 'ok');
  buttonIn(p.$('.detail'), 'Approve').click();
  await tick();
  assert.equal(segment.dataset.mark, ' ✓ (1)');
  const card = parsed(p).items['response:result.segment'].card;
  assert.deepEqual(card, { class: 'dictionary', title: 'Client segment' });
  const again = await page({ stored: p.host.file });
  const restored = again.$$('.key').find((b) => b.textContent === '"segment"');
  assert.equal(restored.style.getPropertyValue('--field'), 'var(--k2)');
  assert.equal(restored.dataset.mark, ' ✓ (1)');
  restored.click();
  assert.equal(again.$('.detail .biz input').value, 'Client segment');
  assert.equal(again.$('.detail select').value, 'dictionary');
});

test('emptying a card value removes it from the file', async () => {
  const p = await page();
  p.$$('.key').find((b) => b.textContent === '"segment"').click();
  const fill = (value) => {
    const input = p.$('.detail dd input');
    input.value = value;
    input.dispatchEvent(new p.window.Event('change'));
    return tick();
  };
  await fill('x');
  await fill('');
  assert.deepEqual(parsed(p).items['response:result.segment'].card, {});
});

test('a changed type marks a field as changed; a new example does not', async () => {
  const p = await page();
  p.$$('.key').find((b) => b.textContent === '"total"').click();
  buttonIn(p.$('.detail'), 'Approve').click();
  await tick();
  const stored = p.host.file;
  const example = await page({ html: TEMPLATE.replace('"total": 0.87', '"total": 0.5'), stored });
  example.$$('.key').find((b) => b.textContent === '"total"').click();
  assert.equal(example.$('.detail .badge').textContent, 'approved');
  const type = await page({ html: TEMPLATE.replace('"total": 0.87', '"total": "high"'), stored });
  type.$$('.key').find((b) => b.textContent === '"total"').click();
  assert.equal(type.$('.detail .badge').textContent, 'changed');
});

test('a bare JSON with no classes or attributes still gives a card', async () => {
  const p = await page({ html: withContract({ documents: { response: { a: [1, 2], b: null, c: { d: true } } } }) });
  assert.deepEqual(p.$$('.key').map((b) => b.textContent), ['"a"', '"b"', '"c"', '"d"']);
  assert.equal(p.$$('.legend .pill').length, 0);
  assert.equal(p.$('.sumbar .pill').textContent, 'Not classified4');
  assert.equal(p.$('.detail .biz input').placeholder, 'What this field is');
  assert.equal(p.$('.detail .note input').placeholder, 'Note');
  assert.equal(p.$('.detail select'), null);
  assert.match(p.$('.detail dl').textContent, /array/);
  p.$$('.key')[1].click();
  assert.match(p.$('.detail dl').textContent, /null/);
});

test('array elements share one path and repeated keys open the same card', async () => {
  const p = await page({ html: withContract({ documents: { response: { list: [{ id: 1 }, { id: 2 }] } } }) });
  const ids = p.$$('.key').filter((b) => b.textContent === '"id"');
  assert.equal(ids.length, 2);
  ids[1].click();
  assert.equal(p.$('.detail h3').textContent, 'list[].id');
  assert.equal(p.$('.detail dl').textContent.includes('1'), true);
});

test('a long array renders only its head, so the DOM stays bounded', async () => {
  const list = Array.from({ length: 100000 }, (_, i) => ({ id: i }));
  const p = await page({ html: withContract({ documents: { response: { list } } }) });
  assert.equal(p.$$('.key').filter((b) => b.textContent === '"id"').length, 20);
  assert.ok(p.$('.json').textContent.includes('… 99980 more'));
});

test('a page without a contract block still works', async () => {
  const html = TEMPLATE.replace(/<script type="application\/json" id="contract">[\s\S]*?<\/script>/, '')
    .replace(/<section data-tab="Contract">[\s\S]*?<\/section>/, '');
  const p = await page({ html });
  assert.equal(p.$$('[role=tab]').length, 2);
  assert.equal(article(p).querySelector('.badge').textContent, 'new');
});

test('a class may carry its own colour, and an unknown class keeps its id', async () => {
  const contract = {
    classes: [{ id: 'x', label: 'X', color: 'red', hint: 'why' }],
    documents: { response: { a: 1, b: 2 } },
    fields: { a: { class: 'x' }, b: { class: 'gone' } },
  };
  const p = await page({ html: withContract(contract) });
  assert.equal(p.$('.key').style.getPropertyValue('--field'), 'red');
  assert.equal(p.$('.legend .pill').title, 'why');
  p.$$('.key')[1].click();
  assert.equal(p.$('.detail .pill').textContent, 'gone');
});

test('the passport shows number, title, class, status, attributes and note', async () => {
  const p = await page();
  p.$$('.key').find((b) => b.textContent === '"total"').click();
  const card = p.$('.detail');
  assert.equal(card.querySelector('.eyebrow').textContent, 'Field passport · registry № 3');
  assert.equal(card.querySelector('.biz').textContent, 'Predicted total');
  assert.equal(card.querySelector('.pill').textContent, 'Model');
  assert.equal(card.querySelector('.tone-part').textContent, 'Partly');
  assert.equal(card.querySelector('.note').textContent, 'Rounded to two digits.');
  assert.match(card.querySelector('.kv').textContent, /OwnerData science/);
});

test('a contract may fix the registry number', async () => {
  const p = await page({ html: withContract({ documents: { response: { a: 1 } }, fields: { a: { number: 13 } } }) });
  assert.match(p.$('.detail .eyebrow').textContent, /№ 13/);
});

test('an unknown status keeps its id', async () => {
  const contract = { statuses: [{ id: 'yes', label: 'Yes', tone: 'ok' }], documents: { response: { a: 1 } }, fields: { a: { status: 'odd' } } };
  const p = await page({ html: withContract(contract) });
  assert.match(p.$('.detail .kv').textContent, /odd/);
});

test('the status dot follows the field, also when filled in', async () => {
  const p = await page();
  const dot = (name) => p.$$('.key').find((b) => b.textContent === `"${name}"`).parentElement.querySelector('.miss');
  assert.equal(dot('total').className, 'miss tone-part');
  assert.equal(dot('total').textContent, '●');
  assert.equal(dot('segment').textContent, '');
  p.$$('.key').find((b) => b.textContent === '"segment"').click();
  const select = p.$$('.detail select')[1];
  select.value = 'no';
  select.dispatchEvent(new p.window.Event('change'));
  await tick();
  assert.equal(dot('segment').className, 'miss tone-no');
});

test('a branch key carries a dot on its opening line', async () => {
  const contract = { statuses: [{ id: 'yes', label: 'Yes', tone: 'ok' }], documents: { response: { a: { b: 1 } } }, fields: { a: { status: 'yes' } } };
  const p = await page({ html: withContract(contract) });
  assert.equal(p.$('.ln .miss').textContent, '●');
});

test('the summary counts fields per class and follows filled cards', async () => {
  const p = await page();
  const summary = () => p.$$('.sumbar .pill').map((x) => x.textContent);
  assert.deepEqual(summary(), ['Model1', 'Static1', 'Not classified2']);
  p.$$('.key').find((b) => b.textContent === '"segment"').click();
  const select = p.$('.detail select');
  select.value = 'dictionary';
  select.dispatchEvent(new p.window.Event('change'));
  await tick();
  assert.deepEqual(summary(), ['Model1', 'Dictionary1', 'Static1', 'Not classified1']);
});

test('the bar counts approvals and comments and names the file', async () => {
  const p = await page();
  assert.equal(p.$('#db').textContent, 'demo.comments.json');
  assert.equal(p.$('#stat').textContent, '✓ 0 approved · ✎ 0 comments');
  await comment(p, article(p), 'x');
  buttonIn(article(p), 'Approve').click();
  await tick();
  assert.equal(p.$('#stat').textContent, '✓ 1 approved · ✎ 1 comments');
});

test('Copy JSON puts the document on the clipboard and says so', async () => {
  const p = await page();
  const copied = [];
  Object.defineProperty(p.window.navigator, 'clipboard', { value: { writeText: async (t) => copied.push(t) }, configurable: true });
  const button = p.$('.phead button');
  assert.equal(button.textContent, 'Copy JSON');
  button.click();
  await tick();
  assert.equal(button.textContent, 'Copied');
  assert.deepEqual(JSON.parse(copied[0]), { version: '1.0', result: { total: 0.87, segment: 'A' } });
  Object.defineProperty(p.window.navigator, 'clipboard', { value: { writeText: async () => { throw new Error('denied'); } }, configurable: true });
  button.click();
  await tick();
  assert.equal(button.textContent, 'Copying is unavailable');
});

test('a field keyed by document wins, and may state its own type', async () => {
  const contract = {
    documents: { one: { id: 1 } },
    fields: { id: { title: 'General' }, 'one:id': { title: 'Specific', type: 'bigint' } },
  };
  const html = withContract(contract).replace('data-json="response"', 'data-json="one"');
  const p = await page({ html });
  assert.equal(p.$('.detail .biz').textContent, 'Specific');
  assert.match(p.$('.detail .kv').textContent, /Typebigint/);
});

test('a host that stops answering ends as a status, not a hang', async () => {
  const html = TEMPLATE;
  const p = await page({ html });
  p.host.respond = () => {};
  assert.ok(p.status());
  await settle();
});
