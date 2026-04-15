
/**
 * HDA Cryptographic Service
 * Uses Web Crypto API for high-performance, secure data transformation.
 */

export const deriveKey = async (password: string, salt: Uint8Array): Promise<CryptoKey> => {
  const enc = new TextEncoder();
  const keyMaterial = await window.crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveBits', 'deriveKey']
  );

  return window.crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: 600000,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
};

export const encryptData = async (data: ArrayBuffer, key: CryptoKey, iv: Uint8Array): Promise<ArrayBuffer> => {
  return window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    data
  );
};

export const decryptData = async (data: ArrayBuffer, key: CryptoKey, iv: Uint8Array): Promise<ArrayBuffer> => {
  return window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    data
  );
};
