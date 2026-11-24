# Changelog

All notable changes to `py-scratchpad` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.11] - 2026-11-25

### Changed

- Internal: the Reload path reuses `adoptSettings()` instead of repeating the theme, font-size and run-mode lines, and three no-op `clampFontSize` calls are gone (`load()` and `parseState()` already clamp). No behavior change (#7).
- README screenshots and `og-image` retaken for 0.3.10 now ship in the image (`33b5782`).

### Added

- Storage test that pins font-size clamping on load (#7).

## [0.3.10] - 2026-11-23

### Changed

- UI accent palette and favicon moved to 0xWulf teal (`#14B8A6` dark / `#0D9488` light) (`dac3766`).
- **Run** is now the one filled button, so the page has a visible primary action (light theme fill `#0F766E`, so white text clears 4.5:1).
- Dark theme: stderr and tracebacks use `#F38BA8`, so they no longer read as ordinary output.
- About dialog: the Runtime row has the same size and spacing as the other rows.

### Removed

- Unused runner and protocol surface: `RUN_MODES`, the ignored worker `truncated` message, and `RunnerHandle.endInput` / `.info`.

### Fixed

- Docs: stale base-image and Pyodide versions in `docs/DOCKERHUB.md`, and stale "the deploy host is not a git checkout" notes in `docs/DEPLOY.md`.

## [0.3.9] - 2026-11-22

### Changed

- Runtime: Pyodide 314.0.7 → 314.0.8, `@codemirror/view` 6.43.14 → 6.43.15 (Dependabot #4).
- Dev tooling: vite 8.3.8, vitest 5.1.1, eslint 10.15.0, typescript-eslint 8.73.0, Playwright 1.65.1, globals 17.14.0 (#4); `@types/node` 26.6.6 (#6).
- CI: GitHub Actions group updated (#3).

## [0.3.8] - 2026-11-21

### Security

- Rebuilt runtime image on `nginx:1.30.7-alpine3.24` (from `1.30.6`), clearing four fixable `CRITICAL` nginx CVEs (`CVE-2026-113425`, `CVE-2026-121810`, `CVE-2026-123007`, `CVE-2026-123633`) and two fixable `HIGH` (`CVE-2026-118899`, `CVE-2026-123634`).

### Changed

- Includes the 0.3.7 About dialog change below.

## [0.3.7] - 2026-11-21 [NOT PUBLISHED]

Tagged, but the release Trivy gate blocked publication on the nginx CVEs fixed in 0.3.8. No image exists for this version.

### Changed

- About dialog: renamed the **Contact** section to **Developer** and set the attribution to `Erling Wulf Weinreich (0xWulf) · dev@0xwulf.dev`, matching the other HexaWulf apps.

## [0.3.6] - 2026-11-16

### Security

- Rebuilt runtime image on `nginx:1.30.6-alpine3.24` (from `1.30.5`) with `apk upgrade --no-cache`, clearing 79 Alpine CVEs including fixable `CRITICAL` `brotli-libs` (`CVE-2026-111497`) and 21 fixable `HIGH` findings.
- Added a Trivy image scan gate to `.github/workflows/release.yml` using a digest-pinned `aquasec/trivy:0.76.1` image, blocking publication on fixable `CRITICAL` findings and uploading SARIF results to the GitHub Security tab.

## [0.3.5] - 2026-11-13

### Fixed

- **Stale Stop interrupt byte:** cleared the `SharedArrayBuffer` interrupt flag on dispatch, run completion, and worker restart so a forced stop no longer breaks subsequent runs or leaves Python stuck in `failed to load`.
- **Two-tab false conflicts:** compared only file name, text, line ending, and BOM across storage events so caret moves and theme/font changes no longer pause autosave in other tabs or arm the leave-site prompt.
- **Held-back output:** flushed the first 32 worker stdout writes per 50 ms window immediately instead of holding short bursts until the next write.
- **Forward-compatible storage handling:** preserved payloads written by a newer schema version as read-only instead of treating them as corrupt, requiring explicit confirmation (`Save here anyway`) before overwriting and capping de-duplicated backups at 5.

## [0.3.4] - 2026-10-10

### Added

- SEO metadata (`py-scratchpad.com` canonical URL, Open Graph and Twitter Card tags, `1200x630` `og-image.png`, `WebApplication` JSON-LD, `robots.txt`, and `sitemap.xml`).
- Docker Hub version, pulls, and license badges in `README.md`, plus host-independent round-trip fixture verification instructions.

## [0.3.3] - 2026-10-10

### Fixed

- Consecutive `input()` prompts no longer concatenate earlier prompt text; extracted `createPromptTracker()` in `src/output.ts` to consume each prompt tail before dispatching stdin across both `SharedArrayBuffer` and fallback modes.

### Changed

- Updated `README.md` and `docs/DOCKERHUB.md` for `0.3.2` and added automated Playwright screenshot capture (`scripts/screenshots.ts`).

## [0.3.2] - 2026-10-09

### Security

- Added `Cache-Control: no-transform` to every nginx location block so intermediaries (such as Cloudflare Web Analytics auto-injection) cannot rewrite served HTML or assets, verified in both unit tests and `scripts/e2e-image.sh`.

## [0.3.1] - 2026-10-09

### Fixed

- Configured explicit nginx MIME types for `.mjs` (`text/javascript`) and extensionless `LICENSE` (`text/plain`) so browsers execute dynamically imported `pyodide.mjs` and `pyodide.asm.mjs` modules in production containers.

### Added

- End-to-end Docker image test script (`npm run test:e2e:image` / `scripts/e2e-image.sh`) verifying Content-Types and Playwright smoke tests against the real read-only nginx container.

## [0.3.0] - 2026-10-09

### Added

- **Client-side Python execution (Run button):** lazy-loaded Pyodide `314.0.7` (CPython `3.14.2` stdlib only, self-hosted under `/pyodide/<version>/`) running inside a module Web Worker with no CDN or backend calls.
- **REPL echo and Script modes** (persisted via storage schema v3) with pre-execution compilation, fresh per-run namespaces, and **Restart Python**.
- **Clean tracebacks** stripping runtime frames with clickable `File "...", line N` jump links and friendly messages for unsupported GUI/third-party imports (`tkinter`, `turtle`, etc.).
- **Stop & inline `input()`:** `SharedArrayBuffer` SIGINT interrupt (with 500 ms worker-termination fallback) and synchronous inline `input()` via `Atomics.wait` under COOP/COEP cross-origin isolation (plus a fallback Program input box).
- **Output batching & caps:** worker-side output coalescing with animation-frame appends and 1,000,000-character / 10,000-line safety caps.
- **Reproducible builds:** build date derived from `SOURCE_DATE_EPOCH` / last commit timestamp so identical commits produce byte-identical bundles.
- Public `py-scratchpad.com` nginx vhost configuration (`docs/nginx/py-scratchpad.com`) and dismissible migration notice on `python.piapps.dev`.

## [0.1.2] - 2026-10-09

### Fixed

- Added global `[hidden] { display: none !important }` guard so the conflict notice bar remains hidden on initial paint.
- Replaced the `ⓘ` glyph with a centred inline SVG About icon and symmetric toolbar gutters, backed by stylesheet unit assertions.

## [0.1.1] - 2026-10-09

### Added

- Modal About `<dialog>` showing build version and UTC month, live dependency versions injected from `package.json`, project links, and a copyable diagnostics line (excluding buffer contents and filenames).

## [0.1.0] - 2026-10-09

### Added

- Initial Vite + TypeScript + CodeMirror 6 Python scratchpad with 4-space tab indentation, dark/light themes, adjustable font size, and debounced `localStorage` autosave with corrupt-payload backups.
- Byte-exact UTF-8 file import/export (Open, drag-and-drop, Download, `Ctrl+S`/`Cmd+S`) preserving CRLF/LF line endings, UTF-8 BOM, tabs, and missing trailing newlines, plus a multi-tab edit conflict guard.
- Multi-stage `node`/`nginx` Docker image with strict CSP, security headers, read-only rootfs Docker Compose configuration, and multi-arch (`linux/amd64`, `linux/arm64`) GitHub Actions CI and release workflows with SHA-pinned actions, SBOM, and provenance attestations.
- MIT license and Docker Hub overview documentation.

[0.3.11]: https://github.com/hexawulf/py-scratchpad/compare/v0.3.10...v0.3.11
[0.3.10]: https://github.com/hexawulf/py-scratchpad/compare/v0.3.9...v0.3.10
[0.3.9]: https://github.com/hexawulf/py-scratchpad/compare/v0.3.8...v0.3.9
[0.3.8]: https://github.com/hexawulf/py-scratchpad/compare/v0.3.7...v0.3.8
[0.3.7]: https://github.com/hexawulf/py-scratchpad/compare/v0.3.6...v0.3.7
[0.3.6]: https://github.com/hexawulf/py-scratchpad/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/hexawulf/py-scratchpad/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/hexawulf/py-scratchpad/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/hexawulf/py-scratchpad/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/hexawulf/py-scratchpad/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/hexawulf/py-scratchpad/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/hexawulf/py-scratchpad/compare/v0.1.2...v0.3.0
[0.1.2]: https://github.com/hexawulf/py-scratchpad/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/hexawulf/py-scratchpad/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/hexawulf/py-scratchpad/releases/tag/v0.1.0
