import { randomBytes, createHash, webcrypto } from "node:crypto";
import { performance } from "node:perf_hooks";
import { deflateSync, brotliCompressSync, zstdCompressSync } from "node:zlib";

const mib = 1024 * 1024;
const fixtures = [
  {
    name: "iso-random",
    kind: "binary",
    bytes: randomBytes(32 * mib),
  },
  {
    name: "zip-like",
    kind: "archive",
    bytes: Buffer.concat(Array.from({ length: 1024 }, (_, i) => Buffer.from(`PK${i.toString(16).padStart(6, "0")}--payload-block--`))),
  },
  {
    name: "video-like",
    kind: "media",
    bytes: Buffer.concat(Array.from({ length: 2048 }, () => randomBytes(8 * 1024))),
  },
  {
    name: "pdf-like",
    kind: "document",
    bytes: Buffer.from("%PDF-1.7\n" + "obj\nBT /F1 12 Tf 72 712 Td (HDA benchmark text stream) Tj ET\n".repeat(180000)),
  },
  {
    name: "folder-bundle",
    kind: "mixed",
    bytes: Buffer.from(
      Array.from({ length: 50000 }, (_, i) => `src/file-${i}.ts\nexport const value${i} = "HDA-${i}";\n`).join(""),
    ),
  },
];

const codecs = {
  none(input) {
    return input;
  },
  deflate(input) {
    return deflateSync(input);
  },
  brotli(input) {
    return brotliCompressSync(input);
  },
  zstd(input) {
    return zstdCompressSync(input);
  },
};

async function encrypt(buffer) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const keyMaterial = await webcrypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("benchmark-password"),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const key = await webcrypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: 600000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  return Buffer.from(await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, buffer));
}

function hash(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function measure(label, fn) {
  const start = performance.now();
  const result = fn();
  const durationMs = performance.now() - start;
  return { label, result, durationMs };
}

console.log("fixture,codec,input_mb,output_mb,ratio,compress_ms,encrypt_ms,sha256_prefix");
for (const fixture of fixtures) {
  for (const [codec, compress] of Object.entries(codecs)) {
    const compressed = measure(codec, () => compress(fixture.bytes));
    const encryptedStart = performance.now();
    const encryptedPayload = await encrypt(compressed.result);
    const encryptMs = performance.now() - encryptedStart;
    const ratio = compressed.result.length / fixture.bytes.length;
    console.log(
      [
        fixture.name,
        codec,
        (fixture.bytes.length / mib).toFixed(2),
        (compressed.result.length / mib).toFixed(2),
        ratio.toFixed(3),
        compressed.durationMs.toFixed(1),
        encryptMs.toFixed(1),
        hash(encryptedPayload).slice(0, 16),
      ].join(","),
    );
  }
}
