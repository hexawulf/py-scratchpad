# py-scratchpad

A browser-only Python scratchpad: a small editor to keep open next to a course video.
Syntax highlighting, autosave, import/export, and (later) a Run button powered by Pyodide.

Everything stays in the browser — no backend, no accounts, no login, no data on the server.
The deployed site is static files behind nginx.

Public URL: <https://python.piapps.dev>

## Status

v0.1 is live at <https://python.piapps.dev> (PLAN §9 steps 1-5). Multi-file support (v0.2)
and the Pyodide runner (v0.3) are not built yet. See [docs/PLAN.md](docs/PLAN.md) §9 for the
build steps and §2 for the feature scope, and [docs/DEPLOY.md](docs/DEPLOY.md) for the
release and deploy runbook.

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

## Stack

Vite + vanilla TypeScript + CodeMirror 6. Exact dependency versions are pinned in
`package.json`, with `package-lock.json` committed.

## Development

Requires Node 22+.

```bash
npm install          # install pinned dependencies
npm run dev          # dev server on http://127.0.0.1:5173
npm run build        # typecheck (tsc) + production bundle into dist/
npm run preview      # serve the built dist/ locally
```

## Layout

```
index.html          page shell
src/main.ts         bootstrap, wires the UI
src/about.ts        About content: version, stack, links, diagnostics (no DOM)
src/aboutdialog.ts  the About <dialog>: markup, open/close, Copy
src/editor.ts       CodeMirror setup: extensions, theme and font compartments
src/storage.ts      localStorage load/save, schema version + migration
src/files.ts        import/export: decode, encode, line endings, BOM, filenames
src/tabsync.ts      multi-tab guard: what to do when another tab writes
src/globals.d.ts    the build-time constants Vite's define injects
src/style.css       styles
tests/              vitest units; tests/fixtures/ are the round-trip samples
vite.config.ts      build config, including the __BUILD_INFO__ define
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
