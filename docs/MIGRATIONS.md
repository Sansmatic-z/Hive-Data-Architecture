# Migration Notes

## Upgrading To 4.0.0

- Protocol v4 archives keep the same footer layout and keep v3 decode compatibility in the app.
- New manifests may include:
  - `passwordHint`
  - `integrityOnly`
  - `folderManifest`
  - `recipients`
  - richer compatibility / signing / KDF metadata

## Reader Expectations

- Readers must continue validating footer magic, version range, and the embedded manifest before decode.
- If `recipients` is present, readers should unwrap the shared archive password with one of the recipient entries before cell decode.
- If `integrityOnly` is true, readers should not require a password and should treat the archive as public-verification-safe.

## Standalone HTML Caveats

- Standalone extraction remains available for standard PBKDF2 single-password archives.
- Multi-recipient and Argon2id archives require the full HDA app path until standalone support expands.
