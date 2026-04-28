import {
  DecodeResumeCheckpoint,
  FileMetadata,
  HDACompression,
  HDASpine,
  OperationControlOptions,
  ProgressCallback,
  ProcessingProgress,
} from '../types';
import { createLogger } from '../lib/logger';
import { HDA_CONFIG } from '../config/hda';
import { validatePassword, validateSpine } from '../lib/validators';
import {
  HDA_FOOTER_SIZE,
  assertMemoryFallbackSupported,
  createOperationId,
  createResumeKey,
  getAdaptiveTuning,
  verifyManifestSignature,
} from '../lib/hdaProtocol';
import { WorkerPool } from './workerPool';
import { clearCheckpoint, getCheckpoint, setCheckpoint } from './resumeStore';
import { logSecurityEvent } from '../lib/securityEvents';
import { unwrapSharedPasswordForRecipient } from './cryptoService';

const logger = createLogger('hdaDecoder');

const MAGIC_HDA = HDA_CONFIG.MAGIC_NUMBER;
const VERSION = HDA_CONFIG.PROTOCOL_VERSION;

async function resolveArchivePassword(
  password: string | null,
  spine: HDASpine,
): Promise<string | null> {
  if (!spine.encryption) {
    return null;
  }

  if (!password) {
    return null;
  }

  if (!spine.recipients?.length) {
    return password;
  }

  return (await unwrapSharedPasswordForRecipient(password, spine.recipients)) ?? password;
}

async function ensureHandlePermission(handle: FileSystemFileHandle): Promise<boolean> {
  const permissionHandle = handle as FileSystemFileHandle & {
    queryPermission?: (descriptor?: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
    requestPermission?: (descriptor?: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
  };

  if (!permissionHandle.queryPermission || !permissionHandle.requestPermission) {
    return true;
  }

  const opts = { mode: 'readwrite' as const };
  const status = await permissionHandle.queryPermission(opts);
  if (status === 'granted') {
    return true;
  }

  return (await permissionHandle.requestPermission(opts)) === 'granted';
}

async function maybeAssembleSplitArchive(file: File, companionFiles: File[] = []): Promise<File> {
  if (!companionFiles.length) {
    return file;
  }

  const files = [file, ...companionFiles].sort((left, right) => getVolumeOrder(left.name) - getVolumeOrder(right.name));
  return new File(files, file.name.replace(/\.part\d+\.hda$/i, '.hda.html'), {
    type: file.type || 'text/html',
    lastModified: file.lastModified,
  });
}

function getVolumeOrder(name: string): number {
  const match = name.match(/\.part(\d+)\.hda$/i);
  return match ? Number.parseInt(match[1], 10) : 0;
}

export const decodeFromHDA = async (
  file: File,
  password: string | null,
  onProgress: ProgressCallback,
  options: OperationControlOptions = {},
): Promise<{ blob: Blob; metadata: FileMetadata } | null> => {
  logger.info('Starting HDA decoding', { filename: file.name, size: file.size });
  const sourceFile = await maybeAssembleSplitArchive(file, options.companionFiles);

  // Parse footer
  const footerBlob = sourceFile.slice(-HDA_FOOTER_SIZE);
  const footerView = new DataView(await footerBlob.arrayBuffer());
  const offsetFromFooter = Number(footerView.getBigUint64(0, true));
  const magic = footerView.getUint32(8, true);
  const version = footerView.getUint32(12, true);

  if (magic !== MAGIC_HDA) {
    logger.error('Invalid HDA magic', { magic: magic.toString(16) });
    logSecurityEvent({ code: 'archive_corruption_detected', message: 'Archive footer magic mismatch detected.', data: { fileName: file.name } });
    throw new Error('Not a valid HDA Hive.');
  }

  if (version < HDA_CONFIG.LEGACY_PROTOCOL_VERSION || version > VERSION) {
    logger.error('Unsupported HDA version', { version, expected: VERSION });
    logSecurityEvent({ code: 'version_mismatch', message: 'Unsupported HDA footer version encountered.', data: { version, fileName: file.name } });
    throw new Error(`Unsupported HDA version: ${version}. Expected ${HDA_CONFIG.LEGACY_PROTOCOL_VERSION}-${VERSION}.`);
  }

  // Parse spine from header
  const headerLimit = Math.max(
    Math.min(offsetFromFooter, sourceFile.size - HDA_FOOTER_SIZE),
    HDA_CONFIG.MIN_HEADER_SIZE,
  );
  const headerBlob = sourceFile.slice(0, headerLimit);
  const headerText = await headerBlob.text();
  const spineMatch = headerText.match(
    /<script id="spine-node" type="application\/hda-spine">([\s\S]*?)<\/script>/,
  );
  if (!spineMatch) {
    logger.error('Spine data not found or corrupted');
    logSecurityEvent({ code: 'archive_corruption_detected', message: 'Archive spine block missing or corrupted.', data: { fileName: file.name } });
    throw new Error('Spine data corrupted.');
  }

  let spineData: unknown;
  try {
    spineData = JSON.parse(spineMatch[1]);
  } catch {
    logger.error('Invalid JSON in spine data');
    logSecurityEvent({ code: 'archive_corruption_detected', message: 'Archive spine JSON failed to parse.', data: { fileName: file.name } });
    throw new Error('Spine data corrupted.');
  }

  const spine = validateSpine(spineData) as HDASpine;
  const isEncrypted = !!spine.encryption;

  const unsignedManifest = JSON.stringify({
    version: spine.version,
    total_bytes: spine.total_bytes,
    cell_count: spine.cell_count,
    compression: spine.compression,
    encryption: spine.encryption,
    cells: spine.cells,
    filename: spine.filename,
    mimeType: spine.mimeType,
    comment: spine.comment ?? '',
    passwordHint: spine.passwordHint,
    creatorApp: spine.creatorApp,
    createdAt: spine.createdAt,
    sourceHash: spine.sourceHash,
    tags: spine.tags,
    integrityOnly: spine.integrityOnly,
    folderManifest: spine.folderManifest,
    recipients: spine.recipients,
    compatibility: spine.compatibility,
    kdf: spine.kdf,
    redundancy: spine.redundancy,
    split: spine.split,
  });
  if (!(await verifyManifestSignature(unsignedManifest, spine.signature))) {
    logSecurityEvent({ code: 'archive_corruption_detected', message: 'Manifest signature verification failed.', data: { fileName: file.name } });
    throw new Error('Manifest signature verification failed.');
  }

  if (spine.version < HDA_CONFIG.LEGACY_PROTOCOL_VERSION || spine.version > VERSION) {
    logger.error('Spine version mismatch', { spineVersion: spine.version, expected: VERSION });
    logSecurityEvent({ code: 'version_mismatch', message: 'Unsupported HDA spine version encountered.', data: { spineVersion: spine.version, fileName: file.name } });
    throw new Error(`Unsupported HDA spine version: ${spine.version}. Expected ${HDA_CONFIG.LEGACY_PROTOCOL_VERSION}-${VERSION}.`);
  }

  const validatedPassword = validatePassword(password);

  if (isEncrypted && !validatedPassword) {
    logger.info('Encrypted archive detected, password required');
    throw new Error('ENCRYPTED_VOLUME');
  }
  const accessPassword = await resolveArchivePassword(validatedPassword, spine);

  const metadata: FileMetadata = {
    name: spine.filename || file.name.replace('.hda.html', ''),
    type: spine.mimeType || 'application/octet-stream',
    size: spine.total_bytes,
    timestamp: Date.now(),
    isEncrypted,
  };
  const resumeKey = options.resumeKey ?? createResumeKey(file, 'DECODE');
  const existingCheckpoint = await getCheckpoint<DecodeResumeCheckpoint>(resumeKey);
  const checkpoint =
    existingCheckpoint &&
    existingCheckpoint.fileName === file.name &&
    existingCheckpoint.fileSize === file.size &&
    existingCheckpoint.fileLastModified === file.lastModified
      ? existingCheckpoint
      : null;
  const tuning = checkpoint?.tuning ?? getAdaptiveTuning({ name: file.name, size: file.size, type: file.type });
  const workerCount = tuning.workerCount;
  const operationId = checkpoint?.operationId ?? createOperationId('dec');
  const isResumed = !!checkpoint;

  let handle: FileSystemFileHandle | null = null;
  let useFallback = !!options.verifyOnly || !!options.previewOnly;

  if (options.verifyOnly || options.previewOnly) {
    handle = null;
  } else if (checkpoint?.fileHandle) {
    if (await ensureHandlePermission(checkpoint.fileHandle)) {
      handle = checkpoint.fileHandle;
    } else {
      useFallback = true;
    }
  } else if ('showSaveFilePicker' in window) {
    try {
      handle = await (window as any).showSaveFilePicker({
        suggestedName: metadata.name,
      });
      logger.debug('File handle acquired via File System Access API');
    } catch (err: unknown) {
      const error = err as Error;
      if (error.name === 'AbortError') {
        logger.info('User cancelled file picker');
        return null;
      }
      logger.warn('showSaveFilePicker failed, falling back to memory blob', { error: error.message });
      useFallback = true;
    }
  } else {
    logger.info('File System Access API not available, using memory fallback');
    useFallback = true;
  }

  const writable = handle ? await handle.createWritable() : null;
  let writeClosed = false;
  const workerPool = new WorkerPool<
    {
      type: 'decode-cell';
      buffer: ArrayBuffer;
      compression: HDACompression;
      password: string | null;
      isEncrypted: boolean;
      checksum: string;
      expectedLength: number;
      kdf?: HDASpine['kdf'];
    },
    { type: 'decode-cell'; buffer: ArrayBuffer; checksum: string }
  >(workerCount, () => new Worker(new URL('./hdaWorker.ts', import.meta.url), { type: 'module' }));

  if (!writable && !options.verifyOnly && !options.previewOnly) {
    assertMemoryFallbackSupported(metadata.size);
  }

  let payloadPtr = offsetFromFooter;

  // Auto-correct padding offset (legacy support)
  const probeBlob = sourceFile.slice(payloadPtr, payloadPtr + 1);
  const probe = new Uint8Array(await probeBlob.arrayBuffer());
  if (probe[0] === 32) {
    const FIX_OFFSET = 1024 * 1024 * 1.5;
    const checkBlob = sourceFile.slice(payloadPtr + FIX_OFFSET, payloadPtr + FIX_OFFSET + 1);
    const check = new Uint8Array(await checkBlob.arrayBuffer());
    if (check[0] !== 32) {
      payloadPtr += FIX_OFFSET;
      logger.debug('Applied legacy offset correction', { newOffset: payloadPtr });
    }
  }

  // PARALLELISM AUTO-OPTIMIZATION
  const cores = navigator.hardwareConcurrency || 2;
  const logs = [`[SYSTEM] Core Count: ${cores}`, `[FORGE] Parallel Pool: ${workerCount}x`];

  const cellIndexById = new Map(spine.cells.map((cell, index) => [cell.id, { cell, index }]));
  const tasks = spine.cells.filter((cell) => !cell.isParity).map((cell, i) => {
    const fallbackStart = payloadPtr;
    const start =
      Number.isInteger(cell.offset) &&
      cell.offset >= offsetFromFooter &&
      cell.offset + cell.compressed_length <= sourceFile.size - HDA_FOOTER_SIZE
        ? cell.offset
        : fallbackStart;
    payloadPtr = start + cell.compressed_length;
    return { index: i, cell, start };
  });
  const totalPrimaryCells = tasks.length;

  let finished = checkpoint?.nextCellIndex ?? 0;
  const blobParts: Blob[] = checkpoint?.blobParts ? [...checkpoint.blobParts] : [];
  const startedAt = performance.now();
  let processedBytes =
    checkpoint?.processedBytes ??
    tasks.slice(0, finished).reduce((sum, task) => sum + task.cell.length, 0);
  const emitProgress = (progress: ProcessingProgress) => {
    const elapsedSeconds = Math.max((performance.now() - startedAt) / 1000, 0.001);
    const throughputBytesPerSecond = processedBytes / elapsedSeconds;
    const remainingBytes = Math.max(metadata.size - processedBytes, 0);

    onProgress({
      ...progress,
      currentCell: finished,
      totalCells: totalPrimaryCells,
      processedBytes,
      totalBytes: metadata.size,
      throughputBytesPerSecond,
      etaSeconds:
        throughputBytesPerSecond > 0 ? remainingBytes / throughputBytesPerSecond : null,
      mode: writable ? 'disk' : 'memory',
      cellSize: tuning.cellSize,
      workerCount,
      operationId,
      isResumable: true,
      resumed: isResumed,
    });
  };

  logger.info(`Processing ${tasks.length} cells with ${workerCount} parallel workers`);

  try {
    if (writable && isResumed) {
      await writable.seek(processedBytes);
    }

    await setCheckpoint({
      operationId,
      resumeKey,
      mode: 'DECODE',
      fileName: file.name,
      fileSize: file.size,
      fileLastModified: file.lastModified,
      passwordHashHint: accessPassword ? `${accessPassword.length}:${accessPassword.charCodeAt(0)}` : null,
      updatedAt: Date.now(),
      processedBytes,
      totalBytes: metadata.size,
      nextCellIndex: finished,
      tuning,
      headerSize: offsetFromFooter,
      spine,
      blobParts: writable ? undefined : blobParts,
      fileHandle: handle,
      sourceFileHandle: options.sourceFileHandle ?? checkpoint?.sourceFileHandle ?? null,
    });

    for (let i = finished; i < tasks.length; i += workerCount) {
      if (options.signal?.aborted) {
        throw new DOMException('Operation cancelled.', 'AbortError');
      }

      const batchTasks = tasks.slice(i, i + workerCount);
      emitProgress({
        percentage: Math.round((finished / Math.max(totalPrimaryCells, 1)) * 100),
        stage: 'processing',
        status: `Dispatching ${batchTasks.length} cell(s)...`,
        logs: [...logs, `[QUEUE] Cell ${i + 1} -> Cell ${i + batchTasks.length}`],
      });

      const batchResults = await Promise.all(
        batchTasks.map(async (task) => {
          const { index, cell, start } = task;
          const executeDecode = async (candidateCell: typeof cell) => {
            const candidateStart =
              Number.isInteger(candidateCell.offset) &&
              candidateCell.offset >= offsetFromFooter &&
              candidateCell.offset + candidateCell.compressed_length <= sourceFile.size - HDA_FOOTER_SIZE
                ? candidateCell.offset
                : start;
            const cellBlob = sourceFile.slice(
              candidateStart,
              candidateStart + candidateCell.compressed_length,
            );
            const sourceBuffer = await cellBlob.arrayBuffer();
            return workerPool.run(
              {
                type: 'decode-cell',
                buffer: sourceBuffer,
                compression: candidateCell.compression ?? spine.compression,
                password: accessPassword,
                isEncrypted,
                checksum: candidateCell.checksum,
                expectedLength: candidateCell.length,
                kdf: spine.kdf,
              },
              [sourceBuffer],
            );
          };

          try {
            const result = await executeDecode(cell);
            return { index, buffer: result.buffer, checksum: result.checksum };
          } catch (error) {
            const parityId = spine.cells.find((candidate) => candidate.parityFor === cell.id)?.id;
            const parity = parityId ? cellIndexById.get(parityId)?.cell : undefined;
            if (parity) {
              const result = await executeDecode(parity);
              return { index, buffer: result.buffer, checksum: result.checksum };
            }
            throw error;
          }
        }),
      );

      for (const result of batchResults) {
      if (options.verifyOnly) {
        finished++;
        processedBytes += tasks[result.index].cell.length;
      } else if (writable) {
        await writable.write(result.buffer);
        finished++;
        processedBytes += tasks[result.index].cell.length;
      } else {
        blobParts[result.index] = new Blob([result.buffer]);
        finished++;
        processedBytes += tasks[result.index].cell.length;
      }
      await setCheckpoint({
          operationId,
          resumeKey,
          mode: 'DECODE',
          fileName: file.name,
          fileSize: file.size,
          fileLastModified: file.lastModified,
          passwordHashHint: accessPassword ? `${accessPassword.length}:${accessPassword.charCodeAt(0)}` : null,
          updatedAt: Date.now(),
          processedBytes,
          totalBytes: metadata.size,
          nextCellIndex: finished,
          tuning,
          headerSize: offsetFromFooter,
          spine,
          blobParts: writable ? undefined : [...blobParts],
          fileHandle: handle,
          sourceFileHandle: options.sourceFileHandle ?? checkpoint?.sourceFileHandle ?? null,
        });

        emitProgress({
          percentage: Math.round((finished / Math.max(totalPrimaryCells, 1)) * 100),
          stage: 'processing',
          status: `Processing ${finished}/${totalPrimaryCells}`,
          logs: [...logs, `[VERIFY] Cell ${result.index} Hash: ${result.checksum} OK`],
        });
      }
    }

    if (writable) {
      await writable.close();
      writeClosed = true;
      logger.info('File written to disk via File System Access API');
    }

    const finalBlob = options.verifyOnly
      ? new Blob()
      : useFallback
      ? new Blob(blobParts, { type: metadata.type })
      : new Blob();

    if (!options.verifyOnly && useFallback && finalBlob.size === 0 && metadata.size > 0) {
      if (window.self !== window.top) {
        logger.error('Memory limit exceeded in iframe context');
        throw new Error(
          'Memory limit exceeded. Please open the app in a new tab to enable direct-to-disk streaming.',
        );
      } else {
        logger.error('Browser memory limit exceeded, direct-to-disk streaming not available');
        throw new Error(
          'Browser memory limit exceeded. Your browser cannot hold this file in memory, and does not support direct-to-disk streaming (or permission was denied). Try using Chrome or Edge.',
        );
      }
    }

    logger.info('Decoding complete', { metadata });
    await clearCheckpoint(resumeKey);
    workerPool.terminate('Operation completed.');
    return {
      blob: finalBlob,
      metadata,
    };
  } catch (error) {
    if (error instanceof Error) {
      if (/Invalid password|Decryption failed/i.test(error.message)) {
        logSecurityEvent({ code: 'wrong_password', message: 'Wrong password or corrupted encrypted archive detected.', data: { fileName: file.name } });
      } else if (/Integrity Breach|checksum mismatch|corrupted/i.test(error.message)) {
        logSecurityEvent({ code: 'archive_corruption_detected', message: 'Integrity verification failed during decode.', data: { fileName: file.name } });
      } else if (/permission/i.test(error.message)) {
        logSecurityEvent({ code: 'file_permission_denied', message: 'Output file permission denied during decode.', data: { fileName: file.name } });
      }
    }
    workerPool.terminate(
      error instanceof DOMException && error.name === 'AbortError'
        ? 'Operation cancelled.'
        : 'Operation failed.',
    );
    if (writable && !writeClosed) {
      try {
        if (error instanceof DOMException && error.name === 'AbortError') {
          await writable.close();
          writeClosed = true;
        } else {
          await writable.abort();
        }
      } catch {
        // Ignore cleanup failures.
      }
    }
    throw error;
  }
};
