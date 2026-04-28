import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateHDA } from '../services/hdaEncoder';

describe('embedded self-extracting html', () => {
  beforeEach(() => {
    Reflect.deleteProperty(window, 'showSaveFilePicker');
  });

  it('embeds archive inspector and integrity verification script markers', async () => {
    const encoded = await generateHDA(
      new File(['hello embedded'], 'embedded.txt', { type: 'text/plain' }),
      'hunter2',
      vi.fn(),
    );
    const html = await encoded!.blob.text();
    expect(html).toContain('id="spine-node"');
    expect(html).toContain('Integrity Breach');
    expect(html).toContain('SIGNATURE');
    expect(html).toContain('KDF');
  });
});
