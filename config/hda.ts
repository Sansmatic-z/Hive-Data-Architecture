/**
 * HDA Configuration Layer
 * Centralized, environment-aware configuration for all HDA constants.
 */

/// <reference types="vite/client" />

function parsePositiveInt(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum = 1,
): number {
  const parsed = Number.parseInt(value ?? '', 10);

  if (Number.isNaN(parsed)) {
    return fallback;
  }

  if (parsed < minimum) {
    throw new Error(`${name} must be >= ${minimum}`);
  }

  return parsed;
}

const CELL_SIZE = parsePositiveInt(
  import.meta.env.VITE_CELL_SIZE,
  52_428_800,
  'VITE_CELL_SIZE',
);

const HEADER_SIZE = parsePositiveInt(
  import.meta.env.VITE_HEADER_SIZE,
  2_097_152,
  'VITE_HEADER_SIZE',
  1024,
);

const MIN_HEADER_SIZE = parsePositiveInt(
  import.meta.env.VITE_MIN_HEADER_SIZE,
  32_768,
  'VITE_MIN_HEADER_SIZE',
  1024,
);

const PBKDF2_ITERATIONS = parsePositiveInt(
  import.meta.env.VITE_PBKDF2_ITERATIONS,
  600_000,
  'VITE_PBKDF2_ITERATIONS',
  100_000,
);

const MAX_FALLBACK_SIZE = parsePositiveInt(
  import.meta.env.VITE_MAX_FALLBACK_SIZE,
  2_147_483_648,
  'VITE_MAX_FALLBACK_SIZE',
  HEADER_SIZE,
);

const SPLIT_VOLUME_SIZE = parsePositiveInt(
  import.meta.env.VITE_SPLIT_VOLUME_SIZE,
  0,
  'VITE_SPLIT_VOLUME_SIZE',
  0,
);

const REDUNDANCY_THRESHOLD = parsePositiveInt(
  import.meta.env.VITE_REDUNDANCY_THRESHOLD,
  268_435_456,
  'VITE_REDUNDANCY_THRESHOLD',
  1,
);

if (HEADER_SIZE >= MAX_FALLBACK_SIZE) {
  throw new Error('VITE_MAX_FALLBACK_SIZE must be larger than VITE_HEADER_SIZE');
}

if (MIN_HEADER_SIZE > HEADER_SIZE) {
  throw new Error('VITE_MIN_HEADER_SIZE must be <= VITE_HEADER_SIZE');
}

export const HDA_CONFIG = {
  /** Cell size for chunked processing (50MB) */
  CELL_SIZE,

  /** Maximum reserved header size in generated HDA files */
  HEADER_SIZE,

  /** Minimum reserved header size for tiny archives */
  MIN_HEADER_SIZE,

  /** PBKDF2 key derivation iterations */
  PBKDF2_ITERATIONS,

  /** Maximum log entries to retain */
  MAX_LOG_ENTRIES: 50,

  /** Progress update throttle interval (ms) */
  PROGRESS_THROTTLE_MS: 100,

  /** HDA Protocol magic number */
  MAGIC_NUMBER: 0x48444121,

  /** Internal protocol version */
  PROTOCOL_VERSION: 10,

  /** Previous stable protocol version */
  LEGACY_PROTOCOL_VERSION: 9,

  /** Display protocol version */
  DISPLAY_VERSION: '4.0',

  /** Maximum file size for fallback mode (2GB browser memory limit guard) */
  MAX_FALLBACK_SIZE,

  /** Optional split volume threshold, disabled when 0 */
  SPLIT_VOLUME_SIZE,

  /** File size threshold after which mirror redundancy is enabled */
  REDUNDANCY_THRESHOLD,

  /** Salt size for key derivation (bytes) */
  SALT_SIZE: 16,

  /** IV size for AES-GCM (bytes) */
  IV_SIZE: 12,

  /** SHA-256 checksum length (first N hex chars stored) */
  CHECKSUM_LENGTH: 16,
} as const;
