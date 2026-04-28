import { spawnSync } from 'node:child_process';

const result = spawnSync(process.execPath, ['scripts/benchmark-hda.mjs'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const lines = result.stdout.trim().split(/\r?\n/).slice(1);
const rows = lines.map((line) => {
  const [fixture, codec, inputMb, outputMb, ratio, compressMs] = line.split(',');
  return { fixture, codec, inputMb: Number(inputMb), outputMb: Number(outputMb), ratio: Number(ratio), compressMs: Number(compressMs) };
});

const isoNone = rows.find((row) => row.fixture === 'iso-random' && row.codec === 'none');
const isoDeflate = rows.find((row) => row.fixture === 'iso-random' && row.codec === 'deflate');
const folderZstd = rows.find((row) => row.fixture === 'folder-bundle' && row.codec === 'zstd');

if (!isoNone || !isoDeflate || !folderZstd) {
  throw new Error('Benchmark output missing expected fixtures.');
}

if (isoDeflate.compressMs <= isoNone.compressMs) {
  throw new Error('Regression check failed: incompressible ISO data should not favor deflate over none.');
}

if (folderZstd.ratio >= 0.08) {
  throw new Error(`Regression check failed: folder-bundle zstd ratio too high (${folderZstd.ratio}).`);
}

console.log(result.stdout.trim());
