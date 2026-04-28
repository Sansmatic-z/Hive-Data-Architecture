import { describe, it, expect } from 'vitest';
import { cn, formatBytes } from '../lib/utils';

describe('utils/cn', () => {
  it('should merge class names correctly', () => {
    expect(cn('foo', 'bar')).toBe('foo bar');
  });

  it('should handle conditional classes', () => {
    expect(cn('base', true && 'active', false && 'disabled')).toBe('base active');
  });

  it('should handle array inputs', () => {
    expect(cn(['foo', 'bar'])).toBe('foo bar');
  });

  it('should merge tailwind conflicts', () => {
    expect(cn('px-2', 'px-4')).toBe('px-4');
  });

  it('should handle empty inputs', () => {
    expect(cn()).toBe('');
    expect(cn('', false, null, undefined)).toBe('');
  });
});

describe('utils/formatBytes', () => {
  it('should format zero bytes', () => {
    expect(formatBytes(0)).toBe('0 Bytes');
  });

  it('should format bytes correctly', () => {
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1048576)).toBe('1 MB');
    expect(formatBytes(1073741824)).toBe('1 GB');
  });

  it('should handle decimal places', () => {
    expect(formatBytes(1500, 0)).toBe('1 KB');
    expect(formatBytes(1500, 2)).toBe('1.46 KB');
    expect(formatBytes(1500, 3)).toBe('1.465 KB');
  });

  it('should handle negative decimals gracefully', () => {
    expect(formatBytes(1500, -1)).toBe('1 KB');
  });

  it('should format large numbers', () => {
    expect(formatBytes(1234567890123)).toBe('1.12 TB');
  });
});
