import { describe, it, expect } from 'vitest';
import { validateFile, validatePassword, sanitizeForHTML, validateSpine } from '../lib/validators';

describe('validators/validateFile', () => {
  it('should validate a normal file', () => {
    const file = new File(['test'], 'document.pdf', { type: 'application/pdf' });
    const result = validateFile(file);
    expect(result.name).toBe('document.pdf');
    expect(result.size).toBe(4);
    expect(result.type).toBe('application/pdf');
  });

  it('should validate filenames with dots', () => {
    const file = new File(['test'], '.gitignore', { type: 'text/plain' });
    const result = validateFile(file);
    expect(result.name).toBe('.gitignore');
  });

  it('should reject empty filenames', () => {
    const file = new File(['test'], '', { type: 'application/pdf' });
    expect(() => validateFile(file)).toThrow('Filename cannot be empty');
  });

  it('should reject filenames with invalid characters', () => {
    const file = new File(['test'], 'file<name>.txt', { type: 'text/plain' });
    expect(() => validateFile(file)).toThrow('Filename contains invalid characters');
  });

  it('should reject filenames longer than 255 chars', () => {
    const longName = 'a'.repeat(256) + '.txt';
    const file = new File(['test'], longName, { type: 'text/plain' });
    expect(() => validateFile(file)).toThrow('Filename too long');
  });

  it('should reject "." and ".." filenames', () => {
    const dotFile = new File(['test'], '.', { type: 'text/plain' });
    expect(() => validateFile(dotFile)).toThrow();
    
    const dotDotFile = new File(['test'], '..', { type: 'text/plain' });
    expect(() => validateFile(dotDotFile)).toThrow();
  });
});

describe('validators/validatePassword', () => {
  it('should return null for empty password', () => {
    expect(validatePassword('')).toBeNull();
    expect(validatePassword(null)).toBeNull();
    expect(validatePassword(undefined)).toBeNull();
  });

  it('should return password for valid input', () => {
    expect(validatePassword('secret123')).toBe('secret123');
  });

  it('should reject very long passwords', () => {
    const longPassword = 'a'.repeat(1025);
    expect(() => validatePassword(longPassword)).toThrow('Password too long');
  });
});

describe('validators/sanitizeForHTML', () => {
  it('should escape XSS vectors', () => {
    expect(sanitizeForHTML('<script>')).toBe('&lt;script&gt;');
    expect(sanitizeForHTML('"onclick"')).toBe('&quot;onclick&quot;');
    expect(sanitizeForHTML("'onfocus'")).toBe('&#x27;onfocus&#x27;');
  });

  it('should escape ampersands', () => {
    expect(sanitizeForHTML('a&b')).toBe('a&amp;b');
  });

  it('should escape slashes and backticks', () => {
    expect(sanitizeForHTML('a/b')).toBe('a&#x2F;b');
    expect(sanitizeForHTML('`code`')).toBe('&#x60;code&#x60;');
  });

  it('should leave safe text unchanged', () => {
    expect(sanitizeForHTML('Hello World 123')).toBe('Hello World 123');
  });
});

describe('validators/validateSpine', () => {
  it('should validate correct spine data', () => {
    const validSpine = {
      version: 10,
      total_bytes: 1024,
      cell_count: 1,
      compression: 'deflate' as const,
      encryption: 'aes-256-gcm' as const,
      cells: [
        {
          id: 'C000',
          type: 'binary' as const,
          offset: 2097152,
          length: 1024,
          compressed_length: 512,
          checksum: 'abcdef0123456789',
        },
      ],
      filename: 'test.txt',
      mimeType: 'text/plain',
      passwordHint: 'first pet',
      integrityOnly: false,
      folderManifest: {
        rootPath: 'docs',
        entries: [{ relativePath: 'docs/test.txt', size: 1024, type: 'text/plain' }],
      },
    };
    expect(validateSpine(validSpine)).toEqual(validSpine);
  });

  it('should reject missing fields', () => {
    const invalidSpine = { version: 9 };
    expect(() => validateSpine(invalidSpine)).toThrow();
  });

  it('should reject invalid compression type', () => {
    const invalidSpine = {
      version: 9,
      total_bytes: 1024,
      cell_count: 1,
      compression: 'gzip',
      encryption: null,
      cells: [],
      filename: 'test.txt',
      mimeType: 'text/plain',
    };
    expect(() => validateSpine(invalidSpine)).toThrow();
  });

  it('should reject checksums wrong length', () => {
    const invalidSpine = {
      version: 9,
      total_bytes: 1024,
      cell_count: 1,
      compression: 'deflate',
      encryption: null,
      cells: [
        {
          id: 'C000',
          type: 'binary',
          offset: 0,
          length: 1024,
          compressed_length: 512,
          checksum: 'tooshort',
        },
      ],
      filename: 'test.txt',
      mimeType: 'text/plain',
    };
    expect(() => validateSpine(invalidSpine)).toThrow();
  });

  it('should reject cell_count mismatches', () => {
    const invalidSpine = {
      version: 9,
      total_bytes: 1024,
      cell_count: 2,
      compression: 'deflate',
      encryption: null,
      cells: [
        {
          id: 'C000',
          type: 'binary',
          offset: 2097152,
          length: 1024,
          compressed_length: 512,
          checksum: 'abcdef0123456789',
        },
      ],
      filename: 'test.txt',
      mimeType: 'text/plain',
    };

    expect(() => validateSpine(invalidSpine)).toThrow('cell_count must match cells.length');
  });

  it('should reject overlapping cell offsets', () => {
    const invalidSpine = {
      version: 9,
      total_bytes: 2048,
      cell_count: 2,
      compression: 'deflate',
      encryption: null,
      cells: [
        {
          id: 'C000',
          type: 'binary',
          offset: 2097152,
          length: 1024,
          compressed_length: 512,
          checksum: 'abcdef0123456789',
        },
        {
          id: 'C001',
          type: 'binary',
          offset: 2097200,
          length: 1024,
          compressed_length: 512,
          checksum: 'fedcba9876543210',
        },
      ],
      filename: 'test.txt',
      mimeType: 'text/plain',
    };

    expect(() => validateSpine(invalidSpine)).toThrow('cell offsets must be monotonic and non-overlapping');
  });

  it('should reject encrypted integrity-only manifests', () => {
    const invalidSpine = {
      version: 10,
      total_bytes: 1024,
      cell_count: 1,
      compression: 'none',
      encryption: 'aes-256-gcm',
      integrityOnly: true,
      cells: [
        {
          id: 'C000',
          type: 'binary',
          offset: 2097152,
          length: 1024,
          compressed_length: 1024,
          checksum: 'abcdef0123456789',
        },
      ],
      filename: 'test.txt',
      mimeType: 'text/plain',
    };

    expect(() => validateSpine(invalidSpine)).toThrow('integrityOnly archives cannot be encrypted');
  });
});
