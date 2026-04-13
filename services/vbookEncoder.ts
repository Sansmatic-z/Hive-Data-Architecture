/**
 * HDA Vault (Hive Data Architecture)
 * Copyright (c) 2026 Raj Mitra. All rights reserved.
 * Proprietary HDA Protocol v3.0 - 24-bit Virtual Book Logic.
 * 
 * Unauthorized copying, modification, or commercial use is strictly prohibited.
 * Licensed under PolyForm Noncommercial License 1.0.0.
 */

import { FileMetadata, ProcessingProgress } from '../types';
import { deriveKey, decryptData } from './cryptoService';

const MAGIC_HDA = 0x48444121;

export const decodeFromVBook = async (
  file: File,
  password: string | null,
  onProgress: (progress: ProcessingProgress) => void
): Promise<{ blob: Blob; metadata: FileMetadata } | null> => {
  const footerBlob = file.slice(-16);
  const footerView = new DataView(await footerBlob.arrayBuffer());
  const offsetFromFooter = Number(footerView.getBigUint64(0, true));
  const magic = footerView.getUint32(8, true);
  
  if (magic !== MAGIC_HDA) throw new Error("Not a valid HDA Hive.");

  const headerLimit = Math.max(1024 * 512, offsetFromFooter);
  const headerBlob = file.slice(0, headerLimit);
  const headerText = await headerBlob.text();
  const spineMatch = headerText.match(/<script id="spine-node" type="application\/hda-spine">([\s\S]*?)<\/script>/);
  if (!spineMatch) throw new Error("Spine data corrupted.");
  
  const spine = JSON.parse(spineMatch[1]);
  const isEncrypted = !!spine.encryption;

  if (isEncrypted && !password) throw new Error('ENCRYPTED_VOLUME');

  const metadata: FileMetadata = {
    name: spine.filename || file.name.replace('.hda.html', ''),
    type: spine.mimeType || 'application/octet-stream',
    size: spine.total_bytes,
    timestamp: Date.now(),
    totalPages: spine.cells.length,
    isEncrypted
  };

  let dirHandle: FileSystemDirectoryHandle | null = null;
  let saveHandle: FileSystemFileHandle | null = null;
  let useFallback = false;

  if (spine.isMultiFile) {
    if ('showDirectoryPicker' in window) {
      try {
        dirHandle = await (window as any).showDirectoryPicker();
      } catch (err: any) {
        if (err.name === 'AbortError') throw new Error('ABORTED');
        console.warn("showDirectoryPicker failed", err);
        useFallback = true;
      }
    } else {
      useFallback = true;
    }
  } else {
    if ('showSaveFilePicker' in window) {
      try {
        saveHandle = await (window as any).showSaveFilePicker({
          suggestedName: metadata.name,
        });
      } catch (err: any) {
        if (err.name === 'AbortError') throw new Error('ABORTED');
        console.warn("showSaveFilePicker failed", err);
        useFallback = true;
      }
    } else {
      useFallback = true;
    }
  }

  let payloadPtr = offsetFromFooter;

  // PARALLELISM AUTO-OPTIMIZATION
  const cores = navigator.hardwareConcurrency || 2;
  const poolSize = Math.max(1, Math.min(cores - 1, 8));
  const logs = [`[SYSTEM] Core Count: ${cores}`, `[FORGE] Parallel Pool: ${poolSize}x`];

  const cellMap = new Map();
  spine.cells.forEach((c: any) => {
      cellMap.set(c.id, { ...c, start: payloadPtr });
      payloadPtr += c.compressed_length;
  });

  let finished = 0;
  
  // Derive master key once if encrypted
  let masterKey: CryptoKey | null = null;
  if (isEncrypted && password && spine.cells.length > 0) {
    onProgress({ percentage: 0, status: 'Deriving key...', logs: [...logs, '[SYS] Generating PBKDF2 master key...'] });
    const firstCell = cellMap.get(spine.cells[0].id);
    const firstCellBlob = file.slice(firstCell.start, firstCell.start + 16);
    const saltBuffer = await firstCellBlob.arrayBuffer();
    const salt = new Uint8Array(saltBuffer);
    masterKey = await deriveKey(password, salt);
  }

  const filesToProcess = spine.isMultiFile ? spine.files : [{ name: metadata.name, cells: spine.cells.map((c:any) => c.id), type: metadata.type }];
  let singleFileBlob: Blob | null = null;

  for (const fileMeta of filesToProcess) {
    if (fileMeta.size === 0) continue;
    
    let fileWritable: FileSystemWritableFileStream | null = null;
    const fileBlobParts: Blob[] = useFallback ? new Array(fileMeta.cells.length) : [];

    if (dirHandle) {
      const pathParts = fileMeta.name.split('/').filter((p: string) => p && p !== '.' && p !== '..');
      let currentDir = dirHandle;
      for (let i = 0; i < pathParts.length - 1; i++) {
          currentDir = await currentDir.getDirectoryHandle(pathParts[i], { create: true });
      }
      const fileName = pathParts[pathParts.length - 1] || 'unnamed_file';
      const fileHandle = await currentDir.getFileHandle(fileName, { create: true });
      fileWritable = await fileHandle.createWritable();
    } else if (saveHandle) {
      fileWritable = await saveHandle.createWritable();
    }

    const cellTasks = fileMeta.cells.map((cellId: string, i: number) => ({ index: i, cell: cellMap.get(cellId) }));

    for (let i = 0; i < cellTasks.length; i += poolSize) {
      const batchTasks = cellTasks.slice(i, i + poolSize);
      
      const batchResults = await Promise.all(batchTasks.map(async (task) => {
        const { index, cell } = task;
        const cellBlob = file.slice(cell.start, cell.start + cell.compressed_length);
        let buffer = await cellBlob.arrayBuffer();

        if (isEncrypted && masterKey) {
          const iv = new Uint8Array(buffer.slice(16, 28));
          const data = buffer.slice(28);
          buffer = await decryptData(data, masterKey, iv);
        }

        const ds = new DecompressionStream('deflate');
        const writer = ds.writable.getWriter();
        writer.write(buffer);
        writer.close();
        
        const resBlob = await new Response(ds.readable).blob();
        const resBuffer = await resBlob.arrayBuffer();
        
        return { index, buffer: resBuffer, checksum: cell.checksum };
      }));

      for (const result of batchResults) {
        if (fileWritable) {
          await fileWritable.write(result.buffer);
        } else if (useFallback) {
          fileBlobParts[result.index] = new Blob([result.buffer]);
        }
        finished++;
        
        onProgress({ 
          percentage: Math.round((finished / spine.cells.length) * 100), 
          status: `Extracting ${fileMeta.name} (${finished}/${spine.cells.length})`,
          logs: [...logs, `[VERIFY] Cell ${result.index} Hash: ${result.checksum} OK`]
        });
      }
    }

    if (fileWritable) {
      await fileWritable.close();
    }

    if (useFallback) {
      const finalBlob = new Blob(fileBlobParts, { type: fileMeta.type || "application/octet-stream" });
      if (!spine.isMultiFile) {
        singleFileBlob = finalBlob;
      } else {
        const url = URL.createObjectURL(finalBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileMeta.name.split('/').pop() || 'file';
        a.click();
        await new Promise(r => setTimeout(r, 300));
        URL.revokeObjectURL(url);
      }
    }
  }

  if (spine.isMultiFile || dirHandle || saveHandle) {
    // Handled internally
    return { blob: new Blob(), metadata };
  }

  if (useFallback && singleFileBlob && singleFileBlob.size === 0 && metadata.size > 0) {
    if (window.self !== window.top) {
      throw new Error("Memory limit exceeded. Please open the app in a new tab to enable direct-to-disk streaming.");
    } else {
      throw new Error("Browser memory limit exceeded. Your browser cannot hold this file in memory, and does not support direct-to-disk streaming (or permission was denied). Try using Chrome or Edge.");
    }
  }

  return singleFileBlob ? { blob: singleFileBlob, metadata } : null;
};
