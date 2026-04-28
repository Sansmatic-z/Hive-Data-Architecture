import '@testing-library/jest-dom';
import { HDA_CONFIG } from '../config/hda';

// Mock window.crypto.subtle for tests
Object.defineProperty(window, 'crypto', {
  value: {
    subtle: {
      digest: async (algorithm: string, data: ArrayBuffer) => {
        // Return a deterministic fake hash for tests
        const hash = new ArrayBuffer(32);
        new Uint8Array(hash).fill(0xab);
        return hash;
      },
      importKey: async () => ({}),
      deriveKey: async () => ({}),
      generateKey: async () => ({ publicKey: {}, privateKey: {} }),
      exportKey: async () => new ArrayBuffer(16),
      verify: async () => true,
      encrypt: async (params: any, key: any, data: ArrayBuffer) => data,
      decrypt: async (params: any, key: any, data: ArrayBuffer) => data,
      sign: async () => new ArrayBuffer(16),
      getRandomValues: (array: Uint8Array) => {
        for (let i = 0; i < array.length; i++) {
          array[i] = i % 256;
        }
        return array;
      },
    },
    getRandomValues: (array: Uint8Array) => {
      for (let i = 0; i < array.length; i++) {
        array[i] = i % 256;
      }
      return array;
    },
  },
});

globalThis.CompressionStream = class {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array | ArrayBuffer>;

  constructor(_format: string) {
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;

    this.readable = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
      },
    });

    this.writable = new WritableStream<Uint8Array | ArrayBuffer>({
      write(chunk) {
        controller?.enqueue(
          chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk),
        );
      },
      close() {
        controller?.close();
      },
    });
  }
} as any;

globalThis.DecompressionStream = class {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array | ArrayBuffer>;

  constructor(_format: string) {
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;

    this.readable = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
      },
    });

    this.writable = new WritableStream<Uint8Array | ArrayBuffer>({
      write(chunk) {
        controller?.enqueue(
          chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk),
        );
      },
      close() {
        controller?.close();
      },
    });
  }
} as any;

class MockWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  postMessage(message: { id: number; job: any }) {
    queueMicrotask(async () => {
      try {
        const response = await processWorkerJob(message);
        this.onmessage?.({ data: response } as MessageEvent);
      } catch (error) {
        this.onerror?.({
          error,
          message: error instanceof Error ? error.message : 'Mock worker failure',
        } as ErrorEvent);
      }
    });
  }

  terminate() {}
}

async function processWorkerJob(message: { id: number; job: any }) {
  const { id, job } = message;

  if (job.type === 'encode-cell') {
    const checksum = 'abababababababab';
    let buffer = job.buffer;

    if (job.password) {
      const salt = new Uint8Array(HDA_CONFIG.SALT_SIZE);
      const iv = new Uint8Array(HDA_CONFIG.IV_SIZE);
      const packed = new Uint8Array(HDA_CONFIG.SALT_SIZE + HDA_CONFIG.IV_SIZE + buffer.byteLength);
      packed.set(salt, 0);
      packed.set(iv, HDA_CONFIG.SALT_SIZE);
      packed.set(new Uint8Array(buffer), HDA_CONFIG.SALT_SIZE + HDA_CONFIG.IV_SIZE);
      buffer = packed.buffer;
    }

    return {
      id,
      ok: true,
      result: {
        type: 'encode-cell',
        buffer,
        checksum,
        compression: job.compression,
        sourceHash: 'cdcdcdcdcdcdcdcd',
        kdf: job.kdf ?? null,
      },
    };
  }

  let buffer = job.buffer;
  if (job.isEncrypted && job.password) {
    buffer = buffer.slice(HDA_CONFIG.SALT_SIZE + HDA_CONFIG.IV_SIZE);
  }

  return {
    id,
    ok: true,
    result: {
      type: 'decode-cell',
      buffer,
      checksum: 'abababababababab',
    },
  };
}

Object.defineProperty(globalThis, 'Worker', {
  value: MockWorker,
  configurable: true,
});
