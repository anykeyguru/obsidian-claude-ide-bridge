'use strict';

// Minimal WebSocket server-side connection (RFC 6455, text frames only).

const { MAX_WS_MESSAGE_BYTES, MAX_WS_SEND_QUEUE_BYTES } = require('./limits');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const CLOSE_TOO_BIG = 1009;

class WsConnection {
  constructor(socket, onMessage, onClose) {
    this.socket = socket;
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.buf = Buffer.alloc(0);
    // Chunks wait here until a whole frame can have arrived, so a large frame
    // costs one concat rather than one per chunk.
    this.chunks = [];
    this.chunkBytes = 0;
    this.needed = 2;
    this.fragments = null;
    this.fragmentBytes = 0;
    this.closed = false;
    socket.setNoDelay(true);
    socket.on('data', (d) => {
      this.chunks.push(d);
      this.chunkBytes += d.length;
      if (this.buf.length + this.chunkBytes < this.needed) return;
      this.buf = Buffer.concat([this.buf, ...this.chunks]);
      this.chunks = [];
      this.chunkBytes = 0;
      this.parse();
    });
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
  }

  finish() {
    if (this.closed) return;
    this.closed = true;
    this.onClose(this);
  }

  parse() {
    for (;;) {
      const buf = this.buf;
      this.needed = 2;
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      if (len > MAX_WS_MESSAGE_BYTES) {
        this.closeTooBig();
        return;
      }
      let mask = null;
      if (masked) {
        if (buf.length < off + 4) return;
        mask = buf.subarray(off, off + 4);
        off += 4;
      }
      if (buf.length < off + len) {
        this.needed = off + len;
        return;
      }
      const payload = Buffer.from(buf.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
      this.buf = buf.subarray(off + len);
      this.handleFrame(fin, opcode, payload);
    }
  }

  handleFrame(fin, opcode, payload) {
    switch (opcode) {
      case 0x0: // continuation
        if (!this.fragments) return;
        this.fragmentBytes += payload.length;
        if (this.fragmentBytes > MAX_WS_MESSAGE_BYTES) {
          this.closeTooBig();
          return;
        }
        this.fragments.push(payload);
        if (fin) {
          const msg = Buffer.concat(this.fragments).toString('utf8');
          this.fragments = null;
          this.onMessage(this, msg);
        }
        return;
      case 0x1: // text
      case 0x2: // binary
        if (fin) this.onMessage(this, payload.toString('utf8'));
        else {
          this.fragments = [payload];
          this.fragmentBytes = payload.length;
        }
        return;
      case 0x8: // close
        this.sendFrame(0x8, payload.subarray(0, 2));
        this.socket.end();
        return;
      case 0x9: // ping
        this.sendFrame(0xa, payload);
        return;
      default: // pong and others
        return;
    }
  }

  sendFrame(opcode, payload) {
    if (this.closed || this.socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  // A suspended client stops reading; pushes to it must not pile up in memory.
  get congested() {
    return this.socket.writableLength > MAX_WS_SEND_QUEUE_BYTES;
  }

  sendEncoded(payload) {
    this.sendFrame(0x1, payload);
  }

  send(obj) {
    this.sendEncoded(Buffer.from(JSON.stringify(obj), 'utf8'));
  }

  closeTooBig() {
    this.buf = Buffer.alloc(0);
    this.fragments = null;
    this.needed = Infinity;
    const code = Buffer.alloc(2);
    code.writeUInt16BE(CLOSE_TOO_BIG);
    this.sendFrame(0x8, code);
    this.socket.end();
  }

  close() {
    this.sendFrame(0x8, Buffer.alloc(0));
    this.socket.end();
  }
}

module.exports = { WS_GUID, WsConnection };
