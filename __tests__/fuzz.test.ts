import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { validateSpine } from '../lib/validators';

describe('spine fuzzing', () => {
  it('rejects malformed arbitrary payloads without crashing', async () => {
    await fc.assert(
      fc.asyncProperty(fc.anything(), async (value) => {
        try {
          validateSpine(value);
        } catch (error) {
          expect(error).toBeTruthy();
        }
      }),
      { numRuns: 100 },
    );
  });
});
