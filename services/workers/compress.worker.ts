import { zlibSync } from 'fflate';

async function getChecksum(data: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 16);
}

self.onmessage = async (e: MessageEvent) => {
  let cellId = '';
  try {
    cellId = e.data.cellId;
    const chunk = e.data.chunk;
    
    const compressed = zlibSync(new Uint8Array(chunk), { level: 6 });
    const hash = await getChecksum(compressed.buffer);
    
    (self as unknown as Worker).postMessage({ cellId, compressed: compressed.buffer, hash }, [compressed.buffer]);
  } catch (err: any) {
    (self as unknown as Worker).postMessage({ cellId, error: err.message });
  }
};
