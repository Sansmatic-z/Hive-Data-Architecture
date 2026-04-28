import { beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { decodeFromHDA } from '../services/hdaDecoder';
import { generateHDA } from '../services/hdaEncoder';

describe('roundtrip properties', () => {
  beforeEach(() => {
    Reflect.deleteProperty(window, 'showSaveFilePicker');
  });

  it('roundtrips arbitrary utf-8 payloads', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 256 }),
        fc.boolean(),
        async (payload, encrypted) => {
          const file = new File([payload], 'prop.txt', { type: 'text/plain' });
          const password = encrypted ? 'PropertyPass!123' : null;
          const encoded = await generateHDA(file, password, () => undefined);
          const archive = new File([encoded!.blob], 'prop.txt.hda.html', { type: 'text/html' });
          const decoded = await decodeFromHDA(archive, password, () => undefined);
          expect(await decoded!.blob.text()).toBe(payload);
        },
      ),
      { numRuns: 12 },
    );
  });
});
