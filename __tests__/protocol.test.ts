import { describe, expect, it, vi } from 'vitest';
import { HDA_CONFIG } from '../config/hda';
import {
  assertMemoryFallbackSupported,
  escapeJSONForHTMLScript,
  getChecksum,
} from '../lib/hdaProtocol';

describe('hdaProtocol/escapeJSONForHTMLScript', () => {
  it('escapes script-breaking sequences without changing JSON semantics', () => {
    const escaped = escapeJSONForHTMLScript({
      filename: '</script><img src=x onerror=alert(1)>',
    });

    expect(escaped).not.toContain('</script>');
    expect(JSON.parse(escaped)).toEqual({
      filename: '</script><img src=x onerror=alert(1)>',
    });
  });
});

describe('hdaProtocol/getChecksum', () => {
  it('returns the configured checksum length', async () => {
    const checksum = await getChecksum(new TextEncoder().encode('payload').buffer);

    expect(checksum).toHaveLength(HDA_CONFIG.CHECKSUM_LENGTH);
    expect(checksum).toBe('abababababababab');
  });
});

describe('hdaProtocol/assertMemoryFallbackSupported', () => {
  it('allows oversized fallback payloads in top-level windows', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(() => assertMemoryFallbackSupported(HDA_CONFIG.MAX_FALLBACK_SIZE + 1)).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
