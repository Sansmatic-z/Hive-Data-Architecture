
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
  checksum: string; // SHA-256 fingerprint
}

export interface ProcessingProgress {
  percentage: number;
  status: string;
  logs?: string[];
}

export enum AppMode {
  ENCODE = 'ENCODE',
  DECODE = 'DECODE'
}
