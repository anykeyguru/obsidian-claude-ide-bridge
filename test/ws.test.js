'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');

const { WsConnection } = require('../src/ws');
const { MAX_WS_MESSAGE_BYTES, MAX_WS_SEND_QUEUE_BYTES } = require('../src/limits');

class FakeSocket extends EventEmitter {
  constructor() { super(); this.written = []; this.ended = false; this.destroyed = false; this.writableLength = 0; }

  setNoDelay() {}

  write(data) { this.written.push(data); }

  end() { this.ended = true; }
}

function open() {
  const socket = new FakeSocket();
  const messages = [];
  const closed = [];
  const conn = new WsConnection(socket, (c, msg) => messages.push(msg), (c) => closed.push(c));
  return { socket, messages, closed, conn };
}

function frame(opcode, payload, { fin = true, masked = true } = {}) {
  const body = Buffer.from(payload);
  const length = body.length;
  let head;
  if (length < 126) head = Buffer.from([0, length]);
  else if (length < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(length, 2); } else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(length), 2); }
  head[0] = (fin ? 0x80 : 0) | opcode;
  if (!masked) return Buffer.concat([head, body]);
  head[1] |= 0x80;
  const mask = crypto.randomBytes(4);
  const out = Buffer.from(body);
  for (let i = 0; i < out.length; i += 1) out[i] ^= mask[i & 3];
  return Buffer.concat([head, mask, out]);
}

test('decodes a masked text frame', () => {
  const { socket, messages } = open();
  socket.emit('data', frame(1, 'hello'));
  assert.deepEqual(messages, ['hello']);
});

test('decodes unmasked, 16-bit and 64-bit lengths', () => {
  const { socket, messages } = open();
  socket.emit('data', frame(1, 'a', { masked: false }));
  socket.emit('data', frame(1, 'b'.repeat(300)));
  socket.emit('data', frame(1, 'c'.repeat(70000)));
  assert.deepEqual(messages.map((m) => m.length), [1, 300, 70000]);
});

test('handles a frame split across chunks and two frames in one chunk', () => {
  const { socket, messages } = open();
  const bytes = frame(1, 'split');
  socket.emit('data', bytes.subarray(0, 1));
  socket.emit('data', bytes.subarray(1, 4));
  socket.emit('data', bytes.subarray(4));
  socket.emit('data', Buffer.concat([frame(1, 'one'), frame(1, 'two')]));
  assert.deepEqual(messages, ['split', 'one', 'two']);
});

test('joins a large frame once, not per chunk', () => {
  const { socket, messages } = open();
  const bytes = frame(1, 'x'.repeat(1024 * 1024));
  const original = Buffer.concat;
  let joins = 0;
  Buffer.concat = (...args) => { joins += 1; return original(...args); };
  try {
    for (let i = 0; i < bytes.length; i += 1024) socket.emit('data', bytes.subarray(i, i + 1024));
  } finally {
    Buffer.concat = original;
  }
  assert.equal(messages[0].length, 1024 * 1024);
  assert.ok(joins <= 2, `joined ${joins} times`);
});

test('reassembles fragments and ignores a stray continuation', () => {
  const { socket, messages } = open();
  socket.emit('data', frame(0, 'stray'));
  socket.emit('data', frame(1, 'par', { fin: false }));
  socket.emit('data', frame(0, 't1', { fin: false }));
  socket.emit('data', frame(0, '-end'));
  assert.deepEqual(messages, ['part1-end']);
});

test('answers ping with pong and close with close', () => {
  const { socket } = open();
  socket.emit('data', frame(9, 'hi'));
  assert.equal(socket.written[0][0], 0x8a);
  assert.equal(socket.written[0].subarray(2).toString(), 'hi');
  socket.emit('data', frame(8, Buffer.from([3, 232])));
  assert.equal(socket.written[1][0], 0x88);
  assert.equal(socket.ended, true);
});

test('ignores pong frames', () => {
  const { socket, messages } = open();
  socket.emit('data', frame(10, ''));
  assert.deepEqual(messages, []);
  assert.deepEqual(socket.written, []);
});

test('closes with 1009 on a declared frame over the limit, before it arrives', () => {
  const { socket, messages } = open();
  const head = Buffer.alloc(10);
  head[0] = 0x81;
  head[1] = 127;
  head.writeBigUInt64BE(BigInt(MAX_WS_MESSAGE_BYTES + 1), 2);
  socket.emit('data', head);
  assert.equal(socket.ended, true);
  assert.equal(socket.written[0].readUInt16BE(2), 1009);
  assert.deepEqual(messages, []);
});

test('closes with 1009 when fragments exceed the limit together', () => {
  const { socket, conn } = open();
  socket.emit('data', frame(1, 'a', { fin: false }));
  conn.fragmentBytes = MAX_WS_MESSAGE_BYTES;
  socket.emit('data', frame(0, 'b', { fin: false }));
  assert.equal(socket.ended, true);
  assert.equal(conn.fragments, null);
});

test('drops data after closing for size', () => {
  const { socket, messages } = open();
  const head = Buffer.alloc(10);
  head[0] = 0x81;
  head[1] = 127;
  head.writeBigUInt64BE(BigInt(MAX_WS_MESSAGE_BYTES + 1), 2);
  socket.emit('data', head);
  socket.emit('data', Buffer.alloc(1024));
  assert.deepEqual(messages, []);
});

test('encodes each payload length', () => {
  const { socket, conn } = open();
  conn.sendEncoded(Buffer.alloc(5));
  conn.sendEncoded(Buffer.alloc(200));
  conn.sendEncoded(Buffer.alloc(70000));
  assert.equal(socket.written[0][1], 5);
  assert.equal(socket.written[1][1], 126);
  assert.equal(socket.written[1].readUInt16BE(2), 200);
  assert.equal(socket.written[2][1], 127);
  assert.equal(Number(socket.written[2].readBigUInt64BE(2)), 70000);
});

test('send serializes to a text frame', () => {
  const { socket, conn } = open();
  conn.send({ a: 1 });
  assert.equal(socket.written[0].subarray(2).toString(), '{"a":1}');
});

test('reports congestion from the unsent queue', () => {
  const { socket, conn } = open();
  assert.equal(conn.congested, false);
  socket.writableLength = MAX_WS_SEND_QUEUE_BYTES + 1;
  assert.equal(conn.congested, true);
});

test('writes nothing once closed or destroyed', () => {
  const { socket, conn, closed } = open();
  socket.emit('close');
  socket.emit('error');
  assert.equal(closed.length, 1);
  conn.send({});
  assert.deepEqual(socket.written, []);
});

test('close sends a close frame and ends the socket', () => {
  const { socket, conn } = open();
  conn.close();
  assert.equal(socket.written[0][0], 0x88);
  assert.equal(socket.ended, true);
});
