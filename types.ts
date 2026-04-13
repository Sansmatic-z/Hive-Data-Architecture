
export interface FileMetadata {
  name: string;
  type: string;
  size: number;
  timestamp: number;
  totalPages: number;
  isEncrypted?: boolean;
}

export interface GenerateHDAResult extends FileMetadata {
  blob: Blob;
  useFallback: boolean;
}

export interface EncodingResult {
  dataUrl: string;
  width: number;
  height: number;
  metadata: FileMetadata;
}

export interface DecodingResult {
  blob: Blob;
  metadata: FileMetadata;
}

export interface HDACell {
  id: string;
  type: 'html' | 'binary' | 'hive';
  offset: number;
  length: number;
  compressed_length: number;
  checksum: string; // SHA-256 fingerprint
}

export interface HDASpine {
  version: number;
  total_bytes: number;
  cell_count: number;
  compression: 'deflate' | 'none';
  encryption: 'aes-256-gcm' | null;
  cells: HDACell[];
  filename?: string;
  parallelism?: number;
}

export interface ProcessingProgress {
  currentPage?: number;
  totalPages?: number;
  percentage: number;
  status: string;
  logs?: string[];
}

export enum AppMode {
  ENCODE = 'ENCODE',
  DECODE = 'DECODE'
}
