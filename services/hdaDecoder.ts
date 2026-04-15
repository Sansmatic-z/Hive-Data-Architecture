import { FileMetadata, ProcessingProgress } from '../types';
import { deriveKey, decryptData } from './cryptoService';

const MAGIC_HDA = 0x48444121;

export const decodeFromHDA = async (
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
    isEncrypted
  };

  let handle: FileSystemFileHandle | null = null;
  let useFallback = false;

  if ('showSaveFilePicker' in window) {
    try {
      handle = await (window as any).showSaveFilePicker({
        suggestedName: metadata.name,
      });
    } catch (err: any) {
      if (err.name === 'AbortError') return null;
      console.warn("showSaveFilePicker failed, falling back to memory blob", err);
      useFallback = true;
    }
  } else {
    useFallback = true;
  }

  const writable = handle ? await handle.createWritable() : null;

  let payloadPtr = offsetFromFooter;

  // Auto-correct padding offset (legacy support)
  const probeBlob = file.slice(payloadPtr, payloadPtr + 1);
  const probe = new Uint8Array(await probeBlob.arrayBuffer());
  if (probe[0] === 32) {
     const FIX_OFFSET = 1024 * 1024 * 1.5;
     const checkBlob = file.slice(payloadPtr + FIX_OFFSET, payloadPtr + FIX_OFFSET + 1);
     const check = new Uint8Array(await checkBlob.arrayBuffer());
     if (check[0] !== 32) payloadPtr += FIX_OFFSET;
  }

  // PARALLELISM AUTO-OPTIMIZATION
  const cores = navigator.hardwareConcurrency || 2;
  const poolSize = Math.max(1, Math.min(cores - 1, 8));
  const logs = [`[SYSTEM] Core Count: ${cores}`, `[FORGE] Parallel Pool: ${poolSize}x`];

  const tasks = spine.cells.map((cell: any, i: number) => {
    const start = payloadPtr;
    payloadPtr += cell.compressed_length;
    return { index: i, cell, start };
  });

  let finished = 0;
  
  const blobParts: Blob[] = [];

  // For streaming, we need to write sequentially to the file handle to avoid corruption.
  // We can decompress in parallel, but we must write in order.
  // To keep memory low, we process in small batches and write them sequentially.
  
  for (let i = 0; i < tasks.length; i += poolSize) {
    const batchTasks = tasks.slice(i, i + poolSize);
    
    // Decompress in parallel
    const batchResults = await Promise.all(batchTasks.map(async (task) => {
      const { index, cell, start } = task;
      const cellBlob = file.slice(start, start + cell.compressed_length);
      let buffer = await cellBlob.arrayBuffer();

      if (isEncrypted && password) {
        const salt = new Uint8Array(buffer.slice(0, 16));
        const iv = new Uint8Array(buffer.slice(16, 28));
        const data = buffer.slice(28);
        
        const key = await deriveKey(password, salt);
        buffer = await decryptData(data, key, iv);
      }

      const ds = new DecompressionStream('deflate');
      const writer = ds.writable.getWriter();
      writer.write(buffer);
      writer.close();
      
      const resBlob = await new Response(ds.readable).blob();
      const resBuffer = await resBlob.arrayBuffer();

      // Strict Integrity Check
      const hashBuffer = await crypto.subtle.digest('SHA-256', buffer); // Hash the compressed data (matches encoder)
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const actualChecksum = hashArray.map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 16);

      if (actualChecksum !== cell.checksum) {
        throw new Error(`Integrity Breach: Cell ${index} checksum mismatch.`);
      }

      return { index: index, buffer: resBuffer, checksum: cell.checksum };
      }));

    // Write sequentially
    for (const result of batchResults) {
      if (writable) {
        await writable.write(result.buffer);
      } else {
        blobParts[result.index] = new Blob([result.buffer]);
      }
      finished++;
      
      onProgress({ 
        percentage: Math.round((finished / spine.cells.length) * 100), 
        status: `Processing ${finished}/${spine.cells.length}`,
        logs: [...logs, `[VERIFY] Cell ${result.index} Hash: ${result.checksum} OK`]
      });
    }
  }

  if (writable) {
    await writable.close();
  }

  const finalBlob = useFallback ? new Blob(blobParts, { type: metadata.type }) : new Blob();
  if (useFallback && finalBlob.size === 0 && metadata.size > 0) {
    if (window.self !== window.top) {
      throw new Error("Memory limit exceeded. Please open the app in a new tab to enable direct-to-disk streaming.");
    } else {
      throw new Error("Browser memory limit exceeded. Your browser cannot hold this file in memory, and does not support direct-to-disk streaming (or permission was denied). Try using Chrome or Edge.");
    }
  }

  return {
    blob: finalBlob,
    metadata
  };
};
