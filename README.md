# py-scratchpad

A browser-only Python scratchpad: a small editor to keep open next to a course video.
Syntax highlighting, autosave, import/export, and (later) a Run button powered by Pyodide.

Everything stays in the browser — no backend, no accounts, no login, no data on the server.
The deployed site is static files behind nginx.

Public URL (once deployed): <https://python.piapps.dev>

## Status

Scaffold only. The editor, autosave and import/export are built in order; see
[docs/PLAN.md](docs/PLAN.md) §9 for the build steps and §2 for the feature scope.

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
src/style.css       styles
vite.config.ts      build config
public/             static assets copied verbatim into dist/
docs/PLAN.md        full build plan (scope, stack, deploy, acceptance checks)
CLAUDE.md           project rules for Claude Code sessions
```
