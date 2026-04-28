import { HDA_CONFIG } from '../config/hda';
import { HDACompression, HDAKdf } from '../types';
import { deriveKey, decryptData, encryptData } from './cryptoService';
import { getChecksum, getFullHashHex } from '../lib/hdaProtocol';
import brotliReady from 'brotli-wasm';
import { compressSync, decompressSync } from 'fflate';
const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
};

type EncodeCellJob = {
  type: 'encode-cell';
  buffer: ArrayBuffer;
  compression: HDACompression;
  password: string | null;
  kdf?: HDAKdf | null;
};

type DecodeCellJob = {
  type: 'decode-cell';
  buffer: ArrayBuffer;
  compression: HDACompression;
  password: string | null;
  isEncrypted: boolean;
  checksum: string;
  expectedLength: number;
  kdf?: HDAKdf | null;
};

type WorkerRequest = {
  id: number;
  job: EncodeCellJob | DecodeCellJob;
};

type WorkerResponse =
  | {
      id: number;
      ok: true;
      result:
        | {
            type: 'encode-cell';
            buffer: ArrayBuffer;
            checksum: string;
            compression: HDACompression;
            sourceHash: string;
            kdf: HDAKdf | null;
          }
        | {
            type: 'decode-cell';
            buffer: ArrayBuffer;
            checksum: string;
          };
    }
  | {
      id: number;
      ok: false;
      error: string;
    };

let brotliModulePromise: Promise<Awaited<typeof brotliReady>> | null = null;

async function getBrotliModule() {
  if (!brotliModulePromise) {
    brotliModulePromise = Promise.resolve(brotliReady);
  }
  return brotliModulePromise;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function supportsNativeCodec(kind: 'CompressionStream' | 'DecompressionStream', codec: string): boolean {
  try {
    if (kind === 'CompressionStream') {
      new CompressionStream(codec as CompressionFormat);
    } else {
      new DecompressionStream(codec as CompressionFormat);
    }
    return true;
  } catch {
    return false;
  }
}

async function compressWithStream(codec: 'deflate' | 'brotli' | 'zstd', input: ArrayBuffer): Promise<ArrayBuffer> {
  return new Response(
    new Blob([input]).stream().pipeThrough(new CompressionStream(codec as CompressionFormat)),
  ).arrayBuffer();
}

async function decompressWithStream(codec: 'deflate' | 'brotli' | 'zstd', input: ArrayBuffer): Promise<ArrayBuffer> {
  return new Response(
    new Blob([input]).stream().pipeThrough(new DecompressionStream(codec as CompressionFormat)),
  ).arrayBuffer();
}

async function compressBuffer(codec: HDACompression, input: ArrayBuffer): Promise<ArrayBuffer> {
  if (codec === 'none') {
    return input;
  }

  if (codec === 'deflate') {
    if (!supportsNativeCodec('CompressionStream', 'deflate')) {
      return toArrayBuffer(compressSync(new Uint8Array(input)));
    }
    return compressWithStream('deflate', input);
  }

  const source = new Uint8Array(input);
  if (codec === 'brotli') {
    if (supportsNativeCodec('CompressionStream', 'brotli')) {
      return compressWithStream('brotli', input);
    }
    const brotli = await getBrotliModule();
    return toArrayBuffer(brotli.compress(source));
  }

  if (!supportsNativeCodec('CompressionStream', 'zstd')) {
    throw new Error('Zstd compression is not supported in this browser runtime.');
  }
  return compressWithStream('zstd', input);
}

async function decompressBuffer(
  codec: HDACompression,
  input: ArrayBuffer,
  expectedLength: number,
): Promise<ArrayBuffer> {
  if (codec === 'none') {
    return input;
  }

  if (codec === 'deflate') {
    if (!supportsNativeCodec('DecompressionStream', 'deflate')) {
      return toArrayBuffer(decompressSync(new Uint8Array(input)));
    }
    return decompressWithStream('deflate', input);
  }

  const source = new Uint8Array(input);
  if (codec === 'brotli') {
    if (supportsNativeCodec('DecompressionStream', 'brotli')) {
      return decompressWithStream('brotli', input);
    }
    const brotli = await getBrotliModule();
    return toArrayBuffer(brotli.decompress(source));
  }

  if (!supportsNativeCodec('DecompressionStream', 'zstd')) {
    throw new Error('Zstd decompression is not supported in this browser runtime.');
  }
  return decompressWithStream('zstd', input);
}

workerScope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { id, job } = event.data;

  try {
    if (job.type === 'encode-cell') {
      let processed = job.buffer;
      let compression: HDACompression = job.compression;
      const kdf = job.password ? (job.kdf ?? null) : null;

      if (job.compression !== 'none') {
        const compressed = await compressBuffer(job.compression, processed);
        if (compressed.byteLength < processed.byteLength * 0.98) {
          processed = compressed;
        } else {
          compression = 'none';
        }
      }

      const checksum = await getChecksum(processed);
      const sourceHash = await getFullHashHex(job.buffer);
      let output = processed;

      if (job.password) {
        const salt = globalThis.crypto.getRandomValues(new Uint8Array(HDA_CONFIG.SALT_SIZE));
        const iv = globalThis.crypto.getRandomValues(new Uint8Array(HDA_CONFIG.IV_SIZE));
        const key = await deriveKey(job.password, salt, kdf ?? undefined);
        const encrypted = await encryptData(processed, key, iv);
        const packed = new Uint8Array(HDA_CONFIG.SALT_SIZE + HDA_CONFIG.IV_SIZE + encrypted.byteLength);
        packed.set(salt, 0);
        packed.set(iv, HDA_CONFIG.SALT_SIZE);
        packed.set(new Uint8Array(encrypted), HDA_CONFIG.SALT_SIZE + HDA_CONFIG.IV_SIZE);
        output = packed.buffer;
      }

      const response: WorkerResponse = {
        id,
        ok: true,
        result: {
          type: 'encode-cell',
          buffer: output,
          checksum,
          compression,
          sourceHash,
          kdf,
        },
      };
      workerScope.postMessage(response, [output]);
      return;
    }

    let processed = job.buffer;
    if (job.isEncrypted && job.password) {
      const salt = new Uint8Array(processed.slice(0, HDA_CONFIG.SALT_SIZE));
      const iv = new Uint8Array(
        processed.slice(HDA_CONFIG.SALT_SIZE, HDA_CONFIG.SALT_SIZE + HDA_CONFIG.IV_SIZE),
      );
      const encrypted = processed.slice(HDA_CONFIG.SALT_SIZE + HDA_CONFIG.IV_SIZE);
      const key = await deriveKey(job.password, salt, job.kdf ?? undefined);
      processed = await decryptData(encrypted, key, iv);
    }

    const checksum = await getChecksum(processed);
    if (checksum !== job.checksum) {
      throw new Error(`Integrity Breach: checksum mismatch (${checksum} !== ${job.checksum}).`);
    }

    processed = await decompressBuffer(job.compression, processed, job.expectedLength);

    const response: WorkerResponse = {
      id,
      ok: true,
      result: {
        type: 'decode-cell',
        buffer: processed,
        checksum,
      },
    };
    workerScope.postMessage(response, [processed]);
  } catch (error) {
    const response: WorkerResponse = {
      id,
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown worker failure.',
    };
    workerScope.postMessage(response);
  }
};
