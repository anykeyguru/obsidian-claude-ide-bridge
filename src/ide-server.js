'use strict';

const crypto = require('crypto');
const http = require('http');
const { WS_GUID } = require('./ws');

// Validates the upgrade and returns the response head, or null after refusing.
function acceptUpgrade(req, socket, authToken) {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return null;
  }
  if (req.headers['x-claude-code-ide-authorization'] !== authToken) {
    socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return null;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
  ];
  const requested = req.headers['sec-websocket-protocol'];
  if (requested) {
    const protocols = requested.split(',').map((s) => s.trim());
    headers.push(`Sec-WebSocket-Protocol: ${protocols.includes('mcp') ? 'mcp' : protocols[0]}`);
  }
  return `${headers.join('\r\n')}\r\n\r\n`;
}

function startIdeServer(authToken, onSocket) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.writeHead(426, { 'Content-Type': 'text/plain' });
      res.end('Upgrade Required');
    });
    server.on('upgrade', (req, socket) => {
      const head = acceptUpgrade(req, socket, authToken);
      if (!head) return;
      socket.write(head);
      onSocket(socket);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

module.exports = { startIdeServer };
