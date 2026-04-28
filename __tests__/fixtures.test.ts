import { describe, expect, it } from 'vitest';
import spineV9 from '../__fixtures__/spine-v9.json';
import spineV10 from '../__fixtures__/spine-v10.json';
import { validateSpine } from '../lib/validators';

describe('protocol fixtures', () => {
  it('validates the legacy v9 manifest fixture', () => {
    const parsed = validateSpine(spineV9);
    expect(parsed.version).toBe(9);
    expect(parsed.filename).toBe('legacy.txt');
  });

  it('validates the modern v10 manifest fixture', () => {
    const parsed = validateSpine(spineV10);
    expect(parsed.version).toBe(10);
    expect(parsed.kdf?.algorithm).toBe('PBKDF2-SHA256');
  });
});
