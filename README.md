# py-scratchpad

[![CI](https://github.com/hexawulf/py-scratchpad/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/hexawulf/py-scratchpad/actions/workflows/ci.yml)
[![Docker Hub version](https://img.shields.io/docker/v/0xwulf/py-scratchpad?sort=semver&label=docker)](https://hub.docker.com/r/0xwulf/py-scratchpad)
[![Docker Hub pulls](https://img.shields.io/docker/pulls/0xwulf/py-scratchpad)](https://hub.docker.com/r/0xwulf/py-scratchpad)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

A browser-only Python scratchpad: a small editor to keep open next to a course video, with
syntax highlighting, autosave, byte-exact import/export, and a **Run** button that runs real
CPython in the tab through [Pyodide](https://pyodide.org). Everything stays in the browser —
no backend, no accounts, no login, no data on the server. Your code is never uploaded because
there is nothing to upload it to: the deployed site is static files behind nginx, and the
Python interpreter is WebAssembly served from the same origin.

**Live at <https://py-scratchpad.com>** (`www` redirects to the apex). The current release is
**0.3.3**.

![The py-scratchpad editor on its dark theme, filename hello.py, in REPL echo mode. The buffer
holds bare arithmetic expressions, a celsius() function and a for loop; the output panel below
reports "Done in 2 ms" and shows the echoed values 610, 3.5, 3 and 1024 followed by the loop's
printed lines.](docs/screenshots/run-dark.png)

## Features

**Editor.** One buffer with Python syntax highlighting, 4-space auto-indent, bracket matching,
`Ctrl+F` search, `Ctrl+/` comment toggle and undo history — CodeMirror 6 with
`@codemirror/lang-python`. An editable filename field, a dark/light theme and A−/A+ font size,
all remembered.

**Autosave, and a guard against losing it.** Every change is saved to `localStorage` and
restored on reload, cursor included. A second tab writing the same key pauses autosave here and
offers *Reload* or *Keep mine* instead of letting one tab silently overwrite the other; while
it is paused with unsaved edits, closing or reloading asks for confirmation first.

**Byte-exact import/export.** Open a `.py`/`.txt` file with the Open button or by dropping it
on the editor; Download — or `Ctrl+S`/`Cmd+S` — writes it back **byte for byte**. Line endings,
a UTF-8 BOM, tabs and a missing trailing newline all survive the round trip, which
[`tests/roundtrip.test.ts`](tests/roundtrip.test.ts) checks against one fixture per hazard.

**Run it.** `Run` (`Ctrl+Enter`) executes the buffer in Pyodide — CPython compiled to
WebAssembly — in a **Web Worker**, so `while True: pass` never freezes the tab. The runtime is
served from this origin, never a CDN, and is fetched on the first Run (about 13 MB, then
browser-cached) behind a *Loading Python…* indicator.

- **Two modes**, remembered between visits. **REPL echo** (the default) compiles each top-level
  statement in `single` mode, so a bare expression prints its `repr` exactly as the `>>>` prompt
  does — which is what makes a file of bare arithmetic show its answers; `None` prints nothing.
  **Script** compiles the whole buffer in `exec` mode, i.e. what `python3 file.py` does, where
  an expression on a line of its own produces no output.
- **Every Run gets a fresh namespace**, so no name or import leaks in from the last one.
  **Restart Python** throws the interpreter away on purpose.
- **Tracebacks name your file and your line numbers**, with the interpreter's own frames
  stripped off the top and the offending source line and caret shown. Click a
  `File "scratch.py", line 7` reference and the cursor goes there. A `SyntaxError` anywhere is
  reported *before anything runs*.
- **Stop** raises `KeyboardInterrupt` through Pyodide's interrupt buffer and keeps the
  interpreter; if that does not take within 500 ms, or the page is not cross-origin isolated,
  the worker is terminated and a fresh one started. Either way the UI is back within a second.
- **Output is batched and capped** at 1,000,000 characters or 10,000 lines, then
  `--- output truncated ---`, so a runaway `print` loop cannot take the tab down with it.
- `import turtle` and `import tkinter` get one friendly line explaining that a browser tab has
  no window system, and a missing third-party package explains that this is the standard
  library only — not a raw `ModuleNotFoundError` dump.

**`input()` works.** Where the page is cross-origin isolated — `https://py-scratchpad.com`, or
`localhost` — it asks inline in the output panel, through a `SharedArrayBuffer` and
`Atomics.wait`:

![The same editor on its light theme, filename area.py, in Script mode. A program prints
"Rectangle area" and then calls input() twice; the run is parked at the first prompt, with the
status line reading "Waiting for input…" and an inline field labelled "width:" waiting for an
answer.](docs/screenshots/input-light.png)

Where it is not — the plain-HTTP LAN endpoint, which is not a secure context — a **Program
input** box supplies the lines before the Run and says why; `input()` raises `EOFError` when
they run out, as a short piped stdin would.

**About dialog.** Behind the toolbar's ⓘ button: the version and build month, the exact stack
versions, links, and a one-line diagnostics string with a Copy button for bug reports. The line
carries no buffer content and no filename.

## Privacy

Nothing leaves the browser. There is no backend to send anything to, no account, no telemetry
and no analytics. The Content-Security-Policy is `default-src 'self'` with `connect-src 'self'`,
so the page makes **no third-party request at all** — not for a font, not for a script, and not
for the Python runtime, which is served from this origin rather than from a CDN. Your code
lives in your browser's `localStorage` under the key `py-scratchpad:v1` and nowhere else.

### The old hostname

The site is also still served at <https://python.piapps.dev>, its original home. Both
hostnames reach the same container and neither redirects to the other, on purpose:
`localStorage` is per origin, so anything saved at `python.piapps.dev` is only reachable there.
Download it and re-open it at the new address.

## Run it yourself

The image is on Docker Hub as
[`0xwulf/py-scratchpad`](https://hub.docker.com/r/0xwulf/py-scratchpad), multi-arch for
`linux/amd64` and `linux/arm64`:

```sh
docker run -d --name py-scratchpad --restart unless-stopped \
  -p 8080:80 0xwulf/py-scratchpad:0.3.3
```

Then open `http://<host>:8080/`. There is no data directory to create and nothing to configure.

```yaml
services:
  py-scratchpad:
    image: 0xwulf/py-scratchpad:0.3.3 # pin a release; :latest also exists
    container_name: py-scratchpad
    restart: unless-stopped
    ports:
      - '127.0.0.1:5040:80' # put a TLS reverse proxy in front
    mem_limit: 64m
    read_only: true
    tmpfs:
      - /var/cache/nginx
      - /var/run
      - /tmp
```

Serve it over **HTTPS** and pass the container's headers through unchanged. Two of them are
load-bearing rather than hardening: `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` are what make the page cross-origin isolated, and
isolation is what a browser requires before handing out `SharedArrayBuffer` — which Stop's
interrupt and inline `input()` are built on. Without them everything still works, in the
fallback forms described above. [docs/DOCKERHUB.md](docs/DOCKERHUB.md) is the full image
documentation; [docs/DEPLOY.md](docs/DEPLOY.md) is the release and deploy runbook.

## Status

0.3.3 is the current release and is what both hostnames serve. v0.1 was the editor, autosave
and import/export; **v0.3 added the Run button** ([docs/PLAN.md](docs/PLAN.md) §9 step 7), and
was taken before v0.2 because running code is what the editor was wanted for. **v0.2 —
multi-file and zip export — is not built**: there is one buffer, and that is all there is.
See [docs/PLAN.md](docs/PLAN.md) §2 for the feature scope and §9 for the build order.

## Stack

Vite + vanilla TypeScript + CodeMirror 6 + Pyodide. Exact dependency versions are pinned in
[`package.json`](package.json), with `package-lock.json` committed.

## Development

Requires Node 22.18+.

```bash
npm install             # install pinned dependencies
npm run dev             # dev server on http://127.0.0.1:5173
npm run build           # typecheck (tsc) + production bundle into dist/
npm run preview         # serve the built dist/ locally
npm run lint            # eslint
npm test                # vitest units, including the Python runner in Pyodide under Node
npm run test:e2e        # one headless-Chromium smoke test against npm run preview
npm run test:e2e:image  # the same suite against the built container image (nginx)
npm run screenshots     # retake this README's images (needs a build first)
```

`npm run test:e2e:image` is the one that catches a serving mistake: `vite preview` is a Vite
dev server and types `.mjs` as JavaScript, while nginx has no `.mjs` mapping at all. 0.3.0
shipped with `pyodide.mjs` served as `application/octet-stream`, which a browser refuses to
execute as a module, and `npm run test:e2e` passed anyway. Run it before any release and after
any change to [`docker/nginx.conf`](docker/nginx.conf).

`npm run dev` and `npm run preview` both send `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`, so `SharedArrayBuffer`, Stop's interrupt and
interactive `input()` behave in development exactly as they do in production.

The Pyodide runtime is **not** committed. [`build/pyodide.ts`](build/pyodide.ts) copies the
files the core runtime needs out of `node_modules/pyodide` into `dist/pyodide/<version>/` on a
build, with Pyodide's MPL-2.0 licence beside them, and serves the same files straight out of
`node_modules` in dev. The version is in the URL, so each path is immutable and nginx caches it
for a year; bumping the pinned version changes the path rather than the contents of one. v0.3
is **standard library only** — no `micropip`, no `loadPackage`, no package ever fetched.

### Screenshots

[`scripts/screenshots.ts`](scripts/screenshots.ts) takes the two images above, driven by the
pinned Playwright and its Chromium through
[`playwright.screenshots.config.ts`](playwright.screenshots.config.ts):

```bash
npm run build && npm run screenshots
```

It runs against `npm run preview`, so the COOP/COEP headers are present and the `input()` shot
is the real inline prompt rather than the fallback — it asserts the page is isolated before it
captures anything. Each shot starts from a fresh browser context, i.e. an empty `localStorage`,
and the code is typed into the editor rather than written to the storage key; the typing helper
normalises the editor's auto-indent and auto-closed brackets and then asserts that the saved
buffer is character-for-character the source asked for. Nothing waits on a fixed sleep. The
PNGs are 1280x800 at 2x and are squeezed with `oxipng` or `pngquant` if either is installed; if
neither is, they are taken at 1.5x instead.

### Reproducible builds

The version and build date the About dialog shows come from `package.json` and from the **last
commit's date** — `SOURCE_DATE_EPOCH` if it is set, else `git log -1 --format=%cI` — never from
the build clock. Two builds of one commit therefore emit byte-identical `dist/assets/*.js`:

```bash
npm run build && sha256sum dist/assets/*.js
npm run build && sha256sum dist/assets/*.js    # the same hashes, and the same filenames
```

The image has no `.git` (`.dockerignore`), so `release.yml` passes the tagged commit's timestamp
as a `SOURCE_DATE_EPOCH` build arg. A plain local `docker build` without it shows the version
with no month, which is the honest answer rather than the time of the build.

## Layout

```
index.html          page shell
src/main.ts         bootstrap, wires the UI
src/about.ts        About content: version, stack, links, diagnostics (no DOM)
src/aboutdialog.ts  the About <dialog>: markup, open/close, Copy
src/editor.ts       CodeMirror setup: extensions, theme and font compartments, goToLine
src/storage.ts      localStorage load/save, schema version + migration
src/files.ts        import/export: decode, encode, line endings, BOM, filenames
src/tabsync.ts      multi-tab guard: what to do when another tab writes
src/notice.ts       the notice bar's messages, kept away from the DOM
src/runner.ts       the worker's lifecycle: load, run, Stop, Restart, input()
src/pyodide.worker.ts  the worker: loads Pyodide, runs the buffer, streams output
src/runner.py       the Python side: the two modes, fresh namespace, tracebacks
src/protocol.ts     the messages between page and worker
src/output.ts       output batching, the cap, and clickable line references
src/stdin.ts        the SharedArrayBuffer input() protocol, and its fallback
src/globals.d.ts    the build-time constants Vite's define injects
src/style.css       styles
build/pyodide.ts    stages the Pyodide runtime into dist/, serves it in dev
vendor/pyodide/     Pyodide's licence, published beside the runtime
tests/              vitest units; tests/fixtures/ are the round-trip samples
tests/e2e/          the Playwright smoke test
scripts/screenshots.ts  takes this README's images
scripts/e2e-image.sh    builds the image and runs the smoke test against nginx
Dockerfile          multi-stage build: node builds, nginx serves
docker/             the nginx config and the security headers it sends
docker-compose.yml  the deployed service, pinned to a released tag
vite.config.ts      build config: the defines, the plugin, the dev headers
playwright.config.ts            the smoke test's config (preview server, chromium)
playwright.screenshots.config.ts  the screenshot run's config
public/             static assets copied verbatim into dist/
docs/PLAN.md        full build plan (scope, stack, deploy, acceptance checks)
docs/DEPLOY.md      release and deploy runbook for piapps2
docs/DOCKERHUB.md   the Docker Hub overview text
docs/screenshots/   the images in this README
CLAUDE.md           project rules for Claude Code sessions
```

## Round-trip fixtures

`tests/fixtures/` holds one sample per hazard: tabs, spaces, CRLF, a UTF-8 BOM, a missing
trailing newline, and non-ASCII text. `tests/roundtrip.test.ts` runs each one through the whole
path — bytes, decode, a real CodeMirror document, encode, bytes — because the normalisation that
breaks a round trip happens inside the editor, not in `files.ts`.

To check the same thing by hand, open each fixture in the browser, click Download, then run this
from the repository root (adjust `$HOME/Downloads` if your browser saves elsewhere):

```bash
for f in tests/fixtures/*.py; do
  n=$(basename "$f")
  if cmp -s "$f" "$HOME/Downloads/$n"; then
    echo "IDENTICAL $n"
  else
    echo "DIFFERS   $n"
  fi
done
```

## License

[MIT](LICENSE)
