import {
  EncoderResult,
  HDACell,
  HDACompression,
  HDASpine,
  OperationControlOptions,
  ProgressCallback,
  EncodeResumeCheckpoint,
  ProcessingProgress,
  HDAKdf,
} from '../types';
import { createLogger } from '../lib/logger';
import { HDA_CONFIG } from '../config/hda';
import { validateFile, validatePassword, sanitizeForHTML } from '../lib/validators';
import {
  HDA_FOOTER_SIZE,
  assertMemoryFallbackSupported,
  createRedundancyManifest,
  createOperationId,
  createResumeKey,
  createSplitManifest,
  estimateHeaderReserve,
  escapeJSONForHTMLScript,
  getAdaptiveTuning,
  getFullHashHex,
  getProtocolCompatibility,
  shouldEnableRedundancy,
  signManifestFields,
} from '../lib/hdaProtocol';
import { WorkerPool } from './workerPool';
import { clearCheckpoint, getCheckpoint, setCheckpoint } from './resumeStore';
import { logSecurityEvent } from '../lib/securityEvents';
import { selectKdf, wrapSharedPasswordForRecipient } from './cryptoService';

const logger = createLogger('hdaEncoder');

// Protocol constants - must match decoder and embedded HTML decoder script
const MAGIC_HDA = HDA_CONFIG.MAGIC_NUMBER;
const VERSION = HDA_CONFIG.PROTOCOL_VERSION;

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

function createSharedSecret(): string {
  const runtimeCrypto = globalThis.crypto as Crypto | undefined;
  if (runtimeCrypto && 'randomUUID' in runtimeCrypto && typeof runtimeCrypto.randomUUID === 'function') {
    return `${runtimeCrypto.randomUUID()}:${Date.now().toString(36)}`;
  }

  const bytes = runtimeCrypto?.getRandomValues(new Uint8Array(16)) ?? new Uint8Array([Date.now() % 255]);
  return `${Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('')}:${Date.now().toString(36)}`;
}

function buildSplitVolumes(
  archiveBlob: Blob,
  split: NonNullable<HDASpine['split']>,
): EncoderResult['volumes'] {
  if (!split.enabled) {
    return undefined;
  }

  return split.volumes.map((volume) => {
    const start = volume.index * split.volumeSize;
    const end = Math.min(archiveBlob.size, start + split.volumeSize);
    return {
      index: volume.index,
      total: split.volumeCount,
      name: volume.name,
      blob: archiveBlob.slice(start, end, 'application/octet-stream'),
      role: volume.includesManifest ? 'manifest' : 'data',
    };
  });
}

/**
 * HDA Encoder - Honeycomb Document Architecture
 * Protocol Version: 3.0-ELITE
 * Features:
 * - SHA-256 Cellular Verification
 * - Multi-Cell Parallelism (Auto-scaling)
 * - Forge Terminal UI
 * - File System Access API (Stream to Disk)
 */

export const generateHDA = async (
  file: File,
  password: string | null,
  onProgress: ProgressCallback,
  options: OperationControlOptions = {},
): Promise<EncoderResult | null> => {
  logger.info('Starting HDA encoding', { filename: file.name, size: file.size, encrypted: !!password });

  const validatedFile = validateFile(file);
  const validatedPassword = options.integrityOnly ? null : validatePassword(password);
  const tuning = getAdaptiveTuning(validatedFile);
  const resumeKey = options.resumeKey ?? createResumeKey(file, 'ENCODE');
  const existingCheckpoint = await getCheckpoint<EncodeResumeCheckpoint>(resumeKey);
  const checkpoint =
    existingCheckpoint &&
    existingCheckpoint.fileName === file.name &&
    existingCheckpoint.fileSize === file.size &&
    existingCheckpoint.fileLastModified === file.lastModified
      ? existingCheckpoint
      : null;
  const operationId = checkpoint?.operationId ?? createOperationId('enc');
  const isResumed = !!checkpoint;

  let handle: FileSystemFileHandle | null = null;
  let useFallback = false;
  let createdHandle = false;

  if (checkpoint?.fileHandle) {
    if (await ensureHandlePermission(checkpoint.fileHandle)) {
      handle = checkpoint.fileHandle;
      useFallback = false;
    } else {
      useFallback = true;
    }
  } else if ('showSaveFilePicker' in window) {
    try {
      handle = await (window as any).showSaveFilePicker({
        suggestedName: `${validatedFile.name}.hda.html`,
        types: [{
          description: 'HDA Vault',
          accept: { 'text/html': ['.html'] },
        }],
      });
      createdHandle = true;
      logger.debug('File handle acquired via File System Access API');
    } catch (err: unknown) {
      const error = err as Error;
      if (error.name === 'AbortError') {
        logger.info('User cancelled file picker');
        return null;
      }
      logger.warn("showSaveFilePicker failed, falling back to memory blob", { error: error.message });
      useFallback = true;
    }
  } else {
    logger.info('File System Access API not available, using memory fallback');
    useFallback = true;
  }

  const writable = handle
    ? await handle.createWritable(isResumed ? { keepExistingData: true } : undefined)
    : null;
  const blobParts: Blob[] = checkpoint?.blobParts ? [...checkpoint.blobParts] : [];
  const recipientInputs = [
    ...(validatedPassword && (options.recipients ?? []).length > 0
      ? [{ label: 'primary', password: validatedPassword, preferredKdf: options.preferredKdf }]
      : []),
    ...((options.recipients ?? []).filter((recipient) => recipient.password.trim().length > 0)),
  ];
  const sharedPassword =
    recipientInputs.length > 0
      ? createSharedSecret()
      : validatedPassword;
  const isEncrypted = !!sharedPassword;
  const estimatedCellCount = Math.max(1, Math.ceil(file.size / tuning.cellSize));
  const headerSize =
    checkpoint?.headerSize ??
    estimateHeaderReserve({
      fileName: validatedFile.name,
      fileType: validatedFile.type,
      fileSize: file.size,
      cellCount: estimatedCellCount,
      encrypted: isEncrypted,
      metadataBytes:
        (options.archiveComment?.length ?? 0) +
        (options.passwordHint?.length ?? 0) +
        (options.archiveTags ?? []).join(',').length,
      recipientCount: recipientInputs.length,
      folderEntryCount: options.folderMetadata?.entries.length ?? 0,
    });
  const cells: HDACell[] = checkpoint?.cells ? [...checkpoint.cells] : [];
  const logs: string[] = [`[INIT] Protocol ${HDA_CONFIG.DISPLAY_VERSION} Engage`, `[FILE] ${validatedFile.name}`];
  const compressionMode = checkpoint?.tuning.compression ?? tuning.compression;
  const workerCount = checkpoint?.tuning.workerCount ?? tuning.workerCount;
  const cellSize = checkpoint?.tuning.cellSize ?? tuning.cellSize;
  const useRedundancy = shouldEnableRedundancy(file.size);
  const parityCellIds: string[] = [];

  if (!writable) {
    assertMemoryFallbackSupported(file.size);
  }

  let currentOffset = checkpoint?.currentOffset ?? headerSize;
  let totalProcessed = checkpoint?.processedBytes ?? 0;
  let writeClosed = false;
  let archiveKdf: HDAKdf | null = checkpoint?.cells.length ? null : null;
  const startedAt = performance.now();
  const workerPool = new WorkerPool<
    {
      type: 'encode-cell';
      buffer: ArrayBuffer;
      compression: HDACompression;
      password: string | null;
      kdf?: HDAKdf | null;
    },
    { type: 'encode-cell'; buffer: ArrayBuffer; checksum: string; compression: HDACompression; sourceHash: string; kdf: HDAKdf | null }
  >(workerCount, () => new Worker(new URL('./hdaWorker.ts', import.meta.url), { type: 'module' }));

  const emitProgress = (progress: ProcessingProgress) => {
    const elapsedSeconds = Math.max((performance.now() - startedAt) / 1000, 0.001);
    const throughputBytesPerSecond = totalProcessed / elapsedSeconds;
    const remainingBytes = Math.max(file.size - totalProcessed, 0);
    const etaSeconds =
      throughputBytesPerSecond > 0 ? remainingBytes / throughputBytesPerSecond : null;

    onProgress({
      ...progress,
      totalBytes: file.size,
      processedBytes: totalProcessed,
      currentCell: cells.length,
      totalCells: Math.max(cells.length, Math.ceil(file.size / cellSize)),
      throughputBytesPerSecond,
      etaSeconds,
      mode: writable ? 'disk' : 'memory',
      cellSize,
      workerCount,
      operationId,
      isResumable: true,
      resumed: isResumed,
    });
  };

  try {
    if (options.signal?.aborted) {
      throw new DOMException('Operation cancelled.', 'AbortError');
    }

    if (sharedPassword && !archiveKdf) {
      archiveKdf = await selectKdf(options.preferredKdf ?? 'PBKDF2-SHA256');
    }

    emitProgress({
      percentage: Math.round((totalProcessed / Math.max(file.size, 1)) * 100),
      stage: 'initializing',
      status: isResumed ? 'Resuming operation...' : 'Allocating space...',
      logs: [...logs, isResumed ? '[SYS] Resume checkpoint detected.' : '[SYS] Requesting disk allocation...'],
    });

    // 1. Reserve exact header space for the HTML wrapper
    if (!isResumed) {
      const placeholder = new Uint8Array(headerSize);
      placeholder.fill(32); // Fill with spaces
      if (writable) {
        await writable.write(placeholder);
      } else {
        blobParts.push(new Blob([placeholder]));
      }
    }

    if (writable && isResumed) {
      await writable.seek(currentOffset);
    }

    await setCheckpoint({
      operationId,
      resumeKey,
      mode: 'ENCODE',
      fileName: file.name,
      fileSize: file.size,
      fileLastModified: file.lastModified,
      passwordHashHint: sharedPassword ? `${sharedPassword.length}:${sharedPassword.charCodeAt(0)}` : null,
      updatedAt: Date.now(),
      processedBytes: totalProcessed,
      totalBytes: file.size,
      nextCellIndex: cells.length,
      tuning: { cellSize, workerCount, compression: compressionMode },
      headerSize,
      cells,
      blobParts: writable ? undefined : blobParts,
      currentOffset,
      isEncrypted,
      fileHandle: handle,
      sourceFileHandle: options.sourceFileHandle ?? checkpoint?.sourceFileHandle ?? null,
    });

    // 2. Process the file in chunks
    while (totalProcessed < file.size) {
      if (options.signal?.aborted) {
        throw new DOMException('Operation cancelled.', 'AbortError');
      }

      const chunk = file.slice(totalProcessed, totalProcessed + cellSize);
      emitProgress({
        percentage: Math.round((totalProcessed / file.size) * 95),
        stage: 'preparing',
        status: `Preparing Cell ${cells.length + 1}...`,
        logs: [...logs, `[CELL] ${cells.length + 1}: dispatching to ${workerCount} worker${workerCount === 1 ? '' : 's'}...`],
      });

      const cellId = `C${cells.length.toString().padStart(3, '0')}`;
      const cellBuffer = await chunk.arrayBuffer();

      const workerResult = await workerPool.run(
        {
          type: 'encode-cell',
          buffer: cellBuffer,
          compression: compressionMode,
          password: sharedPassword,
          kdf: archiveKdf,
        },
        [cellBuffer],
      );
      const cellData = new Uint8Array(workerResult.buffer);
      const checksum = workerResult.checksum;
      const actualCompression = workerResult.compression;
      archiveKdf = archiveKdf ?? workerResult.kdf;

      cells.push({
        id: cellId,
        type: 'binary',
        offset: currentOffset,
        length: chunk.size,
        compressed_length: cellData.length,
        checksum,
        compression: actualCompression,
        sourceHash: workerResult.sourceHash,
      });

      if (writable) {
        await writable.write(cellData);
      } else {
        blobParts.push(new Blob([cellData]));
      }

      currentOffset += cellData.length;
      totalProcessed += chunk.size;

      if (useRedundancy) {
        const parityId = `P${parityCellIds.length.toString().padStart(3, '0')}`;
        const parityData = new Uint8Array(cellData);
        cells.push({
          id: parityId,
          type: 'binary',
          offset: currentOffset,
          length: chunk.size,
          compressed_length: parityData.length,
          checksum,
          compression: actualCompression,
          isParity: true,
          parityFor: cellId,
          sourceHash: workerResult.sourceHash,
        });
        parityCellIds.push(parityId);

        if (writable) {
          await writable.write(parityData);
        } else {
          blobParts.push(new Blob([parityData]));
        }
        currentOffset += parityData.length;
      }

      logs.push(`[FORGE] ${cellId}: ${checksum} OK`);
      if (logs.length > HDA_CONFIG.MAX_LOG_ENTRIES) logs.shift();

      await setCheckpoint({
        operationId,
        resumeKey,
        mode: 'ENCODE',
        fileName: file.name,
        fileSize: file.size,
        fileLastModified: file.lastModified,
        passwordHashHint: sharedPassword ? `${sharedPassword.length}:${sharedPassword.charCodeAt(0)}` : null,
        updatedAt: Date.now(),
        processedBytes: totalProcessed,
        totalBytes: file.size,
        nextCellIndex: cells.length,
        tuning: { cellSize, workerCount, compression: compressionMode },
        headerSize,
        cells: [...cells],
        blobParts: writable ? undefined : [...blobParts],
        currentOffset,
        isEncrypted,
        fileHandle: handle,
        sourceFileHandle: options.sourceFileHandle ?? checkpoint?.sourceFileHandle ?? null,
      });

      emitProgress({
        percentage: Math.round((totalProcessed / file.size) * 95),
        stage: 'processing',
        status: `Forging Cell ${cells.length}...`,
        logs: [...logs],
      });
    }

    // 3. Write Footer
    emitProgress({
      percentage: 95,
      stage: 'finalizing',
      status: 'Writing footer...',
      logs: [...logs, '[SYS] Finalizing binary layout...'],
    });
    const footerBuffer = new ArrayBuffer(HDA_FOOTER_SIZE);
    const footerView = new DataView(footerBuffer);
    footerView.setBigUint64(0, BigInt(headerSize), true);
    footerView.setUint32(8, MAGIC_HDA, true);
    footerView.setUint32(12, VERSION, true);
    if (writable) {
      await writable.write(footerBuffer);
    } else {
      blobParts.push(new Blob([footerBuffer]));
    }

    // 4. Generate HTML and Spine
    emitProgress({
      percentage: 98,
      stage: 'finalizing',
      status: 'Injecting Spine...',
      logs: [...logs, '[SYS] Rewriting HTML header...'],
    });
    const compatibility = getProtocolCompatibility();
    const sourceHash = await getFullHashHex(
      cells
        .filter((cell) => !cell.isParity)
        .map((cell) => cell.sourceHash ?? '')
        .join('|'),
    );
    const splitManifest = createSplitManifest(cells, validatedFile.name, headerSize);
    const recipients =
      recipientInputs.length > 0
        ? await Promise.all(
            recipientInputs.map((recipient) =>
              wrapSharedPasswordForRecipient(
                sharedPassword!,
                recipient.password,
                recipient.label,
                recipient.preferredKdf,
              ),
            ),
          )
        : null;
    const unsignedManifest = {
      version: HDA_CONFIG.PROTOCOL_VERSION,
      total_bytes: file.size,
      cell_count: cells.length,
      compression:
        new Set(cells.map((cell) => cell.compression ?? compressionMode)).size === 1
          ? (cells[0]?.compression ?? compressionMode)
          : 'none',
      encryption: isEncrypted ? 'aes-256-gcm' as const : null,
      cells,
      filename: validatedFile.name,
      mimeType: validatedFile.type || 'application/octet-stream',
      comment: options.archiveComment ?? '',
      passwordHint: options.passwordHint ?? undefined,
      creatorApp: `hda-vault/${HDA_CONFIG.DISPLAY_VERSION}`,
      createdAt: new Date().toISOString(),
      sourceHash,
      tags: Array.from(
        new Set([
          validatedFile.name.split('.').pop()?.toLowerCase(),
          ...(options.archiveTags ?? []),
        ].filter(Boolean)),
      ) as string[],
      integrityOnly: !!options.integrityOnly,
      folderManifest: options.folderMetadata ?? null,
      recipients,
      compatibility,
      kdf: archiveKdf,
      redundancy: createRedundancyManifest(parityCellIds),
      split: splitManifest,
    };
    const signature = await signManifestFields(JSON.stringify(unsignedManifest));
    const spine: HDASpine = {
      ...unsignedManifest,
      signature,
    };

    const primaryColor = isEncrypted ? '#f59e0b' : '#6366f1';

    // XSS-safe: sanitize all user-provided values before HTML embedding
    const safeFilename = sanitizeForHTML(validatedFile.name);

    const htmlHeader = `<!DOCTYPE html>
<!--
  HDA Forge | Hive Data Architecture
  Created by Raj Mitra
  Copyright (c) 2026 Raj Mitra. All rights reserved.
  License: PolyForm Noncommercial 1.0.0
  Commercial use requires explicit permission or a commercial license.
-->
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="author" content="Raj Mitra">
    <title>HDA Forge | ${safeFilename}</title>
    <style>
        body { background: #020617; color: #f8fafc; font-family: ui-sans-serif, system-ui, sans-serif; height: 100vh; display: flex; align-items: center; justify-content: center; overflow: hidden; margin: 0; }
        .glass { background: rgba(10, 15, 30, 0.95); backdrop-filter: blur(40px); border: 1px solid rgba(255,255,255,0.08); width: 100%; max-width: 480px; padding: 40px; border-radius: 48px; position: relative; z-index: 10; box-shadow: 0 50px 100px -20px rgba(0,0,0,0.9); border-top: 10px solid ${primaryColor}; }
        .honeycomb { background-image: radial-gradient(${primaryColor}22 1px, transparent 0); background-size: 30px 30px; position: fixed; inset: 0; z-index: 0; }
        .btn-primary { background: ${primaryColor}; color: #000; font-weight: 900; letter-spacing: 0.1em; transition: all 0.3s; box-shadow: 0 10px 30px -5px ${primaryColor}66; border: none; cursor: pointer; }
        .btn-primary:hover:not(:disabled) { filter: brightness(1.2); transform: translateY(-2px); scale: 1.02; }
        .progress-bar { height: 100%; background: ${primaryColor}; width: 0%; transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1); box-shadow: 0 0 20px ${primaryColor}aa; border-radius: 9999px; }
        .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
        .terminal { background: #000000; border-radius: 16px; padding: 12px; font-size: 9px; line-height: 1.4; color: ${primaryColor}; opacity: 0.8; height: 80px; overflow-y: hidden; border: 1px solid ${primaryColor}33; }
        .tab-btn { padding: 4px 12px; font-size: 10px; font-weight: bold; border-radius: 6px; cursor: pointer; transition: all 0.2s; text-transform: uppercase; letter-spacing: -0.05em; }
        .tab-active { background: ${primaryColor}33; color: ${primaryColor}; border: 1px solid ${primaryColor}44; }
        .text-center { text-align: center; }
        .space-y-6 > * + * { margin-top: 1.5rem; }
        .space-y-4 > * + * { margin-top: 1rem; }
        .space-y-3 > * + * { margin-top: 0.75rem; }
        .space-y-2 > * + * { margin-top: 0.5rem; }
        .flex { display: flex; }
        .justify-between { justify-content: space-between; }
        .items-center { align-items: center; }
        .justify-center { justify-content: center; }
        .px-2 { padding-left: 0.5rem; padding-right: 0.5rem; }
        .gap-2 { gap: 0.5rem; }
        .gap-3 { gap: 0.75rem; }
        .uppercase { text-transform: uppercase; }
        .tracking-tighter { letter-spacing: -0.05em; }
        .tracking-widest { letter-spacing: 0.1em; }
        .opacity-50 { opacity: 0.5; }
        .text-9px { font-size: 9px; }
        .text-10px { font-size: 10px; }
        .text-11px { font-size: 11px; }
        .text-xs { font-size: 0.75rem; line-height: 1rem; }
        .text-sm { font-size: 0.875rem; line-height: 1.25rem; }
        .text-xl { font-size: 1.25rem; line-height: 1.75rem; }
        .text-2xl { font-size: 1.5rem; line-height: 2rem; }
        .text-slate-500 { color: #64748b; }
        .text-slate-600 { color: #475569; }
        .text-slate-400 { color: #94a3b8; }
        .text-slate-200 { color: #e2e8f0; }
        .text-emerald-400 { color: #34d399; }
        .text-amber-400 { color: #fbbf24; }
        .text-indigo-400 { color: #818cf8; }
        .text-white { color: #ffffff; }
        .bg-slate-900 { background-color: #0f172a; }
        .bg-slate-950 { background-color: #020617; }
        .bg-amber-500-10 { background-color: rgba(245, 158, 11, 0.1); }
        .w-14 { width: 3.5rem; }
        .h-14 { height: 3.5rem; }
        .w-full { width: 100%; }
        .h-2 { height: 0.5rem; }
        .rounded-2xl { border-radius: 1rem; }
        .rounded-3xl { border-radius: 1.5rem; }
        .rounded-xl { border-radius: 0.75rem; }
        .rounded-full { border-radius: 9999px; }
        .mx-auto { margin-left: auto; margin-right: auto; }
        .border { border-width: 1px; border-style: solid; }
        .border-2 { border-width: 2px; border-style: solid; }
        .border-b { border-bottom-width: 1px; border-bottom-style: solid; }
        .border-slate-800 { border-color: #1e293b; }
        .border-slate-900 { border-color: #0f172a; }
        .border-slate-700 { border-color: #334155; }
        .border-amber-500-30 { border-color: rgba(245, 158, 11, 0.3); }
        .shadow-inner { box-shadow: inset 0 2px 4px 0 rgba(0, 0, 0, 0.06); }
        .shadow-xl { box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04); }
        .font-black { font-weight: 900; }
        .font-bold { font-weight: 700; }
        .p-6 { padding: 1.5rem; }
        .p-4 { padding: 1rem; }
        .py-4 { padding-top: 1rem; padding-bottom: 1rem; }
        .px-4 { padding-left: 1rem; padding-right: 1rem; }
        .py-5 { padding-top: 1.25rem; padding-bottom: 1.25rem; }
        .pb-2 { padding-bottom: 0.5rem; }
        .pt-2 { padding-top: 0.5rem; }
        .text-left { text-align: left; }
        .break-all { word-break: break-all; }
        .leading-snug { line-height: 1.375; }
        .leading-tight { line-height: 1.25; }
        .overflow-hidden { overflow: hidden; }
        .mt-2 { margin-top: 0.5rem; }
        .mt-1 { margin-top: 0.25rem; }
        .italic { font-style: italic; }
        .hidden { display: none; }
        .transition-all { transition-property: all; transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1); transition-duration: 150ms; }
        input:focus { outline: 2px solid transparent; outline-offset: 2px; border-color: ${isEncrypted ? '#f59e0b' : '#6366f1'}; }
        .hover-bg-slate-800:hover { background-color: #1e293b; cursor: pointer; }
    </style>
</head>
<body class="honeycomb">
    <div class="glass shadow-2xl">
        <div class="text-center space-y-6">
            <div class="flex justify-between items-center px-2">
                <div class="flex gap-2">
                   <div id="tab-unpack" class="tab-btn tab-active uppercase tracking-tighter">Unpack</div>
                   <div id="tab-pass" class="tab-btn uppercase tracking-tighter opacity-50">Passport</div>
                </div>
                <div class="text-9px mono text-slate-500 uppercase tracking-widest">Protocol v4.0</div>
            </div>

            <div id="view-unpack" class="space-y-6">
                <div class="space-y-2">
                    <div class="bg-slate-900 w-14 h-14 rounded-2xl mx-auto flex items-center justify-center border border-slate-800 shadow-inner">
                        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="${primaryColor}" stroke-width="2.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/></svg>
                    </div>
                    <h1 class="text-2xl font-black tracking-tighter uppercase" style="margin:0;">HDA <span style="color: ${primaryColor}">FORGE</span></h1>
                </div>
                
                <div class="bg-slate-950 p-6 rounded-3xl border border-slate-900 text-left space-y-3 shadow-inner">
                    <div class="text-sm font-bold text-slate-200 break-all leading-snug">${safeFilename}</div>
                    <div class="flex justify-between items-center text-11px mono text-slate-500">
                        <span>${(file.size / (1024 * 1024)).toFixed(2)} MB</span>
                        <span class="text-indigo-400 font-bold">${spine.cell_count} CELLS</span>
                    </div>
                    <div class="h-2 w-full bg-slate-900 rounded-full overflow-hidden mt-2">
                        <div id="p-bar" class="progress-bar"></div>
                    </div>
                    <div id="status" class="text-9px mono text-slate-600 uppercase tracking-widest text-center mt-1 italic">Hive Synchronized</div>
                </div>

                <div id="terminal" class="terminal mono text-left">
                   <div>[INIT] Forge Terminal v4.0 Ready...</div>
                   <div>[SCAN] ${spine.cell_count} Cells Detected...</div>
                </div>

                <div id="ui-mount" class="space-y-4">
                    ${isEncrypted ? '<input type="password" id="hda-key" placeholder="Cell Master Key" class="w-full bg-slate-950 border-2 border-slate-800 rounded-2xl py-4 px-4 text-center text-white font-bold text-xl shadow-inner transition-all" style="box-sizing: border-box;">' : ''}
                    
                    <div id="manual-tether" class="hidden space-y-3">
                        <div class="bg-amber-500-10 border border-amber-500-30 p-4 rounded-2xl text-left">
                            <p class="text-10px text-amber-400 font-bold uppercase tracking-widest" style="margin:0 0 4px 0;">TETHER REQUIRED</p>
                            <p class="text-11px text-slate-400 leading-tight" style="margin:0;">Local security policy (file://) blocked the auto-stream. Re-select the hive to establish link.</p>
                        </div>
                        <input type="file" id="hda-file" class="hidden">
                        <button id="tether-btn" class="w-full py-4 rounded-xl border-2 border-slate-700 text-slate-200 font-bold text-xs uppercase hover-bg-slate-800 transition-all flex items-center justify-center gap-2" style="background: transparent;">
                            SELECT SOURCE FILE
                        </button>
                    </div>

                    <button id="extract-btn" class="w-full py-5 rounded-2xl btn-primary uppercase shadow-xl flex items-center justify-center gap-3 font-black tracking-widest text-sm">
                        Forge Payload
                    </button>
                </div>
            </div>

            <div id="view-passport" class="hidden space-y-4 text-left">
                <div class="bg-slate-950 p-6 rounded-3xl border border-slate-800 mono text-10px space-y-4">
                    <div class="flex justify-between border-b border-slate-900 pb-2"><span class="text-slate-500">SIGNATURE</span> <span>${spine.signature ? 'SIGNED' : 'UNSIGNED'}</span></div>
                    <div class="flex justify-between border-b border-slate-900 pb-2"><span class="text-slate-500">CHUNKS</span> <span>${spine.cell_count} Cells (${(cellSize / 1024 / 1024).toFixed(0)}MB)</span></div>
                    <div class="flex justify-between border-b border-slate-900 pb-2"><span class="text-slate-500">ENCRYPTION</span> <span>${spine.encryption || 'NONE'}</span></div>
                    <div class="flex justify-between border-b border-slate-900 pb-2"><span class="text-slate-500">KDF</span> <span>${spine.kdf?.algorithm ?? 'PBKDF2-SHA256'}</span></div>
                    <div class="flex justify-between border-b border-slate-900 pb-2"><span class="text-slate-500">INTEGRITY</span> <span>SHA-256 CHECKED</span></div>
                    <div class="flex justify-between border-b border-slate-900 pb-2"><span class="text-slate-500">VERSION</span> <span>STABLE 4.0.0</span></div>
                    <div class="flex justify-between border-b border-slate-900 pb-2"><span class="text-slate-500">CREATED</span> <span>${spine.createdAt ?? 'UNKNOWN'}</span></div>
                    <div class="flex justify-between border-b border-slate-900 pb-2"><span class="text-slate-500">SOURCE HASH</span> <span>${spine.sourceHash ?? 'N/A'}</span></div>
                    <div class="pt-2 text-slate-600 italic">Self-aware HDA archive container. Requires no external dependencies for reconstruction.</div>
                    <div class="pt-4 mt-4 border-t border-slate-900 text-center">
                        <div class="text-indigo-400 font-bold text-10px uppercase tracking-widest">Created by Raj Mitra</div>
                        <div class="text-slate-500 text-9px mt-1">© 2026 HDA Architecture. Non-commercial use only.</div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <script id="spine-node" type="application/hda-spine">${escapeJSONForHTMLScript(spine)}</script>

    <script>
        const spine = JSON.parse(document.getElementById('spine-node').textContent);
        const term = document.getElementById('terminal');
        const bar = document.getElementById('p-bar');
        const status = document.getElementById('status');

        const log = (msg) => {
            const div = document.createElement('div');
            div.textContent = '> ' + msg;
            term.appendChild(div);
            term.scrollTop = term.scrollHeight;
            if(term.children.length > 50) term.removeChild(term.firstChild);
        };

        // Tabs
        document.getElementById('tab-unpack').onclick = () => {
            document.getElementById('view-unpack').classList.remove('hidden');
            document.getElementById('view-passport').classList.add('hidden');
            document.getElementById('tab-unpack').classList.add('tab-active');
            document.getElementById('tab-pass').classList.remove('tab-active');
            document.getElementById('tab-pass').style.opacity = '0.5';
            document.getElementById('tab-unpack').style.opacity = '1';
        };
        document.getElementById('tab-pass').onclick = () => {
            document.getElementById('view-unpack').classList.add('hidden');
            document.getElementById('view-passport').classList.remove('hidden');
            document.getElementById('tab-pass').classList.add('tab-active');
            document.getElementById('tab-unpack').classList.remove('tab-active');
            document.getElementById('tab-unpack').style.opacity = '0.5';
            document.getElementById('tab-pass').style.opacity = '1';
        };

        const processCells = async (handle) => {
            const btn = document.getElementById('extract-btn');
            const pass = document.getElementById('hda-key')?.value;
            
            try {
                let saveHandle = null;
                let writable = null;
                let useFallback = false;

                if ('showSaveFilePicker' in window) {
                    try {
                        saveHandle = await window.showSaveFilePicker({
                            suggestedName: spine.filename
                        });
                        writable = await saveHandle.createWritable();
                    } catch (e) {
                        if (e.name === 'AbortError') return;
                        console.warn('showSaveFilePicker failed, falling back to memory blob', e);
                        useFallback = true;
                    }
                } else {
                    useFallback = true;
                }

                if (useFallback && spine.total_bytes > ${HDA_CONFIG.MAX_FALLBACK_SIZE} && window.self !== window.top) {
                    throw new Error('Memory limit exceeded. Please open the app in a new tab to enable direct-to-disk streaming.');
                }
                if (useFallback && spine.total_bytes > ${HDA_CONFIG.MAX_FALLBACK_SIZE}) {
                    console.warn('Memory fallback advisory threshold exceeded (${(HDA_CONFIG.MAX_FALLBACK_SIZE / (1024 * 1024 * 1024)).toFixed(1)} GB). Continuing in top-level window.');
                }

                btn.disabled = true;
                btn.style.opacity = '0.5';
                
                const blobParts = useFallback ? new Array(spine.cells.length) : null;

                const footerBlob = handle.slice(-${HDA_FOOTER_SIZE});
                const footer = new DataView(await footerBlob.arrayBuffer());
                const binaryStart = Number(footer.getBigUint64(0, true));
                const magic = footer.getUint32(8, true);
                const version = footer.getUint32(12, true);
                if (magic !== ${MAGIC_HDA}) throw new Error('Invalid HDA footer');
                if (version !== ${VERSION}) throw new Error('Unsupported HDA version: ' + version);

                if (spine.cell_count !== spine.cells.length) {
                    throw new Error('Spine metadata mismatch');
                }
                if (spine.version !== ${VERSION}) {
                    throw new Error('Unsupported HDA spine version: ' + spine.version);
                }

                // PARALLELISM AUTO-OPTIMIZATION
                const cores = navigator.hardwareConcurrency || 2;
                const poolSize = Math.max(1, Math.min(cores - 1, 8)); // Reserve 1 core for UI, max 8
                log('Parallel scaling: ' + poolSize + 'X Threading');

                let nextOffset = binaryStart;
                const cellTasks = spine.cells.filter((cell) => !cell.isParity).map((cell, i) => {
                    const start = Number.isFinite(cell.offset) && cell.offset >= binaryStart ? cell.offset : nextOffset;
                    nextOffset = start + cell.compressed_length;
                    return { index: i, cell, start };
                });

                let finished = 0;
                
                for(let i=0; i < cellTasks.length; i += poolSize) {
                    const batchTasks = cellTasks.slice(i, i + poolSize);
                    
                    const batchResults = await Promise.all(batchTasks.map(async (task) => {
                        const { index, cell, start } = task;
                        const decodeCandidate = async (candidate) => {
                            const candidateStart = candidate.offset ?? start;
                            const cellBlob = handle.slice(candidateStart, candidateStart + candidate.compressed_length);
                            let buffer = await cellBlob.arrayBuffer();

                            if (spine.encryption) {
                                if (spine.recipients?.length) {
                                    throw new Error('This archive uses multi-recipient access. Open it in the HDA app for extraction.');
                                }
                                if (spine.kdf && spine.kdf.algorithm === 'Argon2id') {
                                    throw new Error('This archive uses Argon2id. Open it in the HDA app for extraction.');
                                }
                                const salt = new Uint8Array(buffer.slice(0, 16));
                                const iv = new Uint8Array(buffer.slice(16, 28));
                                const data = buffer.slice(28);
                                const enc = new TextEncoder();
                                const keyMat = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
                                const key = await crypto.subtle.deriveKey(
                                    { name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' },
                                    keyMat, { name: 'AES-GCM', length: 256 }, false, ['decrypt']
                                );
                                buffer = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
                            }

                            const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
                            const actualChecksum = Array.from(new Uint8Array(hashBuffer))
                                .map((b) => b.toString(16).padStart(2, '0'))
                                .join('')
                                .substring(0, ${HDA_CONFIG.CHECKSUM_LENGTH});
                            if (actualChecksum !== candidate.checksum) {
                                throw new Error('Integrity Breach: Cell ' + index + ' checksum mismatch.');
                            }

                            let resBuffer = buffer;
                            const codec = candidate.compression || spine.compression;
                            if (codec !== 'none') {
                                if (!['deflate', 'brotli', 'zstd'].includes(codec)) {
                                    throw new Error('Unsupported codec: ' + codec);
                                }
                                const ds = new DecompressionStream(codec);
                                const dsWriter = ds.writable.getWriter();
                                await dsWriter.write(buffer);
                                await dsWriter.close();
                                
                                const resBlob = await new Response(ds.readable).blob();
                                resBuffer = await resBlob.arrayBuffer();
                            }
                            return { index, buffer: resBuffer, checksum: actualChecksum };
                        };

                        try {
                            return await decodeCandidate(cell);
                        } catch (error) {
                            const parity = spine.cells.find((candidate) => candidate.parityFor === cell.id);
                            if (parity) {
                                return await decodeCandidate(parity);
                            }
                            throw error;
                        }
                    }));

                    for (const res of batchResults) {
                        if (writable) {
                            await writable.write(res.buffer);
                        } else {
                            blobParts[res.index] = new Blob([res.buffer]);
                        }
                        finished++;
                        status.textContent = 'RESTORE ' + finished + '/' + spine.cell_count;
                        bar.style.width = (finished / spine.cell_count * 100) + '%';
                        log('Cell ' + res.index + ' verified OK [' + res.checksum + ']');
                    }
                }

                log('All cells valid. Finalizing payload...');
                if (writable) {
                    await writable.close();
                }

                if (useFallback) {
                    const finalBlob = new Blob(blobParts, { type: spine.mimeType || "application/octet-stream" });
                    const url = URL.createObjectURL(finalBlob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = spine.filename;
                    a.click();
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                }
                
                status.textContent = 'RESTORE COMPLETE';
                btn.textContent = 'COMPLETED';
                btn.style.background = '#10b981';
                btn.style.color = '#fff';
            } catch (e) {
                console.error(e);
                status.textContent = 'FORGE FAIL';
                log('ERROR: ' + e.message);
                btn.disabled = false;
                btn.style.opacity = '1';
                btn.textContent = 'RETRY';
            }
        };

        const triggerTether = () => {
            document.getElementById('manual-tether').classList.remove('hidden');
            document.getElementById('extract-btn').classList.add('hidden');
            status.textContent = 'RESTRICTED';
            log('[SECURITY] file:// protocol isolated.');
        };

        document.getElementById('tether-btn').onclick = () => document.getElementById('hda-file').click();
        document.getElementById('hda-file').onchange = (e) => {
            if (e.target.files[0]) {
                document.getElementById('manual-tether').classList.add('hidden');
                document.getElementById('extract-btn').classList.remove('hidden');
                processCells(e.target.files[0]);
            }
        };

        document.getElementById('extract-btn').onclick = async () => {
            if (window.location.protocol.startsWith('file')) return triggerTether();
            
            status.textContent = 'STREAMING...';
            log('[NET] Fetching binary tail...');
            try {
                const response = await fetch(window.location.href);
                if (!response.ok) throw new Error();
                processCells(await response.blob());
            } catch (e) {
                triggerTether();
            }
        };
    </script>
    <script>window.stop();</script>
</body>
</html>`;

    const htmlEncoder = new TextEncoder();
    const htmlBytes = htmlEncoder.encode(htmlHeader);

    if (htmlBytes.byteLength > headerSize) {
        if (writable) {
          await writable.close();
          writeClosed = true;
        }
        throw new Error(`Metadata too large for allocated header space (${headerSize} bytes).`);
    }

    // Pad the HTML to exactly headerSize
    const paddedHtml = new Uint8Array(headerSize);
    paddedHtml.fill(32); // fill with spaces
    paddedHtml.set(htmlBytes, 0);

    if (writable) {
      // Seek back to 0 and overwrite
      await writable.seek(0);
      await writable.write(paddedHtml);
      await writable.close();
      writeClosed = true;
    } else {
      blobParts[0] = new Blob([paddedHtml]);
    }

    emitProgress({
      percentage: 100,
      stage: 'complete',
      status: 'Seal Complete.',
      logs: [...logs, '[SEAL] Hive Locked.'],
    });

    const finalBlob = useFallback ? new Blob(blobParts) : new Blob();
    if (useFallback && finalBlob.size === 0 && file.size > 0) {
      if (window.self !== window.top) {
        throw new Error("Memory limit exceeded. Please open the app in a new tab to enable direct-to-disk streaming.");
      } else {
        throw new Error("Browser memory limit exceeded. Your browser cannot hold this file in memory, and does not support direct-to-disk streaming (or permission was denied). Try using Chrome or Edge.");
      }
    }

    await clearCheckpoint(resumeKey);
      workerPool.terminate('Operation completed.');
    const volumes = useFallback && splitManifest?.enabled
      ? buildSplitVolumes(finalBlob, splitManifest)
      : undefined;
    return {
      blob: volumes?.[0]?.blob ?? finalBlob,
      useFallback,
      name: file.name,
      type: "text/html",
      size: currentOffset + HDA_FOOTER_SIZE,
      timestamp: Date.now(),
      isEncrypted,
      volumes,
      protocolVersion: HDA_CONFIG.PROTOCOL_VERSION,
    };
  } catch (error) {
    if (error instanceof Error && /permission/i.test(error.message)) {
      logSecurityEvent({
        code: 'file_permission_denied',
        message: 'Output file handle permission denied during encode.',
        data: { fileName: file.name },
      });
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
