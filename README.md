# HDA VAULT (Hive Data Architecture)

<div align="center">
  <img src="https://img.shields.io/badge/License-PolyForm_Noncommercial-gold?style=for-the-badge" alt="License">
  <img src="https://img.shields.io/badge/Protected_By-Raj_Mitra-blue?style=for-the-badge" alt="Creator">
  <img src="https://img.shields.io/badge/Protocol-HDA_v4.0-emerald?style=for-the-badge" alt="Protocol">
  <img src="https://img.shields.io/badge/Security-AES--256--GCM-red?style=for-the-badge" alt="Security">
  <img src="https://img.shields.io/badge/TypeScript-Strict-blue?style=for-the-badge" alt="TypeScript Strict">
  <img src="https://img.shields.io/badge/Tests-Vitest-green?style=for-the-badge" alt="Tests">
</div>

<br />

A production-grade, client-side file encoding/decoding application that packages files into self-extracting HTML archives (`.hda.html` format). Data is treated as a structured "Virtual Book" using compressed cell chunks with SHA-256 integrity verification and optional AES-256-GCM encryption.

## Table of Contents

- [Features](#features)
- [Security & Integrity](#security--integrity)
- [Quick Start](#quick-start)
- [Development](#development)
- [Testing](#testing)
- [Building for Production](#building-for-production)
- [Docker Deployment](#docker-deployment)
- [CI/CD Pipeline](#cicd-pipeline)
- [Environment Configuration](#environment-configuration)
- [Architecture Overview](#architecture-overview)
- [HDA Protocol Specification](#hda-protocol-specification)
- [Contributing](#contributing)
- [License](#license)
- [Commercial Licensing](#commercial-licensing--inquiries)

---

## Features

- **Modern Archive Security**: AES-256-GCM encryption with Ed25519 signing and optional Argon2id hardening
- **Recipient Access Control**: Optional multi-recipient unlock envelopes without changing the base cell format
- **SHA-256 Integrity Verification**: Every cell is checksummed before storage and verified on extraction
- **Streaming Architecture**: File System Access API for direct-to-disk streaming (handles multi-GB files without memory limits)
- **Parallel Processing**: Auto-scales to hardware concurrency with batched cell processing
- **Self-Extracting Archives**: Generated `.hda.html` files contain everything needed to extract the original file — no app required
- **Compatibility Paths**: Progressive enhancement for Safari/Firefox and browsers without File System Access API
- **Offline/PWA Ready**: Installable web app with service-worker asset caching
- **Desktop + CLI Companions**: Electron wrapper scaffold and Node CLI inspector/verifier
- **Inspector + Preview**: Archive metadata inspection, integrity test mode, folder manifest search, and safe preview for supported unencrypted assets
- **Operations Ready**: Tagged release artifacts, build metadata, Docker smoke CI, changelog + migration notes, opt-in diagnostics
- **XSS-Safe HTML Generation**: Comprehensive input sanitization prevents injection attacks in generated archives
- **Type-Safe Codebase**: Full TypeScript strict mode with zero `any` types in critical paths
- **Comprehensive Testing**: Vitest test suite with unit + integration tests (target: 70%+ coverage)
- **Production-Ready Deployment**: Docker multi-stage build, nginx config, GitHub Actions CI/CD

---

## Security & Integrity

### Encryption
| Algorithm | Purpose | Parameters |
|-----------|---------|------------|
| **PBKDF2-SHA256** | Key derivation | 600,000 iterations, 16-byte salt per cell |
| **AES-256-GCM** | Data encryption | 12-byte IV per cell, 16-byte auth tag |
| **SHA-256** | Integrity verification | First 16 hex chars stored per cell |

### Security Hardening
- All user-provided input (filenames, metadata) is sanitized via comprehensive HTML entity encoding before embedding in generated archives
- Input validation via Zod schemas rejects malicious filenames, oversized files, and malformed data
- Docker containers run as non-root user
- nginx security headers: X-Frame-Options, CSP, X-Content-Type-Options, Referrer-Policy
- No secrets, keys, or credentials are ever stored or transmitted

### What Stays Local
- **Encryption keys**: Derived locally, never transmitted
- **File contents**: Processed entirely in-browser
- **Passphrases**: Never leave the user's device

---

## Quick Start

### Prerequisites
- **Node.js** 20+ (22 LTS recommended)
- **npm** 10+
- A modern browser (Chrome/Edge recommended for File System Access API)

### 1. Clone the repository
```bash
git clone <repository-url>
cd hda-vault
```

### 2. Install dependencies
```bash
npm install
```

### 3. Start the development server
```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## Development

### Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start Vite dev server with HMR on port 3000 |
| `npm run build` | Production build (optimized, minified) |
| `npm run preview` | Preview production build locally |
| `npm run test` | Run tests in watch mode |
| `npm run test:run` | Run tests once (CI mode) |
| `npm run test:coverage` | Run tests with coverage report |
| `npm run test:ui` | Run tests with Vitest UI |
| `npm run test:e2e` | Run Playwright browser tests |
| `npm run benchmark:check` | Run performance regression benchmark checks |
| `npm run docker:smoke` | Build and smoke-test the Docker image |
| `node cli/hda-cli.mjs inspect <archive>` | Inspect an HDA archive from the command line |
| `node cli/hda-cli.mjs verify <archive>` | Run structural verification from the command line |

### Project Structure

```
├── App.tsx                    # Root React component (with Error Boundary)
├── index.tsx                  # React entry point
├── index.css                  # Global styles + Tailwind
├── index.html                 # HTML entry point
├── types.ts                   # Shared TypeScript interfaces
├── vite.config.ts             # Vite configuration
├── vitest.config.ts           # Vitest test configuration
├── tsconfig.json              # TypeScript strict mode config
├── package.json               # Dependencies + scripts
│
├── config/
│   └── hda.ts                 # Centralized HDA protocol constants
│
├── lib/
│   ├── utils.ts               # Utility functions (cn, formatBytes)
│   ├── logger.ts              # Structured logging framework
│   └── validators.ts          # Zod input validation schemas
│
├── services/
│   ├── cryptoService.ts       # Web Crypto API wrapper (PBKDF2 + AES-GCM)
│   ├── hdaEncoder.ts          # File → HDA HTML encoder
│   └── hdaDecoder.ts          # HDA HTML → original file decoder
│
├── __tests__/
│   ├── setup.ts               # Test environment setup + mocks
│   ├── utils.test.ts          # Utility function tests
│   └── validators.test.ts     # Input validation tests
│
├── .github/workflows/
│   └── ci.yml                 # GitHub Actions CI/CD pipeline
│
├── Dockerfile                 # Multi-stage Docker build
├── docker-compose.yml         # Docker Compose (dev + prod)
├── nginx.conf                 # Production nginx config with security headers
└── .env.example               # Environment variable template
```

### Coding Standards

- **TypeScript strict mode** — no `any` types in critical paths
- **SOLID principles** — single responsibility, dependency injection via service modules
- **Zero side-effects** — pure functions where possible, explicit mutation points
- **Input validation at boundaries** — Zod schemas for all external input
- **Structured logging** — contextual, leveled logs via `lib/logger.ts`

---

## Testing

### Run the full test suite
```bash
npm run test:run
```

### Run with coverage
```bash
npm run test:coverage
```

Coverage reports are generated in `coverage/` directory (HTML format).

### Test Categories
- **Unit tests**: Utility functions, validators, logger
- **Integration tests**: Encode/decode roundtrip + embedded self-extractor coverage
- **Property tests**: Arbitrary roundtrip invariants with `fast-check`
- **Fuzz tests**: Malformed manifest validation hardening
- **Browser E2E tests**: Create, decrypt, corrupt archive, fallback mode, cancel/retry

### Coverage Thresholds
| Metric | Minimum |
|--------|---------|
| Lines | 70% |
| Branches | 60% |
| Functions | 70% |
| Statements | 70% |

---

## Building for Production

```bash
npm run build
```

Output is written to `dist/` directory. Preview it locally:

```bash
npm run preview
```

---

## Docker Deployment

### Build the image
```bash
docker build -t hda-vault:latest .
```

### Run with Docker
```bash
docker run -d -p 8080:8080 --name hda-vault hda-vault:latest
```

Open [http://localhost:8080](http://localhost:8080).

### Run with Docker Compose

**Development (with hot reload):**
```bash
docker compose --profile dev up
```

**Production:**
```bash
docker compose --profile prod up -d
```

**Preview pre-built dist/:**
```bash
npm run build
docker compose --profile preview up
```

### Docker Image Characteristics
| Property | Value |
|----------|-------|
| Base image | `nginx:1.27-alpine-slim` |
| Final size | ~20 MB |
| User | `nginx` (non-root) |
| Health check | HTTP GET `/` every 30s |
| Security headers | CSP, X-Frame-Options, X-Content-Type-Options |

---

## CI/CD Pipeline

The project includes a GitHub Actions workflow (`.github/workflows/ci.yml`) that runs on every push and PR:

### Pipeline Stages
1. **Lint & Type Check** — TypeScript strict compilation + production build
2. **Tests** — Vitest test suite with coverage upload
3. **Docker Build** — Multi-stage Docker build with cache
4. **Smoke Test** — Verify container serves HTTP 200
5. **Release Artifacts** — Tagged builds publish web and Docker artifacts

### Tagged Releases
- Push a tag like `v4.0.0`
- GitHub Actions builds `dist/`, packages the static web artifact, exports the Docker image tarball, and attaches both to the GitHub release

### Enabling the Workflow
1. Push to `main` or `develop` branch
2. Create a PR to trigger the pipeline
3. Configure deployment environment in GitHub Settings → Environments → `production`

---

## Environment Configuration

### Using .env (optional)

```bash
cp .env.example .env
```

All variables have sensible defaults. Most users don't need to change anything.

### Available Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_CELL_SIZE` | `52428800` (50MB) | Chunk size for cell processing |
| `VITE_HEADER_SIZE` | `2097152` (2MB) | Maximum header reserve for large HDA files |
| `VITE_MIN_HEADER_SIZE` | `32768` (32KB) | Minimum dynamic header reserve for small HDA files |
| `VITE_PBKDF2_ITERATIONS` | `600000` | PBKDF2 key derivation iterations |
| `VITE_MAX_FALLBACK_SIZE` | `2147483648` (2GB) | Advisory fallback-memory threshold; top-level windows may continue above it |
| `VITE_GIT_SHA` | `dev` | Optional build trace override for release builds |
| `VITE_TELEMETRY_ENDPOINT` | unset | Optional opt-in diagnostics log endpoint |
| `VITE_ERROR_REPORT_ENDPOINT` | unset | Optional opt-in client crash/error endpoint |

---

## Architecture Overview

### Encoding Flow
```
Input File
  │
  ├─ Validate (Zod schema)
  │
  ├─ Split into 50MB cells
  │   │
  │   ├─ Compress (Deflate)
  │   │
  │   ├─ Checksum (SHA-256 → first 16 hex chars)
  │   │
  │   └─ Encrypt (AES-256-GCM, if password provided)
  │
  ├─ Build Spine (JSON metadata)
  │
  ├─ Generate self-extracting HTML
  │   ├─ Sanitize all user input (XSS prevention)
  │   ├─ Embed spine in <script type="application/hda-spine">
  │   └─ Inline decoder UI + JS logic
  │
  ├─ Reserve dynamic header size
  │   └─ small files use a compact wrapper instead of a fixed multi-MB reserve
  │
  ├─ Write binary footer (magic + offset + version)
  │
  └─ Output: .hda.html file
```

### Decoding Flow
```
.hda.html File
  │
  ├─ Parse footer (magic, offset, version)
  │
  ├─ Extract spine (JSON from <script> tag)
  │   └─ Validate spine schema (Zod)
  │
  ├─ For each cell (parallel batch processing):
  │   ├─ Read compressed chunk
  │   ├─ Decrypt (if encrypted, using PBKDF2-derived key)
  │   ├─ Verify checksum (SHA-256 match)
  │   └─ Decompress (Deflate)
  │
  └─ Reconstruct original file
```

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **50MB cell size** | Balances parallelism overhead with memory efficiency for multi-GB files |
| **PBKDF2 600K iterations** | OWASP 2024 recommendation for SHA-256-based KDF |
| **SHA-256 on compressed data** | Verifies integrity before decryption attempt (fail-fast) |
| **File System Access API** | Avoids browser memory limits for large files |
| **Self-extracting HTML** | Zero dependencies for archive extraction — works in any browser |

---

## HDA Protocol Specification

### Version: 4.0 (internal: 10)

### Binary Layout
```
[HTML Header + Spine: dynamically padded]
[Cell 0: compressed + encrypted]
[Cell 1: compressed + encrypted]
...
[Cell N: compressed + encrypted]
[Footer: 16 bytes]
```

### Footer Structure (16 bytes)
| Offset | Size | Type | Description |
|--------|------|------|-------------|
| 0 | 8 | uint64 LE | Offset to first cell (binary data start) |
| 8 | 4 | uint32 LE | Magic number: `0x48444121` ("HDA!") |
| 12 | 4 | uint32 LE | Protocol version: `9` |

### Spine Schema
```typescript
{
  version: number;              // Internal protocol version
  total_bytes: number;          // Original file size in bytes
  cell_count: number;           // Number of cells
  compression: 'deflate';       // Compression algorithm
  encryption: 'aes-256-gcm' | null;
  cells: Array<{
    id: string;                 // Cell identifier (e.g., "C000")
    type: 'html' | 'binary' | 'hive';
    offset: number;             // Byte offset in file
    length: number;             // Original uncompressed size
    compressed_length: number;  // Size after compression + encryption
    checksum: string;           // SHA-256 first 16 hex chars
  }>;
  filename: string;             // Original filename
  mimeType: string;             // MIME type for reconstruction
}
```

### Cell Packing Format (encrypted)
```
[Salt: 16 bytes][IV: 12 bytes][AES-GCM encrypted data + 16-byte auth tag]
```

---

## Created By
**Raj Mitra** - Lead Architect & Creator

## Copyright & Licensing
This project is protected under a multi-layered licensing framework:
1. **Software**: [PolyForm Noncommercial 1.0.0](LICENSE) (Source Available).
2. **Architecture & Documentation**: [CC BY-NC-ND 4.0](https://creativecommons.org/licenses/by-nc-nd/4.0/) (Attribution Required).

**Summary**: You are free to view, test, and use this for personal projects. You **must** give credit to Raj Mitra. You **cannot** sell this or use it for commercial profit without a private license.

## Attribution
If you use HDA Vault in your research or projects, please provide proper credit.
- **Citation**: See `CITATION.cff` for the recommended citation format.
- **Copyright**: Copyright © 2026 Raj Mitra. All rights reserved.

## Contributing
Please see `CONTRIBUTING.md` for our Contributor License Agreement (CLA) before submitting any changes.

## Security Reporting
To report vulnerabilities privately, please see `SECURITY.md`.

## Commercial Licensing & Inquiries
The **HDA Protocol** and **Hive Data Architecture** are proprietary innovations by Raj Mitra.

If you are a commercial entity interested in:
- Integrating HDA Vault into a production system.
- Obtaining a commercial-use license for the HDA Protocol.
- Commissioning custom features or enterprise support.

Please reach out to **Raj Mitra** directly at **r.8981718053@gmail.com**.
