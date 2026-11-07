'use strict';

require('./support/setup');

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { handleMcpMessage } = require('../src/mcp');
const { settle } = require('./support/setup');

function setup() {
  const sent = [];
  const events = [];
  const host = {
    version: '9.9.9',
    context: { value: 7 },
    onInitialized: () => events.push('initialized'),
    tools: [
      { name: 'echo', description: 'd', inputSchema: {}, run: (ctx, args) => ({ ctx: ctx.value, args }) },
      { name: 'text', description: 'd', inputSchema: {}, run: () => 'plain' },
      { name: 'boom', description: 'd', inputSchema: {}, run: () => { throw new Error('failed'); } },
    ],
  };
  return { sent, events, host, conn: { send: (m) => sent.push(m) } };
}

const call = (s, message) => handleMcpMessage(s.host, s.conn, JSON.stringify(message));

test('initialize reports the plugin version and echoes the protocol', () => {
  const s = setup();
  call(s, { id: 1, method: 'initialize', params: { protocolVersion: 'x' } });
  assert.equal(s.sent[0].result.serverInfo.version, '9.9.9');
  assert.equal(s.sent[0].result.protocolVersion, 'x');
  call(s, { id: 2, method: 'initialize' });
  assert.equal(s.sent[1].result.protocolVersion, '2024-11-05');
});

test('initialized notification reaches the host without a reply', () => {
  const s = setup();
  call(s, { method: 'notifications/initialized' });
  assert.deepEqual(s.events, ['initialized']);
  assert.deepEqual(s.sent, []);
});

test('tools/list hides the run function', () => {
  const s = setup();
  call(s, { id: 1, method: 'tools/list' });
  assert.deepEqual(s.sent[0].result.tools[0], { name: 'echo', description: 'd', inputSchema: {} });
});

test('tools/call passes context and arguments, and serializes objects', async () => {
  const s = setup();
  call(s, { id: 1, method: 'tools/call', params: { name: 'echo', arguments: { a: 1 } } });
  await settle();
  assert.deepEqual(JSON.parse(s.sent[0].result.content[0].text), { ctx: 7, args: { a: 1 } });
});

test('tools/call keeps text as it is and defaults arguments', async () => {
  const s = setup();
  call(s, { id: 1, method: 'tools/call', params: { name: 'text' } });
  await settle();
  assert.equal(s.sent[0].result.content[0].text, 'plain');
});

test('a failing or unknown tool is an error result, not a crash', async () => {
  const s = setup();
  call(s, { id: 1, method: 'tools/call', params: { name: 'boom' } });
  call(s, { id: 2, method: 'tools/call', params: { name: 'nope' } });
  call(s, { id: 3, method: 'tools/call' });
  await settle();
  assert.equal(s.sent[0].result.isError, true);
  assert.equal(s.sent[0].result.content[0].text, 'failed');
  assert.match(s.sent[1].result.content[0].text, /Unknown tool: nope/);
  assert.match(s.sent[2].result.content[0].text, /Unknown tool/);
});

test('simple methods answer', () => {
  const s = setup();
  call(s, { id: 1, method: 'ping' });
  call(s, { id: 2, method: 'prompts/list' });
  call(s, { id: 3, method: 'resources/list' });
  assert.deepEqual(s.sent.map((m) => m.result), [{}, { prompts: [] }, { resources: [] }]);
});

test('an unknown method fails only when it expects a reply', () => {
  const s = setup();
  call(s, { method: 'unknown/thing' });
  call(s, { method: 'notifications/other' });
  assert.deepEqual(s.sent, []);
  call(s, { id: 1, method: 'unknown/thing' });
  assert.equal(s.sent[0].error.code, -32601);
});

test('ignores broken JSON, responses and replies without an id', () => {
  const s = setup();
  handleMcpMessage(s.host, s.conn, '{oops');
  call(s, { id: 1, result: {} });
  call(s, { method: 'ping' });
  assert.deepEqual(s.sent, []);
});
