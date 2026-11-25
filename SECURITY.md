# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.3.x   | :white_check_mark: |
| < 0.3   | :x:                |

## Reporting a Vulnerability

Please do **not** open public GitHub issues for security vulnerabilities (such as XSS, CSP regressions, cross-origin isolation bypasses, or container/header issues).

Instead, report vulnerabilities privately via GitHub Security Advisories (**Security → Advisories → Report a vulnerability**) or email `zk@hexawulf.dev` with:

- A description of the vulnerability and its impact
- Reproduction steps or a minimal proof of concept
- Affected `py-scratchpad` version (shown in the About dialog) and browser version

You can expect an initial acknowledgement within 72 hours.

## Security Model

- **Client-side Pyodide execution:** Python code runs exclusively inside the user's browser in a dedicated Web Worker backed by self-hosted [Pyodide](https://pyodide.org) WebAssembly (CPython stdlib only — no `micropip`, no `loadPackage`, and no external CDN requests). There is **no server-side code execution**, no backend API, no user accounts, and no telemetry; buffers stay in browser `localStorage`.
- **Strict HTTP headers:** The nginx container serves static assets with a strict Content Security Policy (`default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`, `Cross-Origin-Resource-Policy: same-origin`, and `Cache-Control: no-transform`.
- **Container & supply-chain hardening:** Production releases run a read-only root filesystem in Docker Compose, build reproducible multi-arch (`linux/amd64`, `linux/arm64`) images with SBOM and provenance attestations, and pass a Trivy vulnerability gate that blocks publication on fixable `CRITICAL` CVEs.
