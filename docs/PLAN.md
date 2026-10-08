---
title: py-scratchpad — browser-only Python scratchpad at python.piapps.dev (build plan)
author: 0xWulf
created: 2026-10-08
hosts: [piapps2, piapps]
status: draft
tags: [homelab, webapp, python, codemirror, pyodide, docker, nginx, cloudflare, study]
---

# py-scratchpad — browser-only Python scratchpad (build plan)

A small editor to keep open next to a Udemy course. It has syntax highlighting, import/export, autosave, and optionally a **Run** button. Everything stays in the browser: no backend, no accounts, no login, and no data on the server.

Build it with Claude Code + VS Code in a new GitHub repo. Host it on **piapps2** behind **piapps** nginx as `python.piapps.dev`.

---

## 1. Name

**Chosen: `py-scratchpad`** (decided 2026-10-08). It says what the tool is: a scratchpad for Python. It was picked over `pyscratch` because that name could be confused with MIT's Scratch language.

| Thing | Name |
|---|---|
| GitHub repo | `hexawulf/py-scratchpad` |
| Dev checkout (linuxsvr) | `/home/zk/projects/python/py-scratchpad`. It sits inside the `python-learner` repo, so `/py-scratchpad/` is listed in that repo's `.gitignore` |
| Compose dir (piapps2) | `/home/zk/bots/py-scratchpad` |
| Container | `py-scratchpad` |
| localStorage key | `py-scratchpad:v1` |
| Public URL | `https://python.piapps.dev` |

---

## 2. Scope

### MVP (v0.1)
- **Editor:** CodeMirror 6 with `@codemirror/lang-python`. It gives syntax highlighting, line numbers, auto-indent (4 spaces), bracket matching, comment toggle (`Ctrl+/`), search (`Ctrl+F`), and undo history.
- **Autosave:** to `localStorage` on change, debounced about 300 ms. A reload restores everything, including the cursor position.
- **Import:** an "Open" button (`<input type=file accept=".py,.txt">`) plus drag-and-drop onto the editor, read with `FileReader`.
- **Export:** "Download", which saves the current buffer as `<name>.py` through a Blob plus `<a download>`. Also bind `Ctrl+S` to Download, so the browser's "save page" dialog doesn't open.
- **Filename field:** editable, defaults to `scratch.py`.
- **Theme:** dark by default, with a light toggle. Follows `prefers-color-scheme` on first visit.
- **Font size:** A−/A+ buttons, saved in `localStorage`.

### v0.2 — multiple files
- A sidebar or tab strip with several files (new / rename / delete / switch). All are stored under one `localStorage` key as JSON: `{files:[{id,name,content,updated}], active}`.
- "Export all" as a `.zip` (JSZip, vendored).
- "Import" accepts several files at once.
- Confirm before delete. Optionally keep one-level undo of the last deleted file.

### v0.3 — Run in browser (Pyodide)
- A **Run** button (`Ctrl+Enter`) and an output panel below the editor that shows stdout, stderr and tracebacks.
- Pyodide runs in a **Web Worker**, so an infinite loop never freezes the tab.
- **Stop** terminates the worker and spawns a fresh one. This is simple and needs no special headers.
- Pyodide is lazy-loaded on the first Run (about 10 MB, then cached), with a "Loading Python…" indicator.
- **`input()` support:** worker plus `SharedArrayBuffer` plus `Atomics.wait`, so the worker blocks until the UI sends a line. This needs cross-origin isolation headers (§5). If that becomes a pain, drop back to "input() not supported" and note it in the UI.
- "Clear output" button, plus a "Reset interpreter" button that clears globals between runs.
- Optional: `micropip` / `loadPackage` for numpy and similar packages, on demand.

### Out of scope
Accounts, sync, sharing links, a server-side Python runtime, LSP/autocomplete beyond CodeMirror's basics, tkinter/turtle (no GUI in WASM), and real filesystem or network access.

---

## 3. Stack

| Piece | Choice | Why |
|---|---|---|
| Build | **Vite** + vanilla **TypeScript** | CodeMirror 6 is modular ESM and needs a bundler. No framework needed. |
| Editor | `codemirror`, `@codemirror/lang-python`, `@codemirror/theme-one-dark` | Light (~150 KB), good on mobile, easy to theme |
| Runtime (v0.3) | **Pyodide** (pinned version), vendored into `public/pyodide/` | Real CPython in WASM. Self-hosted, so it has no CDN dependency |
| Zip (v0.2) | `jszip` | Export all |
| Serve | `nginx:alpine` (multi-arch, arm64 OK) | Static files only |
| Tests | `vitest` for storage/state logic; one Playwright smoke test (optional) | Keep it light |

- **No CDN at runtime.** Every asset is built or vendored into `dist/`, so the page works if a CDN is down. It also keeps the CSP simple.
- Pin exact versions in `package.json` and commit `package-lock.json`.

---

## 4. Repo layout

```
py-scratchpad/
├── CLAUDE.md               # project rules for Claude Code (see §8)
├── README.md
├── package.json / package-lock.json
├── vite.config.ts
├── tsconfig.json
├── index.html
├── src/
│   ├── main.ts             # bootstrap, wire UI
│   ├── editor.ts           # CodeMirror setup, theme compartment, keymaps
│   ├── storage.ts          # localStorage load/save, schema version + migration
│   ├── files.ts            # import (FileReader, drag-drop), export (Blob, zip)
│   ├── runner.ts           # v0.3: worker lifecycle, stdin bridge
│   ├── pyodide.worker.ts   # v0.3: loads Pyodide, runs code, streams output
│   └── style.css
├── public/
│   └── pyodide/            # v0.3: vendored Pyodide core files (pinned)
├── tests/
├── docker/
│   └── nginx.conf          # container nginx: headers, caching, gzip
├── Dockerfile              # multi-stage: node build → nginx:alpine
├── docker-compose.yml
└── .github/workflows/ci.yml  # npm ci, lint, test, build (optional)
```

---

## 5. Container (piapps2)

- **Port:** `192.168.50.120:5040 -> 80`. 5040 was free on 2026-10-08. Ports in use: 3011 Kuma, 5016/5017, 5030 Stocky, 7007, 8080 cAdvisor, 8384, 19999.
- **Compose dir:** `/home/zk/bots/py-scratchpad` (matches the other `~/bots/*` services). Clone the repo there.
- **Dockerfile (sketch):**
  ```dockerfile
  FROM node:22-alpine AS build
  WORKDIR /app
  COPY package*.json ./
  RUN npm ci
  COPY . .
  RUN npm run build

  FROM nginx:1.27-alpine
  COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
  COPY --from=build /app/dist /usr/share/nginx/html
  ```
- **docker-compose.yml (sketch):**
  ```yaml
  services:
    py-scratchpad:
      build: .
      container_name: py-scratchpad
      restart: unless-stopped
      ports:
        - "192.168.50.120:5040:80"
      mem_limit: 64m
      read_only: true
      tmpfs: [/var/cache/nginx, /var/run, /tmp]
      labels:
        - com.centurylinklabs.watchtower.enable=false   # locally built image
  ```
- **Container nginx headers** (`docker/nginx.conf`):
  - `Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`
  - v0.3 with `input()`: `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. Verify that `self.crossOriginIsolated === true` in DevTools.
  - Hashed assets (`/assets/*`, `/pyodide/*`): `Cache-Control: public, max-age=31536000, immutable`. `index.html`: `no-cache`.
  - gzip on for js/css/wasm, plus `types { application/wasm wasm; }` if it is missing.
- **Verify on piapps2:**
  ```bash
  cd /home/zk/bots/py-scratchpad && docker compose up -d --build
  docker ps --filter name=py-scratchpad
  curl -sI http://192.168.50.120:5040/ | head -n 5
  ```

---

## 6. Ingress (piapps) — production nginx, operator approval required

Follow the Kuma vhost pattern from [[2026-10-03-uptime-kuma-piapps2-implementation-runbook]] §4.2–4.4:

- `/etc/nginx/sites-available/python.piapps.dev`: port 80 → 301; 443 with `http2 on`, the Cloudflare origin cert `/etc/ssl/cloudflare/piapps.dev.crt` / `.key`, the `cloudflare_real_ip.conf` include (check that conf.d doesn't already pull it in), the dotfile deny block, and `proxy_pass http://192.168.50.120:5040;`. No WebSocket headers needed.
- Copy `listen`/`http2` syntax from an existing vhost.
- Make sure the proxy **passes the container's headers through** (CSP, COOP/COEP, Cache-Control). Do not add duplicate `add_header` lines on piapps.
- Steps: `sudo nano …` → `sudo ln -s …` → `sudo nginx -t` → `sudo systemctl reload nginx` → `journalctl -u nginx --since "5 min ago"`.
- **Cloudflare DNS:** add `python` in the same pattern as `kuma`/`netdata`, set to Proxied (orange), with SSL mode Full (strict).
- **Verify from linuxsvr:**
  ```bash
  dig +short python.piapps.dev
  curl -sI https://python.piapps.dev | head -n 10
  ```

Optional: a Cloudflare Access policy or an IP allowlist, if you'd rather not make it public. There is no server-side data, so public is low risk.

---

## 7. Monitoring and docs

- Uptime Kuma: an HTTP(s) monitor for `https://python.piapps.dev` with keyword `py-scratchpad` in the page title. See [[uptime-kuma-piapps2]].
- Update [[sigint-piapps2-cronjobs-reference]] only if a cron gets added (none is planned).
- After it is live, set this note's `status:` to `live`, and add the service, port and vhost to the hexawulf-homelab skill's piapps2 service list.

---

## 8. Seed `CLAUDE.md` for the repo

```markdown
# py-scratchpad
Browser-only Python scratchpad served as static files. No backend, no accounts, no telemetry.

## Rules
- No runtime CDN or third-party requests: everything is bundled or vendored (CSP is `default-src 'self'`).
- All user data lives in localStorage under key `py-scratchpad:v1`; bump the version and write a migration when the schema changes.
- Never lose user code: autosave must survive reload; destructive actions (delete file, reset) need a confirm.
- Vanilla TS + Vite + CodeMirror 6. Don't add a UI framework without asking.
- Pin exact dependency versions; commit package-lock.json.
- Run `npm run lint && npm test && npm run build` before saying a change is done.
- Deploy target: piapps2 `/home/zk/bots/py-scratchpad`, container `py-scratchpad`, port 192.168.50.120:5040, vhost python.piapps.dev on piapps.
```

---

## 9. Build order (Claude Code sessions)

1. **Scaffold:** `npm create vite@latest py-scratchpad -- --template vanilla-ts`, add CodeMirror, then the seed `CLAUDE.md`, README and `.gitignore`. Push to GitHub.
2. **Editor + autosave:** one buffer, theme toggle, font size. Check by reloading the page: the code is still there.
3. **Import/export:** Open, drag-drop, Download, `Ctrl+S`. Round-trip a `.py` file and diff it against the original: it must be identical, including the trailing newline and tabs vs spaces.
4. **Docker + deploy to piapps2:** curl the LAN port.
5. **Ingress + DNS** (approval gate): browse `https://python.piapps.dev`, and add the Kuma monitor. **v0.1 is done here.**
6. **v0.2 multi-file + zip export.**
7. **v0.3 Pyodide:** worker runner, Stop, output panel; then the `input()` bridge with COOP/COEP.

Each step ends with a commit and a manual check in the browser.

---

## 10. Acceptance checks

- [ ] Type code, close the tab, reopen: the code is still there.
- [ ] Open a `.py` file, edit, download: the content round-trips exactly.
- [ ] `Ctrl+S` downloads the file and does not show the browser's save-page dialog.
- [ ] The DevTools Network tab shows no requests to any host other than `python.piapps.dev`.
- [ ] The DevTools console shows no CSP violations.
- [ ] It works in Vivaldi/Opera/Chromium and Firefox on linuxsvr, and side by side with a Udemy tab (narrow window ≈ 600 px).
- [ ] v0.3: `while True: pass` → Stop recovers within 1 s; `input("name? ")` works; tracebacks show line numbers.

---

## 11. Effort estimate

| Part | Time |
|---|---|
| Scaffold + editor + autosave + import/export | ~1–1.5 h |
| Docker + piapps2 + piapps vhost + DNS + Kuma | ~45 min |
| v0.2 multi-file + zip | ~45 min |
| v0.3 Pyodide worker + Stop | ~1 h |
| v0.3 `input()` via SharedArrayBuffer + COOP/COEP | ~1 h |
