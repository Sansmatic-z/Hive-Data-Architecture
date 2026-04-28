export interface FileMetadata {
  name: string;
  type: string;
  size: number;
  timestamp: number;
  isEncrypted?: boolean;
}

export interface HDACell {
  id: string;
  type: 'html' | 'binary' | 'hive';
  offset: number;
  length: number;
  compressed_length: number;
  checksum: string; // SHA-256 fingerprint (first 16 hex chars)
  compression?: HDACompression;
  isParity?: boolean;
  parityFor?: string | null;
  sourceHash?: string;
}

export interface ProcessingProgress {
  percentage: number;
  status: string;
  logs?: string[];
  stage?: 'initializing' | 'preparing' | 'processing' | 'finalizing' | 'complete';
  currentCell?: number;
  totalCells?: number;
  processedBytes?: number;
  totalBytes?: number;
  throughputBytesPerSecond?: number;
  etaSeconds?: number | null;
  mode?: 'memory' | 'disk';
  cellSize?: number;
  workerCount?: number;
  operationId?: string;
  isResumable?: boolean;
  resumed?: boolean;
}

export enum AppMode {
  ENCODE = 'ENCODE',
  DECODE = 'DECODE'
}

/**
 * Callback type for progress updates during encoding/decoding.
 */
export type ProgressCallback = (progress: ProcessingProgress) => void;

export interface OperationControlOptions {
  signal?: AbortSignal;
  resumeKey?: string;
  companionFiles?: File[];
  sourceFileHandle?: FileSystemFileHandle | null;
  verifyOnly?: boolean;
  previewOnly?: boolean;
  preferredKdf?: HDAKdf['algorithm'];
  passwordHint?: string | null;
  integrityOnly?: boolean;
  folderMetadata?: HDAFolderManifest | null;
  archiveComment?: string | null;
  archiveTags?: string[];
  recipients?: HDARecipientInput[];
}

export interface RuntimeTuning {
  cellSize: number;
  workerCount: number;
  compression: HDACompression;
}

export interface ResumeCheckpointBase {
  operationId: string;
  resumeKey: string;
  mode: 'ENCODE' | 'DECODE';
  fileName: string;
  fileSize: number;
  fileLastModified: number;
  passwordHashHint: string | null;
  updatedAt: number;
  processedBytes: number;
  totalBytes: number;
  nextCellIndex: number;
  tuning: RuntimeTuning;
  headerSize: number;
  persistedAt?: number;
}

export interface EncodeResumeCheckpoint extends ResumeCheckpointBase {
  mode: 'ENCODE';
  cells: HDACell[];
  blobParts?: Blob[];
  currentOffset: number;
  isEncrypted: boolean;
  fileHandle?: FileSystemFileHandle | null;
  sourceFileHandle?: FileSystemFileHandle | null;
}

export interface DecodeResumeCheckpoint extends ResumeCheckpointBase {
  mode: 'DECODE';
  spine: HDASpine;
  blobParts?: Blob[];
  fileHandle?: FileSystemFileHandle | null;
  sourceFileHandle?: FileSystemFileHandle | null;
}

export type ResumeCheckpoint = EncodeResumeCheckpoint | DecodeResumeCheckpoint;

export interface ResumeCheckpointSummary {
  resumeKey: string;
  mode: 'ENCODE' | 'DECODE';
  fileName: string;
  fileSize: number;
  fileLastModified: number;
  updatedAt: number;
  nextCellIndex: number;
  totalBytes: number;
  hasFileHandle: boolean;
  hasSourceFileHandle: boolean;
}

/**
 * Result type from encoder operations.
 */
export interface EncoderResult extends FileMetadata {
  blob: Blob;
  useFallback?: boolean;
  volumes?: HDAVolumeResult[];
  protocolVersion?: number;
}

export interface HDAVolumeResult {
  index: number;
  total: number;
  name: string;
  blob: Blob;
  role: 'manifest' | 'data';
}

export type HDACompression = 'none' | 'deflate' | 'brotli' | 'zstd';

/**
 * Spine metadata embedded in HDA HTML files.
 */
export interface HDASpine {
  version: number;
  total_bytes: number;
  cell_count: number;
  compression: HDACompression;
  encryption: 'aes-256-gcm' | null;
  cells: HDACell[];
  filename: string;
  mimeType: string;
  comment?: string;
  passwordHint?: string;
  creatorApp?: string;
  createdAt?: string;
  sourceHash?: string;
  tags?: string[];
  integrityOnly?: boolean;
  folderManifest?: HDAFolderManifest | null;
  recipients?: HDARecipientManifest[] | null;
  compatibility?: HDACompatibility;
  signature?: HDASignature | null;
  kdf?: HDAKdf | null;
  redundancy?: HDARedundancy | null;
  split?: HDASplitManifest | null;
}

export interface HDACompatibility {
  current: number;
  minReaderVersion: number;
  supportedReaders: number[];
  codecs: HDACompression[];
}

export interface HDASignature {
  algorithm: 'Ed25519' | 'ECDSA-P256-SHA256';
  publicKey: string;
  signedFieldsHash: string;
  signature: string;
}

export interface HDAKdf {
  algorithm: 'PBKDF2-SHA256' | 'Argon2id';
  iterations?: number;
  memorySize?: number;
  parallelism?: number;
  hashLength: number;
}

export interface HDARecipientInput {
  label: string;
  password: string;
  preferredKdf?: HDAKdf['algorithm'];
}

export interface HDARecipientManifest {
  label: string;
  algorithm: 'aes-256-gcm';
  kdf: HDAKdf;
  salt: string;
  iv: string;
  wrappedPassword: string;
}

export interface HDARedundancy {
  enabled: boolean;
  strategy: 'mirror';
  parityCellIds: string[];
}

export interface HDASplitManifest {
  enabled: boolean;
  volumeCount: number;
  volumeSize: number;
  volumes: Array<{
    index: number;
    name: string;
    startCell: number;
    endCell: number;
    includesManifest: boolean;
  }>;
}

/**
 * Footer structure of HDA binary format.
 */
export interface HDAFooter {
  binaryStart: bigint;
  magic: number;
  version: number;
}

export interface ArchiveInspection {
  version: number;
  filename: string;
  mimeType: string;
  totalBytes: number;
  cellCount: number;
  encryption: HDASpine['encryption'];
  compression: HDACompression;
  creatorApp?: string;
  createdAt?: string;
  sourceHash?: string;
  passwordHint?: string;
  integrityOnly?: boolean;
  comment?: string;
  tags?: string[];
  checksums: string[];
  signature?: HDASignature | null;
  kdf?: HDAKdf | null;
  folderManifest?: HDAFolderManifest | null;
  recipients?: Array<Pick<HDARecipientManifest, 'label' | 'kdf'>>;
  preview?: ArchivePreview | null;
}

export interface HDAFolderManifest {
  rootPath: string;
  entries: Array<{
    relativePath: string;
    size: number;
    type?: string;
  }>;
}

export interface ArchivePreview {
  kind: 'text' | 'image' | 'none';
  textSnippet?: string;
  imageUrl?: string;
}
