import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';

const decodeFromHDAMock = vi.fn();
const generateHDAMock = vi.fn();
const inspectHDAMock = vi.fn();

vi.mock('../services/hdaDecoder', () => ({
  decodeFromHDA: (...args: unknown[]) => decodeFromHDAMock(...args),
}));

vi.mock('../services/hdaEncoder', () => ({
  generateHDA: (...args: unknown[]) => generateHDAMock(...args),
}));

vi.mock('../services/hdaInspector', () => ({
  inspectHDA: (...args: unknown[]) => inspectHDAMock(...args),
  verifyHDA: vi.fn(),
}));

describe('App encrypted retry flow', () => {
  beforeEach(() => {
    decodeFromHDAMock.mockReset();
    generateHDAMock.mockReset();
    inspectHDAMock.mockReset();
  });

  it('clears progress after encrypted retry succeeds', async () => {
    decodeFromHDAMock
      .mockRejectedValueOnce(new Error('ENCRYPTED_VOLUME'))
      .mockResolvedValueOnce({
        blob: new Blob(['payload']),
        metadata: {
          name: 'secret.txt',
          type: 'text/plain',
          size: 7,
          timestamp: Date.now(),
          isEncrypted: true,
        },
      });
    inspectHDAMock.mockRejectedValueOnce(new Error('skip inspector'));

    const { container } = render(<App />);

    fireEvent.click(screen.getByText('UNPACK'));

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const archive = new File(['archive'], 'secret.hda.html', { type: 'text/html' });
    fireEvent.change(fileInput, { target: { files: [archive] } });

    await screen.findByText('Encrypted Hive');

    fireEvent.change(screen.getByPlaceholderText('Master Key...'), {
      target: { value: 'correct horse battery staple' },
    });
    fireEvent.click(screen.getByText('UNLOCK STREAM'));

    await screen.findByText('Payload Restored');
    await waitFor(() => {
      expect(screen.queryByText('Initializing...')).not.toBeInTheDocument();
    });
  });
});
