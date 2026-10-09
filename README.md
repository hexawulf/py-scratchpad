# py-scratchpad

A browser-only Python scratchpad: a small editor to keep open next to a course video.
Syntax highlighting, autosave, import/export, and a **Run** button that runs real CPython
in the tab, through Pyodide.

Everything stays in the browser — no backend, no accounts, no login, no data on the server.
Your code is never uploaded, because there is nothing to upload it to: the deployed site is
static files behind nginx, and the Python interpreter is WebAssembly served from the same
origin.

Public URL: <https://py-scratchpad.com> (`www` redirects to the apex).

It is also still served at <https://python.piapps.dev>, its original home. Both hostnames
reach the same container, and neither redirects to the other: your files live in the
browser's `localStorage`, which is per origin, so anything saved at `python.piapps.dev`
is only reachable there. Download it and re-open it at the new address.

## Status

v0.3 adds the Pyodide runner (PLAN §9 step 7). v0.1 is live at <https://py-scratchpad.com>
(PLAN §9 steps 1-5); multi-file support (v0.2) is still not built, and v0.3 was taken first
because running code is what the editor was wanted for. See [docs/PLAN.md](docs/PLAN.md) §9
for the build steps and §2 for the feature scope, and [docs/DEPLOY.md](docs/DEPLOY.md) for
the release and deploy runbook.

What works today:

- One buffer with Python syntax highlighting, 4-space indent, `Ctrl+F` search, `Ctrl+/` comments.
- Autosave to `localStorage`, restored on reload, including the selection.
- Open a `.py`/`.txt` file via the Open button or by dropping it on the editor; Download, or
  `Ctrl+S`/`Cmd+S`, writes it back **byte for byte** — line endings, UTF-8 BOM, tabs and a
  missing trailing newline all survive the round trip.
- An editable filename field, dark/light theme and A-/A+ font size, all persisted.
- An **About dialog** behind the toolbar's ⓘ button: version and build month, the exact stack
  versions, links, and a one-line diagnostics string with a Copy button for bug reports.
- A second tab writing the same key pauses autosave here and offers Reload or Keep mine,
  instead of one tab silently overwriting the other. While it is paused with unsaved edits,
  closing or reloading the tab asks for confirmation first.

### Running code (v0.3)

- **Run** (`Ctrl+Enter`) executes the buffer in **Pyodide** — CPython 3.14 compiled to
  WebAssembly — and shows stdout, stderr and tracebacks in an output panel below the editor.
  The runtime is served from this origin, never a CDN, and is fetched on the first Run
  (about 13 MB, then browser-cached) with a *Loading Python…* indicator.
- It runs in a **Web Worker**, so `while True: pass` never freezes the tab.
- **Two modes**, remembered between visits:
  - **REPL echo** (the default) compiles each top-level statement in `single` mode, so a bare
    expression prints its `repr` exactly as the `>>>` prompt does — which is what makes a file
    of bare arithmetic show its answers. `None` prints nothing.
  - **Script** compiles the whole buffer in `exec` mode, i.e. what `python3 file.py` does: an
    expression on a line of its own produces no output.
- **Every Run gets a fresh namespace**, so no name or import leaks in from the last one.
- **Tracebacks name your file and your line numbers**, with the interpreter's own frames
  stripped off the top and the offending source line and caret shown. Click a
  `File "scratch.py", line 7` reference and the cursor goes there.
- A `SyntaxError` anywhere is reported *before anything runs*, with its line and caret.
- **Stop** raises `KeyboardInterrupt` through Pyodide's interrupt buffer and keeps the
  interpreter; if that does not take within 500 ms, or the page is not cross-origin isolated,
  the worker is terminated and a fresh one started. Either way the UI is back within a second.
  **Restart Python** throws the interpreter away on purpose.
- **`input()` works.** Where the page is cross-origin isolated (`https://py-scratchpad.com`,
  or `localhost`) it asks inline in the output panel, through a `SharedArrayBuffer` and
  `Atomics.wait`. Where it is not — the plain-HTTP LAN endpoint, which is not a secure
  context — a **Program input** box supplies the lines before the Run and says why; `input()`
  raises `EOFError` when they run out, as a short piped stdin would.
- Output is batched and capped at 1,000,000 characters or 10,000 lines, then
  `--- output truncated ---`, so a runaway `print` loop cannot take the tab down with it.
- `import turtle` and `import tkinter` get one friendly line explaining that a browser tab has
  no window system, and a missing third-party package explains that this is the standard
  library only. Not a raw `ModuleNotFoundError` dump.

## Stack

Vite + vanilla TypeScript + CodeMirror 6 + Pyodide. Exact dependency versions are pinned in
`package.json`, with `package-lock.json` committed.

## Development

Requires Node 22+.

```bash
npm install          # install pinned dependencies
npm run dev          # dev server on http://127.0.0.1:5173
npm run build        # typecheck (tsc) + production bundle into dist/
npm run preview      # serve the built dist/ locally
npm run lint         # eslint
npm test             # vitest units, including the Python runner in Pyodide under Node
npm run test:e2e     # one headless-Chromium smoke test against npm run preview
npm run test:e2e:image  # the same suite against the built container image (nginx)
```

`npm run test:e2e:image` is the one that catches a serving mistake: `vite preview` is a Vite
dev server and types `.mjs` as JavaScript, while nginx has no `.mjs` mapping at all. 0.3.0
shipped with `pyodide.mjs` served as `application/octet-stream`, which a browser refuses to
execute as a module, and `npm run test:e2e` passed anyway. Run it before any release and
after any change to `docker/nginx.conf`.

`npm run dev` and `npm run preview` both send `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`, the two headers that make the page cross-origin
isolated — so `SharedArrayBuffer`, Stop's interrupt and interactive `input()` behave in
development exactly as they do in production.

The Pyodide runtime is **not** committed. `build/pyodide.ts` copies the five files the core
runtime needs out of `node_modules/pyodide` into `dist/pyodide/<version>/` on a build, with
Pyodide's MPL-2.0 licence beside them, and serves the same files straight out of
`node_modules` in dev. The version is in the URL, so each path is immutable and nginx caches
it for a year; bumping the pinned version changes the path rather than the contents of one.

### Reproducible builds

The version and build date the About dialog shows come from `package.json` and from the
**last commit's date** — `SOURCE_DATE_EPOCH` if it is set, else `git log -1 --format=%cI` —
never from the build clock. Two builds of one commit therefore emit byte-identical
`dist/assets/*.js`:

```bash
npm run build && sha256sum dist/assets/*.js
npm run build && sha256sum dist/assets/*.js    # the same hashes, and the same filenames
```

The image has no `.git` (`.dockerignore`), so `release.yml` passes the tagged commit's
timestamp as a `SOURCE_DATE_EPOCH` build arg. A plain local `docker build` without it shows
the version with no month, which is the honest answer rather than the time of the build.

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
vite.config.ts      build config: the defines, the plugin, the dev headers
playwright.config.ts  the smoke test's config (preview server, chromium)
public/             static assets copied verbatim into dist/
docs/PLAN.md        full build plan (scope, stack, deploy, acceptance checks)
CLAUDE.md           project rules for Claude Code sessions
```

## Round-trip fixtures

`tests/fixtures/` holds one sample per hazard: tabs, spaces, CRLF, a UTF-8 BOM, a missing
trailing newline, and non-ASCII text. `tests/roundtrip.test.ts` runs each one through the
whole path — bytes, decode, a real CodeMirror document, encode, bytes — because the
normalisation that breaks a round trip happens inside the editor, not in `files.ts`.

To check the same thing by hand, open each fixture in the browser, click Download, then:

```bash
cd /home/zk/projects/python/py-scratchpad && for f in tests/fixtures/*.py; do n=$(basename "$f"); cmp -s "$f" "$HOME/Downloads/$n" && echo "IDENTICAL $n" || echo "DIFFERS   $n"; done
```

## License

[MIT](LICENSE)
