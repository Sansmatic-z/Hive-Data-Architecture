#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { webcrypto } from 'node:crypto';

globalThis.crypto = webcrypto;

const [command, input] = process.argv.slice(2);

if (!command || !input) {
  console.error('Usage: node cli/hda-cli.mjs <inspect|verify> <archive.hda.html>');
  process.exit(1);
}

const source = await fs.readFile(input);
const footer = new DataView(source.buffer, source.byteOffset + source.byteLength - 16, 16);
const headerEnd = Number(footer.getBigUint64(0, true));
const magic = footer.getUint32(8, true);
const version = footer.getUint32(12, true);

if (magic !== 0x48444121) {
  throw new Error('Not a valid HDA archive.');
}

const headerText = source.subarray(0, Math.max(headerEnd, 512 * 1024)).toString('utf8');
const spineMatch = headerText.match(/<script id="spine-node" type="application\/hda-spine">([\s\S]*?)<\/script>/);
if (!spineMatch) {
  throw new Error('Spine metadata not found.');
}

const spine = JSON.parse(spineMatch[1]);

if (command === 'inspect') {
  console.log(JSON.stringify({
    archive: path.basename(input),
    version,
    filename: spine.filename,
    totalBytes: spine.total_bytes,
    cellCount: spine.cell_count,
    compression: spine.compression,
    encryption: spine.encryption,
    signature: spine.signature?.algorithm ?? null,
    kdf: spine.kdf?.algorithm ?? null,
  }, null, 2));
  process.exit(0);
}

if (command === 'verify') {
  if (!Array.isArray(spine.cells)) {
    throw new Error('Malformed cell list.');
  }
  let payloadOffset = headerEnd;
  for (const cell of spine.cells.filter((entry) => !entry.isParity)) {
    const start = Number.isInteger(cell.offset) ? cell.offset : payloadOffset;
    const end = start + cell.compressed_length;
    if (end > source.byteLength - 16) {
      throw new Error(`Cell ${cell.id} overflows archive bounds.`);
    }
    payloadOffset = end;
  }
  console.log(`Archive ${path.basename(input)} passed structural verification.`);
  process.exit(0);
}

console.error(`Unknown command: ${command}`);
process.exit(1);
