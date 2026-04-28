# Changelog

## 4.0.0 - 2026-04-27

- Promoted the app to protocol v4 with per-cell codecs, signing, richer metadata, redundancy, split volumes, persistent resume, and worker-backed processing.
- Added preview, archive inspection, integrity-test mode, folder manifest search, password hints, and multi-recipient manifest envelopes.
- Added PWA packaging, Electron/CLI companions, SDK exports, E2E/property/fuzz coverage, benchmark regression checks, Docker smoke validation, telemetry hooks, and tagged release artifacts.

## 3.x Compatibility

- Protocol v3 archives remain readable.
- New v4 fields are additive; older readers may ignore metadata such as `passwordHint`, `folderManifest`, and `recipients`.
