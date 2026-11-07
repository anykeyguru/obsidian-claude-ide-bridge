'use strict';

const { treeOf } = require('./tree');

const LENGTH_BYTES = 8;
const MAX_HEADER_BYTES = 256 * 1024 * 1024;

// Layout: u64 little-endian header length, JSON header, tensor bytes.
async function readHeader(reader) {
  const size = await reader.size();
  const prefix = await reader.read(0, LENGTH_BYTES);
  if (prefix.length < LENGTH_BYTES) throw new Error('Not a safetensors file: too short');
  const length = new DataView(prefix.buffer, prefix.byteOffset, LENGTH_BYTES).getBigUint64(0, true);
  if (length > BigInt(Math.min(size - LENGTH_BYTES, MAX_HEADER_BYTES))) {
    throw new Error('Not a safetensors file: bad header length');
  }
  const bytes = await reader.read(LENGTH_BYTES, Number(length));
  const { __metadata__: metadata = {}, ...tensors } = JSON.parse(new TextDecoder().decode(bytes));
  return { metadata, tensors };
}

module.exports = {
  id: 'safetensors',
  extensions: ['safetensors'],
  icon: 'database',
  binary: true,
  mount: treeOf(readHeader),
  readHeader,
};
