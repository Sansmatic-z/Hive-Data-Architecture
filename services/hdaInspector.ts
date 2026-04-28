import { ArchiveInspection, ArchivePreview, FileMetadata, HDASpine, OperationControlOptions, ProgressCallback } from '../types';
import { HDA_CONFIG } from '../config/hda';
import { HDA_FOOTER_SIZE } from '../lib/hdaProtocol';
import { validateSpine } from '../lib/validators';
import { decodeFromHDA } from './hdaDecoder';

const MAGIC_HDA = HDA_CONFIG.MAGIC_NUMBER;

async function assembleSplitArchive(file: File, companionFiles: File[] = []): Promise<File> {
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

export async function inspectHDA(
  file: File,
  options: Pick<OperationControlOptions, 'companionFiles'> = {},
): Promise<{ inspection: ArchiveInspection; metadata: FileMetadata; spine: HDASpine }> {
  const sourceFile = await assembleSplitArchive(file, options.companionFiles);
  const footerView = new DataView(await sourceFile.slice(-HDA_FOOTER_SIZE).arrayBuffer());
  const offsetFromFooter = Number(footerView.getBigUint64(0, true));
  const magic = footerView.getUint32(8, true);
  const version = footerView.getUint32(12, true);

  if (magic !== MAGIC_HDA) {
    throw new Error('Not a valid HDA Hive.');
  }

  const headerText = await sourceFile
    .slice(0, Math.max(Math.min(offsetFromFooter, sourceFile.size - HDA_FOOTER_SIZE), HDA_CONFIG.MIN_HEADER_SIZE))
    .text();
  const spineMatch = headerText.match(
    /<script id="spine-node" type="application\/hda-spine">([\s\S]*?)<\/script>/,
  );
  if (!spineMatch) {
    throw new Error('Spine data corrupted.');
  }

  const spine = validateSpine(JSON.parse(spineMatch[1])) as HDASpine;
  const metadata: FileMetadata = {
    name: spine.filename,
    type: spine.mimeType,
    size: spine.total_bytes,
    timestamp: Date.now(),
    isEncrypted: !!spine.encryption,
  };

  const preview = await buildPreview(file, spine, options.companionFiles);

  return {
    spine,
    metadata,
    inspection: {
      version,
      filename: spine.filename,
      mimeType: spine.mimeType,
      totalBytes: spine.total_bytes,
      cellCount: spine.cell_count,
      encryption: spine.encryption,
      compression: spine.compression,
      creatorApp: spine.creatorApp,
      createdAt: spine.createdAt,
      sourceHash: spine.sourceHash,
      passwordHint: spine.passwordHint,
      integrityOnly: spine.integrityOnly,
      comment: spine.comment,
      tags: spine.tags,
      checksums: spine.cells.filter((cell) => !cell.isParity).map((cell) => cell.checksum),
      signature: spine.signature,
      kdf: spine.kdf,
      folderManifest: spine.folderManifest,
      recipients: spine.recipients?.map((recipient) => ({ label: recipient.label, kdf: recipient.kdf })),
      preview,
    },
  };
}

export async function verifyHDA(
  file: File,
  password: string | null,
  onProgress: ProgressCallback,
  options: OperationControlOptions = {},
): Promise<{ metadata: FileMetadata }> {
  const decoded = await decodeFromHDA(file, password, onProgress, { ...options, verifyOnly: true });
  if (!decoded) {
    throw new Error('Verification aborted.');
  }
  return { metadata: decoded.metadata };
}

async function buildPreview(
  file: File,
  spine: HDASpine,
  companionFiles: File[] = [],
): Promise<ArchivePreview | null> {
  if (spine.encryption) {
    return null;
  }

  if (spine.total_bytes > 20 * 1024 * 1024) {
    return null;
  }

  const lowerType = spine.mimeType.toLowerCase();
  if (!lowerType.startsWith('text/') && !/json|xml|javascript/.test(lowerType) && !lowerType.startsWith('image/')) {
    return null;
  }

  const decoded = await decodeFromHDA(file, null, () => undefined, {
    companionFiles,
    previewOnly: true,
  });
  if (!decoded) {
    return null;
  }

  if (lowerType.startsWith('text/') || /json|xml|javascript/.test(lowerType)) {
    const text = await decoded.blob.text();
    const snippet = text.slice(0, 240).replace(/\s+/g, ' ').trim();
    return snippet ? { kind: 'text', textSnippet: snippet } : { kind: 'none' };
  }

  if (lowerType.startsWith('image/')) {
    const url = URL.createObjectURL(decoded.blob);
    return { kind: 'image', imageUrl: url };
  }

  return { kind: 'none' };
}
