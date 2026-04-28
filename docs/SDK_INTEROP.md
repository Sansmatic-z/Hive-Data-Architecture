# HDA Interoperability Notes

## Archive Extensions
- Primary archive: `.hda.html`
- Split volumes: `.partNNN.hda`

## Footer
- 16 bytes, little-endian
- `uint64` binary payload start
- `uint32` magic `0x48444121`
- `uint32` protocol version

## Spine Embedding
- Stored in:
  `<script id="spine-node" type="application/hda-spine">...</script>`
- JSON must be parsed and validated before use

## Required Spine Fields
- `version`
- `total_bytes`
- `cell_count`
- `compression`
- `encryption`
- `cells[]`
- `filename`
- `mimeType`

## Optional Protocol-v4 Fields
- `signature`
- `kdf`
- `compatibility`
- `redundancy`
- `split`
- `creatorApp`
- `createdAt`
- `sourceHash`
- `tags`

## Cell Semantics
- `offset` points to the payload byte position
- `length` is the original plaintext cell size
- `compressed_length` is the stored byte size
- `checksum` is the first 16 hex chars of SHA-256 over the compressed plaintext cell content before encryption
- encrypted cells are packed as:
  `[salt:16][iv:12][ciphertext+tag]`

## Codec Notes
- Supported manifest values: `none`, `deflate`, `brotli`, `zstd`
- App path supports all four values with runtime capability checks
- Self-extracting HTML currently requires browser-native support for `deflate`, `brotli`, and `zstd`; `Argon2id` archives should be opened in the app

## KDF Notes
- Default: `PBKDF2-SHA256`
- Optional hardened mode: `Argon2id`

## Future SDK Guidance
- Prefer validating `compatibility.supportedReaders`
- Verify `signature` before decoding cells
- Reject overlapping or out-of-bounds cell offsets
- Preserve unknown manifest fields during transforms when possible
