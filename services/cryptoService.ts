/**
 * HDA Cryptographic Service
 * Uses Web Crypto API for high-performance, secure data transformation.
 */

import { createLogger } from '../lib/logger';
import { HDA_CONFIG } from '../config/hda';
import { HDAKdf, HDARecipientManifest } from '../types';

const logger = createLogger('cryptoService');
const runtimeCrypto = globalThis.crypto;

let argon2ModulePromise: Promise<typeof import('hash-wasm')> | null = null;

async function getArgon2Module() {
  if (!argon2ModulePromise) {
    argon2ModulePromise = import('hash-wasm');
  }
  return argon2ModulePromise;
}

export async function selectKdf(preferred: HDAKdf['algorithm'] = 'PBKDF2-SHA256'): Promise<HDAKdf> {
  if (preferred === 'Argon2id') {
    return {
      algorithm: 'Argon2id',
      iterations: 3,
      memorySize: 64 * 1024,
      parallelism: 1,
      hashLength: 32,
    };
  }

  return {
    algorithm: 'PBKDF2-SHA256',
    iterations: HDA_CONFIG.PBKDF2_ITERATIONS,
    hashLength: 32,
  };
}

async function deriveArgon2Material(password: string, salt: Uint8Array, kdf: HDAKdf): Promise<ArrayBuffer> {
  const { argon2id } = await getArgon2Module();
  const output = await argon2id({
    password: password.normalize('NFKC'),
    salt,
    iterations: kdf.iterations ?? 3,
    memorySize: kdf.memorySize ?? 64 * 1024,
    parallelism: kdf.parallelism ?? 1,
    hashLength: kdf.hashLength,
    outputType: 'binary',
  });

  return (output as Uint8Array).buffer.slice(0);
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export const deriveKey = async (
  password: string,
  salt: Uint8Array,
  kdf: HDAKdf = {
    algorithm: 'PBKDF2-SHA256',
    iterations: HDA_CONFIG.PBKDF2_ITERATIONS,
    hashLength: 32,
  },
): Promise<CryptoKey> => {
  logger.debug(`Deriving key with ${kdf.algorithm}`, {
    iterations: kdf.iterations,
    saltLength: salt.length,
    memorySize: kdf.memorySize,
  });

  const normalizedPassword = password.normalize('NFKC');

  if (kdf.algorithm === 'Argon2id') {
    const rawKey = await deriveArgon2Material(normalizedPassword, salt, kdf);
    return runtimeCrypto.subtle.importKey(
      'raw',
      rawKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  const enc = new TextEncoder();
  const keyMaterial = await runtimeCrypto.subtle.importKey(
    'raw',
    enc.encode(normalizedPassword),
    'PBKDF2',
    false,
    ['deriveBits', 'deriveKey']
  );

  const key = await runtimeCrypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: kdf.iterations ?? HDA_CONFIG.PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );

  logger.debug('Key derived successfully');
  return key;
};

export const encryptData = async (data: ArrayBuffer, key: CryptoKey, iv: Uint8Array): Promise<ArrayBuffer> => {
  logger.debug('Encrypting data with AES-256-GCM', { ivLength: iv.length, dataLength: data.byteLength });

  const encrypted = await runtimeCrypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    data
  );

  logger.debug('Encryption complete');
  return encrypted;
};

export const decryptData = async (data: ArrayBuffer, key: CryptoKey, iv: Uint8Array): Promise<ArrayBuffer> => {
  logger.debug('Decrypting data with AES-256-GCM', { ivLength: iv.length, dataLength: data.byteLength });

  try {
    const decrypted = await runtimeCrypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      data
    );

    logger.debug('Decryption complete');
    return decrypted;
  } catch (error) {
    logger.error('Decryption failed - invalid key or corrupted data', { error });
    throw new Error('Decryption failed. Invalid password or corrupted archive.');
  }
};

export async function wrapSharedPasswordForRecipient(
  sharedPassword: string,
  recipientPassword: string,
  recipientLabel: string,
  preferredKdf: HDAKdf['algorithm'] = 'PBKDF2-SHA256',
): Promise<HDARecipientManifest> {
  const kdf = await selectKdf(preferredKdf);
  const salt = runtimeCrypto.getRandomValues(new Uint8Array(HDA_CONFIG.SALT_SIZE));
  const iv = runtimeCrypto.getRandomValues(new Uint8Array(HDA_CONFIG.IV_SIZE));
  const key = await deriveKey(recipientPassword, salt, kdf);
  const wrapped = await encryptData(new TextEncoder().encode(sharedPassword).buffer, key, iv);

  return {
    label: recipientLabel,
    algorithm: 'aes-256-gcm',
    kdf,
    salt: encodeBase64(salt),
    iv: encodeBase64(iv),
    wrappedPassword: encodeBase64(new Uint8Array(wrapped)),
  };
}

export async function unwrapSharedPasswordForRecipient(
  password: string,
  recipients: HDARecipientManifest[],
): Promise<string | null> {
  for (const recipient of recipients) {
    try {
      const salt = decodeBase64(recipient.salt);
      const iv = decodeBase64(recipient.iv);
      const wrapped = decodeBase64(recipient.wrappedPassword);
      const key = await deriveKey(password, salt, recipient.kdf);
      const plain = await decryptData(wrapped.buffer.slice(wrapped.byteOffset, wrapped.byteOffset + wrapped.byteLength), key, iv);
      return new TextDecoder().decode(plain);
    } catch {
      continue;
    }
  }

  return null;
}
