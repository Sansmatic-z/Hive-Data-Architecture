import { ResumeCheckpoint, ResumeCheckpointSummary } from '../types';

const checkpoints = new Map<string, ResumeCheckpoint>();
const DB_NAME = 'hda-resume-store';
const DB_VERSION = 1;
const STORE_NAME = 'checkpoints';

let dbPromise: Promise<IDBDatabase | null> | null = null;

function canUseIndexedDB(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openDb(): Promise<IDBDatabase | null> {
  if (!canUseIndexedDB()) {
    return Promise.resolve(null);
  }

  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'resumeKey' });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
  }

  return dbPromise;
}

function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) {
          resolve(null);
          return;
        }

        try {
          const tx = db.transaction(STORE_NAME, mode);
          const store = tx.objectStore(STORE_NAME);
          const request = run(store);

          tx.oncomplete = () => {
            if (request && 'result' in request) {
              resolve((request.result as T | undefined) ?? null);
            } else {
              resolve(null);
            }
          };
          tx.onerror = () => resolve(null);
          tx.onabort = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

function toSummary(checkpoint: ResumeCheckpoint): ResumeCheckpointSummary {
  return {
    resumeKey: checkpoint.resumeKey,
    mode: checkpoint.mode,
    fileName: checkpoint.fileName,
    fileSize: checkpoint.fileSize,
    fileLastModified: checkpoint.fileLastModified,
    updatedAt: checkpoint.updatedAt,
    nextCellIndex: checkpoint.nextCellIndex,
    totalBytes: checkpoint.totalBytes,
    hasFileHandle: !!checkpoint.fileHandle,
    hasSourceFileHandle: !!checkpoint.sourceFileHandle,
  };
}

export async function listCheckpoints(): Promise<ResumeCheckpointSummary[]> {
  const dbValue = await withStore<ResumeCheckpoint[]>('readonly', (store) => store.getAll());
  if (dbValue && dbValue.length > 0) {
    return dbValue.map(toSummary).sort((left, right) => right.updatedAt - left.updatedAt);
  }

  return [...checkpoints.values()].map(toSummary).sort((left, right) => right.updatedAt - left.updatedAt);
}

export async function getCheckpoint<T extends ResumeCheckpoint>(resumeKey: string): Promise<T | null> {
  const cached = checkpoints.get(resumeKey) as T | undefined;
  if (cached) {
    return cached;
  }

  const stored = await withStore<T>('readonly', (store) => store.get(resumeKey));
  if (stored) {
    checkpoints.set(resumeKey, stored);
    return stored;
  }

  return null;
}

export async function setCheckpoint(checkpoint: ResumeCheckpoint): Promise<void> {
  const persisted = {
    ...checkpoint,
    persistedAt: Date.now(),
  };
  checkpoints.set(checkpoint.resumeKey, persisted);
  await withStore('readwrite', (store) => store.put(persisted));
}

export async function clearCheckpoint(resumeKey: string): Promise<void> {
  checkpoints.delete(resumeKey);
  await withStore('readwrite', (store) => store.delete(resumeKey));
}
