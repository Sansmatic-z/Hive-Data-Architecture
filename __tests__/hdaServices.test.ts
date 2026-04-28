import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFromHDA } from '../services/hdaDecoder';
import { generateHDA } from '../services/hdaEncoder';
import { inspectHDA, verifyHDA } from '../services/hdaInspector';
import { listCheckpoints } from '../services/resumeStore';
import { HDA_FOOTER_SIZE } from '../lib/hdaProtocol';

describe('HDA service roundtrip', () => {
  beforeEach(() => {
    Reflect.deleteProperty(window, 'showSaveFilePicker');
  });

  it('cancels and resumes an encode operation in-session', async () => {
    const file = new File([new Uint8Array(20 * 1024 * 1024 + 1)], 'resume.txt', {
      type: 'text/plain',
    });
    const controller = new AbortController();

    await expect(
      generateHDA(
        file,
        null,
        (progress) => {
          if (progress.currentCell === 1 && progress.stage === 'processing') {
            controller.abort();
          }
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow('Operation cancelled.');

    const persisted = await listCheckpoints();
    expect(persisted.some((entry) => entry.fileName === 'resume.txt' && entry.mode === 'ENCODE')).toBe(true);

    const resumed = await generateHDA(file, null, vi.fn());
    expect(resumed).not.toBeNull();

    const archive = new File([resumed!.blob], 'resume.txt.hda.html', {
      type: 'text/html',
    });
    const decoded = await decodeFromHDA(archive, null, vi.fn());
    expect(decoded?.blob.size).toBe(file.size);
  });

  it('roundtrips an unencrypted file in fallback mode', async () => {
    const sourceFile = new File(['hello vault'], 'hello.txt', {
      type: 'text/plain',
    });

    const encoded = await generateHDA(sourceFile, null, vi.fn());

    expect(encoded).not.toBeNull();
    expect(encoded?.blob.size).toBeGreaterThan(0);

    const archive = new File([encoded!.blob], 'hello.txt.hda.html', {
      type: 'text/html',
    });

    const decoded = await decodeFromHDA(archive, null, vi.fn());

    expect(decoded).not.toBeNull();
    expect(decoded?.metadata.name).toBe('hello.txt');
    expect(await decoded?.blob.text()).toBe('hello vault');
  });

  it('uses a compact dynamic header for small archives', async () => {
    const sourceFile = new File(['small text payload'], 'small.txt', {
      type: 'text/plain',
    });

    const encoded = await generateHDA(sourceFile, null, vi.fn());
    expect(encoded).not.toBeNull();
    expect(encoded!.blob.size).toBeLessThan(128 * 1024);

    const footerView = new DataView(await encoded!.blob.slice(-HDA_FOOTER_SIZE).arrayBuffer());
    const binaryStart = Number(footerView.getBigUint64(0, true));
    expect(binaryStart).toBeGreaterThanOrEqual(32 * 1024);
    expect(binaryStart).toBeLessThan(128 * 1024);
  });

  it('roundtrips an encrypted file in fallback mode', async () => {
    const sourceFile = new File(['top secret payload'], 'secret.txt', {
      type: 'text/plain',
    });

    const encoded = await generateHDA(sourceFile, 'hunter2', vi.fn());

    expect(encoded).not.toBeNull();
    expect(encoded?.isEncrypted).toBe(true);

    const archive = new File([encoded!.blob], 'secret.txt.hda.html', {
      type: 'text/html',
    });

    await expect(decodeFromHDA(archive, null, vi.fn())).rejects.toThrow(
      'ENCRYPTED_VOLUME',
    );

    const decoded = await decodeFromHDA(archive, 'hunter2', vi.fn());

    expect(decoded).not.toBeNull();
    expect(decoded?.metadata.isEncrypted).toBe(true);
    expect(await decoded?.blob.text()).toBe('top secret payload');
  });

  it('uses non-compressed mode for iso payloads and still roundtrips', async () => {
    const sourceFile = new File(['iso-binary-payload'], 'disk.iso', {
      type: 'application/x-iso9660-image',
    });

    const encoded = await generateHDA(sourceFile, null, vi.fn());
    expect(encoded).not.toBeNull();

    const archiveText = await encoded!.blob.text();
    expect(archiveText).toContain('"compression":"none"');

    const archive = new File([encoded!.blob], 'disk.iso.hda.html', {
      type: 'text/html',
    });

    const decoded = await decodeFromHDA(archive, null, vi.fn());
    expect(await decoded?.blob.text()).toBe('iso-binary-payload');
  });

  it('inspects and verifies an archive without extraction', async () => {
    const sourceFile = new File(['verify me'], 'verify.txt', { type: 'text/plain' });
    const encoded = await generateHDA(sourceFile, 'hunter2', vi.fn(), {
      passwordHint: 'common vault key',
      archiveComment: 'release artifact',
      archiveTags: ['release', 'text'],
    });
    const archive = new File([encoded!.blob], 'verify.txt.hda.html', { type: 'text/html' });

    const inspected = await inspectHDA(archive);
    expect(inspected.inspection.filename).toBe('verify.txt');
    expect(inspected.inspection.signature?.algorithm).toBeTruthy();
    expect(inspected.inspection.passwordHint).toBe('common vault key');
    expect(inspected.inspection.comment).toBe('release artifact');

    const verified = await verifyHDA(archive, 'hunter2', vi.fn());
    expect(verified.metadata.name).toBe('verify.txt');
  });

  it('supports multi-recipient archives without breaking decode', async () => {
    const sourceFile = new File(['shared payload'], 'shared.txt', { type: 'text/plain' });
    const encoded = await generateHDA(sourceFile, null, vi.fn(), {
      recipients: [
        { label: 'ops', password: 'ops-secret' },
        { label: 'audit', password: 'audit-secret' },
      ],
      passwordHint: 'team secret',
    });
    const archive = new File([encoded!.blob], 'shared.txt.hda.html', { type: 'text/html' });

    const inspected = await inspectHDA(archive);
    expect(inspected.inspection.recipients?.length).toBe(2);

    const decoded = await decodeFromHDA(archive, 'audit-secret', vi.fn());
    expect(await decoded?.blob.text()).toBe('shared payload');
  });
});
