import { HDA_CONFIG } from '../config/hda';
import {
  HDACompression,
  HDACompatibility,
  HDARedundancy,
  HDASignature,
  HDASplitManifest,
  RuntimeTuning,
} from '../types';
import { logSecurityEvent } from './securityEvents';

export const HDA_FOOTER_SIZE = 16;
const MIN_CELL_SIZE = 8 * 1024 * 1024;
const MAX_CELL_SIZE = 128 * 1024 * 1024;

export async function getChecksum(data: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));

  return hashArray
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .substring(0, HDA_CONFIG.CHECKSUM_LENGTH);
}

export async function getFullHashHex(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  const buffer =
    typeof data === 'string'
      ? new TextEncoder().encode(data).buffer
      : data instanceof Uint8Array
        ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
        : data;
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function escapeJSONForHTMLScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function assertMemoryFallbackSupported(byteLength: number): void {
  if (byteLength <= HDA_CONFIG.MAX_FALLBACK_SIZE) {
    return;
  }

  if (window.self !== window.top) {
    logSecurityEvent({
      code: 'unsafe_embed_context',
      message: 'Large memory fallback attempted inside embedded context.',
      data: { byteLength },
    });
    throw new Error(
      'Memory limit exceeded. Please open the app in a new tab to enable direct-to-disk streaming.',
    );
  }

  console.warn(
    `Memory fallback advisory threshold exceeded (${formatLimit(HDA_CONFIG.MAX_FALLBACK_SIZE)}). ` +
      'Continuing because this window may still have sufficient memory.',
  );
}

function formatLimit(bytes: number): string {
  const gib = bytes / (1024 * 1024 * 1024);
  return `${gib.toFixed(gib < 10 ? 1 : 0)} GB`;
}

export function createOperationId(prefix: 'enc' | 'dec'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function getProtocolCompatibility(version = HDA_CONFIG.PROTOCOL_VERSION): HDACompatibility {
  return {
    current: version,
    minReaderVersion: HDA_CONFIG.LEGACY_PROTOCOL_VERSION,
    supportedReaders: [HDA_CONFIG.LEGACY_PROTOCOL_VERSION, HDA_CONFIG.PROTOCOL_VERSION],
    codecs: ['none', 'deflate', 'brotli', 'zstd'],
  };
}

export function shouldEnableRedundancy(fileSize: number): boolean {
  return fileSize >= HDA_CONFIG.REDUNDANCY_THRESHOLD;
}

export function createRedundancyManifest(parityCellIds: string[]): HDARedundancy {
  return {
    enabled: parityCellIds.length > 0,
    strategy: 'mirror',
    parityCellIds,
  };
}

export function estimateHeaderReserve(input: {
  fileName: string;
  fileType?: string | null;
  fileSize: number;
  cellCount: number;
  encrypted: boolean;
  metadataBytes?: number;
  recipientCount?: number;
  folderEntryCount?: number;
}): number {
  const metadataBytes = input.metadataBytes ?? 0;
  const recipientCount = input.recipientCount ?? 0;
  const folderEntryCount = input.folderEntryCount ?? 0;
  const reserve =
    12_288 +
    metadataBytes +
    input.fileName.length * 4 +
    (input.fileType?.length ?? 0) * 2 +
    input.cellCount * 320 +
    recipientCount * 768 +
    folderEntryCount * 96 +
    (input.encrypted ? 2_048 : 1_024);

  return roundUpToBoundary(
    Math.max(HDA_CONFIG.MIN_HEADER_SIZE, Math.min(HDA_CONFIG.HEADER_SIZE, reserve)),
    4_096,
  );
}

function roundUpToBoundary(value: number, boundary: number): number {
  return Math.ceil(value / boundary) * boundary;
}

export function createSplitManifest(
  cells: Array<{ compressed_length: number }>,
  filename: string,
  headerSize = HDA_CONFIG.HEADER_SIZE,
): HDASplitManifest | null {
  if (!HDA_CONFIG.SPLIT_VOLUME_SIZE || HDA_CONFIG.SPLIT_VOLUME_SIZE <= 0) {
    return null;
  }

  const volumes: HDASplitManifest['volumes'] = [];
  let currentSize = headerSize + HDA_FOOTER_SIZE;
  let currentStart = 0;
  let currentIndex = 0;

  for (let i = 0; i < cells.length; i += 1) {
    const nextSize = currentSize + cells[i].compressed_length;
    if (i > currentStart && nextSize > HDA_CONFIG.SPLIT_VOLUME_SIZE) {
      volumes.push({
        index: currentIndex,
        name: `${filename}.part${String(currentIndex + 1).padStart(3, '0')}.hda`,
        startCell: currentStart,
        endCell: i - 1,
        includesManifest: currentIndex === 0,
      });
      currentIndex += 1;
      currentStart = i;
      currentSize = headerSize + HDA_FOOTER_SIZE + cells[i].compressed_length;
    } else {
      currentSize = nextSize;
    }
  }

  volumes.push({
    index: currentIndex,
    name: `${filename}.part${String(currentIndex + 1).padStart(3, '0')}.hda`,
    startCell: currentStart,
    endCell: Math.max(currentStart, cells.length - 1),
    includesManifest: currentIndex === 0,
  });

  return {
    enabled: volumes.length > 1,
    volumeCount: volumes.length,
    volumeSize: HDA_CONFIG.SPLIT_VOLUME_SIZE,
    volumes,
  };
}

export async function signManifestFields(manifestPayload: string): Promise<HDASignature> {
  const useEd25519 = await supportsEd25519();
  const keyPair = (await crypto.subtle.generateKey(
    useEd25519
      ? ({
          name: 'Ed25519',
        } as AlgorithmIdentifier)
      : ({
          name: 'ECDSA',
          namedCurve: 'P-256',
        } as EcKeyGenParams),
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;

  const data = new TextEncoder().encode(manifestPayload);
  const signatureBuffer = await crypto.subtle.sign(
    useEd25519 ? 'Ed25519' : { name: 'ECDSA', hash: 'SHA-256' },
    keyPair.privateKey,
    data,
  );
  const exportedPublicKey = await crypto.subtle.exportKey('spki', keyPair.publicKey);

  return {
    algorithm: useEd25519 ? 'Ed25519' : 'ECDSA-P256-SHA256',
    publicKey: bytesToBase64(new Uint8Array(exportedPublicKey)),
    signedFieldsHash: await getFullHashHex(data),
    signature: bytesToBase64(new Uint8Array(signatureBuffer)),
  };
}

export async function verifyManifestSignature(
  manifestPayload: string,
  signature: HDASignature | null | undefined,
): Promise<boolean> {
  if (!signature) {
    return true;
  }

  const publicKey = await crypto.subtle.importKey(
    'spki',
    base64ToBytes(signature.publicKey),
    signature.algorithm === 'Ed25519'
      ? ({ name: 'Ed25519' } as AlgorithmIdentifier)
      : ({ name: 'ECDSA', namedCurve: 'P-256' } as EcKeyImportParams),
    false,
    ['verify'],
  );

  const data = new TextEncoder().encode(manifestPayload);
  const dataHash = await getFullHashHex(data);
  if (dataHash !== signature.signedFieldsHash) {
    return false;
  }

  return crypto.subtle.verify(
    signature.algorithm === 'Ed25519' ? 'Ed25519' : { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    base64ToBytes(signature.signature),
    data,
  );
}

async function supportsEd25519(): Promise<boolean> {
  try {
    await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    return true;
  } catch {
    return false;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function createResumeKey(file: File, mode: 'ENCODE' | 'DECODE'): string {
  return [
    mode,
    file.name,
    file.size,
    file.lastModified,
  ].join(':');
}

export function describeFileFingerprint(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

export function getAdaptiveTuning(file: { size: number; name: string; type?: string | null }): RuntimeTuning {
  const memoryPressure = getMemoryPressureLevel(file.size);
  const compression = chooseCompressionCodec(file, memoryPressure);
  const deviceMemoryGiB = typeof navigator !== 'undefined' && 'deviceMemory' in navigator
    ? Number((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4)
    : 4;
  const hardwareThreads = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;

  let cellSize = HDA_CONFIG.CELL_SIZE;
  const lowerName = file.name.toLowerCase();
  const largeFile = file.size >= 4 * 1024 * 1024 * 1024;
  const mediumFile = file.size >= 512 * 1024 * 1024;

  if (compression === 'none') {
    cellSize = largeFile ? 96 * 1024 * 1024 : mediumFile ? 64 * 1024 * 1024 : 32 * 1024 * 1024;
  } else if (deviceMemoryGiB <= 4 || memoryPressure !== 'normal') {
    cellSize = 16 * 1024 * 1024;
  } else if (largeFile) {
    cellSize = 32 * 1024 * 1024;
  }

  if (lowerName.endsWith('.iso') || lowerName.endsWith('.img')) {
    cellSize = Math.max(cellSize, 96 * 1024 * 1024);
  }

  cellSize = Math.max(MIN_CELL_SIZE, Math.min(MAX_CELL_SIZE, cellSize));
  const workerCount = Math.max(
    1,
    Math.min(
      compression === 'none' ? 4 : compression === 'brotli' ? 3 : 6,
      Math.max(1, hardwareThreads - (memoryPressure === 'critical' ? 2 : 1)),
    ),
  );

  return {
    cellSize,
    workerCount,
    compression,
  };
}

function chooseCompressionCodec(
  file: { name: string; size: number; type?: string | null },
  memoryPressure: 'normal' | 'high' | 'critical',
): HDACompression {
  if (!shouldCompress(file)) {
    return 'none';
  }

  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  const isTextLike =
    (file.type ?? '').startsWith('text/') ||
    TEXT_LIKE_EXTENSIONS.has(extension);

  if (memoryPressure === 'critical') {
    return 'none';
  }

  if (isTextLike && file.size <= 16 * 1024 * 1024 && runtimeSupportsCodec('brotli')) {
    return 'brotli';
  }

  if (file.size >= 512 * 1024 * 1024 && memoryPressure === 'normal' && runtimeSupportsCodec('zstd')) {
    return 'zstd';
  }

  return 'deflate';
}

function runtimeSupportsCodec(codec: 'brotli' | 'zstd'): boolean {
  try {
    new CompressionStream(codec as CompressionFormat);
    new DecompressionStream(codec as CompressionFormat);
    return true;
  } catch {
    return false;
  }
}

function shouldCompress(file: { name: string; type?: string | null }): boolean {
  const mimeType = file.type ?? '';

  if (mimeType.startsWith('video/') || mimeType.startsWith('audio/')) {
    return false;
  }

  if (
    mimeType === 'application/zip' ||
    mimeType === 'application/x-7z-compressed' ||
    mimeType === 'application/x-rar-compressed' ||
    mimeType === 'application/gzip' ||
    mimeType === 'application/x-iso9660-image' ||
    mimeType === 'application/pdf'
  ) {
    return false;
  }

  const extension = file.name.split('.').pop()?.toLowerCase();
  return extension ? !NON_COMPRESSIBLE_EXTENSIONS.has(extension) : true;
}

export function getMemoryPressureLevel(fileSize: number): 'normal' | 'high' | 'critical' {
  const deviceMemoryGiB =
    typeof navigator !== 'undefined' && 'deviceMemory' in navigator
      ? Number((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4)
      : 4;
  const jsHeapLimit =
    typeof performance !== 'undefined' &&
    'memory' in performance &&
    (performance as Performance & {
      memory?: { jsHeapSizeLimit?: number; usedJSHeapSize?: number };
    }).memory?.jsHeapSizeLimit
      ? (performance as Performance & {
          memory?: { jsHeapSizeLimit?: number; usedJSHeapSize?: number };
        }).memory!.jsHeapSizeLimit!
      : deviceMemoryGiB * 1024 * 1024 * 1024;

  if (fileSize >= jsHeapLimit * 0.8 || deviceMemoryGiB <= 2) {
    return 'critical';
  }

  if (fileSize >= jsHeapLimit * 0.45 || deviceMemoryGiB <= 4) {
    return 'high';
  }

  return 'normal';
}

const NON_COMPRESSIBLE_EXTENSIONS = new Set([
  '7z',
  'avi',
  'br',
  'bz2',
  'cab',
  'deb',
  'dmg',
  'gz',
  'img',
  'iso',
  'jar',
  'jpeg',
  'jpg',
  'm4a',
  'm4v',
  'mkv',
  'mov',
  'mp3',
  'mp4',
  'mpeg',
  'mpg',
  'pdf',
  'png',
  'rar',
  'tgz',
  'webm',
  'webp',
  'woff',
  'woff2',
  'xz',
  'zip',
]);

const TEXT_LIKE_EXTENSIONS = new Set([
  'c',
  'cpp',
  'css',
  'csv',
  'html',
  'js',
  'json',
  'log',
  'md',
  'mjs',
  'svg',
  'ts',
  'tsx',
  'txt',
  'xml',
  'yaml',
  'yml',
]);
