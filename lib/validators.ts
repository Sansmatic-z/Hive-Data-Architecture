import { z } from 'zod';

/**
 * Input validation schemas for HDA Vault
 * Runtime type checking and sanitization using Zod.
 */

export const FileValidator = z.object({
  name: z
    .string()
    .min(1, 'Filename cannot be empty')
    .max(255, 'Filename too long (max 255 chars)')
    .refine((name) => name !== '.' && name !== '..', 'Filename cannot be "." or ".."')
    .refine((name) => !/[<>:"/\\|?*]/.test(name), 'Filename contains invalid characters'),
  size: z
    .number()
    .int('File size must be an integer')
    .nonnegative('File size cannot be negative')
    .max(10 * 1024 * 1024 * 1024, 'File too large (max 10GB)'),
  type: z.string().optional(),
});

export const PasswordValidator = z
  .string()
  .max(1024, 'Password too long (max 1024 chars)')
  .optional()
  .nullable();

export const SpineSchema = z.object({
  version: z.number(),
  total_bytes: z.number().int().nonnegative(),
  cell_count: z.number().int().nonnegative(),
  compression: z.enum(['deflate', 'none', 'brotli', 'zstd']),
  encryption: z.union([z.literal('aes-256-gcm'), z.null()]),
  cells: z.array(
    z.object({
      id: z.string(),
      type: z.enum(['html', 'binary', 'hive']),
      offset: z.number().int().nonnegative(),
      length: z.number().int().nonnegative(),
      compressed_length: z.number().int().nonnegative(),
      checksum: z.string().length(16),
      compression: z.enum(['deflate', 'none', 'brotli', 'zstd']).optional(),
      isParity: z.boolean().optional(),
      parityFor: z.string().nullable().optional(),
      sourceHash: z.string().optional(),
    })
  ),
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1),
  comment: z.string().max(2000).optional(),
  passwordHint: z.string().max(240).optional(),
  creatorApp: z.string().max(200).optional(),
  createdAt: z.string().optional(),
  sourceHash: z.string().optional(),
  tags: z.array(z.string().max(64)).max(32).optional(),
  integrityOnly: z.boolean().optional(),
  folderManifest: z.object({
    rootPath: z.string().min(1).max(512),
    entries: z.array(z.object({
      relativePath: z.string().min(1).max(1024),
      size: z.number().int().nonnegative(),
      type: z.string().max(255).optional(),
    })).max(10000),
  }).nullable().optional(),
  recipients: z.array(z.object({
    label: z.string().min(1).max(120),
    algorithm: z.literal('aes-256-gcm'),
    kdf: z.object({
      algorithm: z.enum(['PBKDF2-SHA256', 'Argon2id']),
      iterations: z.number().int().positive().optional(),
      memorySize: z.number().int().positive().optional(),
      parallelism: z.number().int().positive().optional(),
      hashLength: z.number().int().positive(),
    }),
    salt: z.string().min(1),
    iv: z.string().min(1),
    wrappedPassword: z.string().min(1),
  })).max(32).nullable().optional(),
  compatibility: z.object({
    current: z.number().int().positive(),
    minReaderVersion: z.number().int().positive(),
    supportedReaders: z.array(z.number().int().positive()).min(1),
    codecs: z.array(z.enum(['deflate', 'none', 'brotli', 'zstd'])).min(1),
  }).optional(),
  signature: z.object({
    algorithm: z.enum(['Ed25519', 'ECDSA-P256-SHA256']),
    publicKey: z.string().min(1),
    signedFieldsHash: z.string().min(1),
    signature: z.string().min(1),
  }).nullable().optional(),
  kdf: z.object({
    algorithm: z.enum(['PBKDF2-SHA256', 'Argon2id']),
    iterations: z.number().int().positive().optional(),
    memorySize: z.number().int().positive().optional(),
    parallelism: z.number().int().positive().optional(),
    hashLength: z.number().int().positive(),
  }).nullable().optional(),
  redundancy: z.object({
    enabled: z.boolean(),
    strategy: z.literal('mirror'),
    parityCellIds: z.array(z.string()),
  }).nullable().optional(),
  split: z.object({
    enabled: z.boolean(),
    volumeCount: z.number().int().positive(),
    volumeSize: z.number().int().positive(),
    volumes: z.array(z.object({
      index: z.number().int().nonnegative(),
      name: z.string().min(1),
      startCell: z.number().int().nonnegative(),
      endCell: z.number().int().nonnegative(),
      includesManifest: z.boolean(),
    })),
  }).nullable().optional(),
}).superRefine((spine, ctx) => {
  if (spine.cell_count !== spine.cells.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'cell_count must match cells.length',
      path: ['cell_count'],
    });
  }

  for (let index = 0; index < spine.cells.length; index += 1) {
    const cell = spine.cells[index];

    if (cell.compression && !['deflate', 'none', 'brotli', 'zstd'].includes(cell.compression)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'unsupported cell compression',
        path: ['cells', index, 'compression'],
      });
    }

    if (!/^[0-9a-f]{16}$/i.test(cell.checksum)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'checksum must be 16 hex characters',
        path: ['cells', index, 'checksum'],
      });
    }

    if (index === 0) {
      continue;
    }

    const previousCell = spine.cells[index - 1];
    const previousEnd = previousCell.offset + previousCell.compressed_length;

    if (cell.offset < previousEnd) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'cell offsets must be monotonic and non-overlapping',
        path: ['cells', index, 'offset'],
      });
    }
  }

  if (spine.split?.enabled && spine.split.volumeCount !== spine.split.volumes.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'split.volumeCount must match split.volumes.length',
      path: ['split', 'volumeCount'],
    });
  }

  if (spine.folderManifest && spine.folderManifest.entries.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'folderManifest.entries must not be empty when folderManifest is present',
      path: ['folderManifest', 'entries'],
    });
  }

  if (spine.integrityOnly && spine.encryption) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'integrityOnly archives cannot be encrypted',
      path: ['integrityOnly'],
    });
  }
});

export type ValidatedFile = z.infer<typeof FileValidator>;
export type SpineData = z.infer<typeof SpineSchema>;

/**
 * Validate a File object against security constraints.
 * Throws ZodError if validation fails.
 */
export function validateFile(file: File): ValidatedFile {
  return FileValidator.parse({
    name: file.name,
    size: file.size,
    type: file.type,
  });
}

/**
 * Validate a password/passphrase.
 * Returns null for empty/undefined passwords.
 */
export function validatePassword(password: string | null | undefined): string | null {
  if (!password || password.trim() === '') return null;
  return PasswordValidator.parse(password);
}

/**
 * Sanitize a filename for safe HTML embedding (XSS prevention).
 * Uses comprehensive HTML entity encoding.
 */
export function sanitizeForHTML(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;')
    .replace(/=/g, '&#x3D;')
    .replace(/`/g, '&#x60;');
}

/**
 * Validate spine data from an HDA archive.
 * Throws ZodError if spine structure is invalid.
 */
export function validateSpine(data: unknown): SpineData {
  return SpineSchema.parse(data);
}
