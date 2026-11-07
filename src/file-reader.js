'use strict';

const fs = require('fs');

// Random access to a file on disk, so a format reads only the bytes it needs.
function createReader(filePath) {
  return {
    async size() {
      return (await fs.promises.stat(filePath)).size;
    },
    async read(offset, length) {
      const handle = await fs.promises.open(filePath, 'r');
      try {
        const bytes = new Uint8Array(length);
        const { bytesRead } = await handle.read(bytes, 0, length, offset);
        return bytes.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    },
  };
}

module.exports = { createReader };
