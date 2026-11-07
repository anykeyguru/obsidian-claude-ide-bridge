'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { after, before, test } = require('node:test');

const { startIdeServer } = require('../src/ide-server');
const { WS_GUID } = require('../src/ws');

let server;
let port;
const sockets = [];

before(async () => {
  server = await startIdeServer('secret', (socket) => sockets.push(socket));
  port = server.address().port;
});

after(() => {
  for (const socket of sockets) socket.destroy();
  server.close();
});

function upgrade(headers) {
  return new Promise((resolve) => {
    const req = http.request({
      port, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': 'abc', ...headers },
    });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve({ status: res.statusCode, headers: res.headers }); });
    req.on('response', (res) => { res.resume(); resolve({ status: res.statusCode }); });
    req.on('error', () => resolve({ status: 0 }));
    req.end();
  });
}

test('accepts the right token with a correct handshake', async () => {
  const res = await upgrade({ 'x-claude-code-ide-authorization': 'secret' });
  assert.equal(res.status, 101);
  const expected = crypto.createHash('sha1').update(`abc${WS_GUID}`).digest('base64');
  assert.equal(res.headers['sec-websocket-accept'], expected);
});

test('prefers the mcp subprotocol, otherwise the first offered', async () => {
  const both = await upgrade({ 'x-claude-code-ide-authorization': 'secret', 'Sec-WebSocket-Protocol': 'x, mcp' });
  assert.equal(both.headers['sec-websocket-protocol'], 'mcp');
  const other = await upgrade({ 'x-claude-code-ide-authorization': 'secret', 'Sec-WebSocket-Protocol': 'x, y' });
  assert.equal(other.headers['sec-websocket-protocol'], 'x');
});

test('refuses a wrong token', async () => {
  assert.equal((await upgrade({ 'x-claude-code-ide-authorization': 'wrong' })).status, 401);
});

test('refuses a request without a websocket key', async () => {
  const res = await upgrade({ 'Sec-WebSocket-Key': '', 'x-claude-code-ide-authorization': 'secret' });
  assert.equal(res.status, 400);
});

test('plain HTTP gets 426', async () => {
  const status = await new Promise((resolve) => {
    http.get({ port }, (res) => { res.resume(); resolve(res.statusCode); });
  });
  assert.equal(status, 426);
});
