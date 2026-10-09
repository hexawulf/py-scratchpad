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

**Done 2026-10-09.** The live procedure, the vhost itself and its rollback are in
`docs/DEPLOY.md` §6. What follows is the plan as executed, with the two corrections
this step turned up.

The reference is **`stocky.piapps.dev`**, not Kuma — stocky is the exact precedent, a piapps2
container behind a piapps vhost. Kuma is a secondary reference and its WebSocket
(`Upgrade`/`Connection "upgrade"`) and ACME-challenge blocks must **not** be copied.

- `/etc/nginx/sites-available/python.piapps.dev`: port 80 → 301; 443 with `http2 on`, the dotfile deny
  block, and `proxy_pass http://192.168.50.120:5040;`. No WebSocket headers, no `add_header`.
- **Correction 1 — the certificate.** This plan said to use a Cloudflare origin cert at
  `/etc/ssl/cloudflare/piapps.dev.crt`. **That file does not exist and piapps does not work that way.**
  piapps uses **Let's Encrypt**, and `*.piapps.dev` is served by one **shared wildcard**: cert name
  `piapps.dev-0001`, SAN `piapps.dev` + `*.piapps.dev`, at
  `/etc/letsencrypt/live/piapps.dev-0001/fullchain.pem` / `privkey.pem`. `python.piapps.dev` was
  **already covered**, exactly as `stocky` and `kuma` are, so **no certificate was issued and no
  renewal config was touched.** Renewal is automatic (`renew_hook = systemctl reload nginx`); the
  wildcard was issued via DNS-01 (`authenticator = dns-cloudflare`), which is the only option for a
  wildcard — so the "does HTTP-01 work behind the orange cloud" question never arises.
  A rollback must **never** delete this cert: it serves piapps.dev and every subdomain.
- **Correction 2 — the real-IP include.** `cloudflare_real_ip.conf` is **already loaded at http level**
  via `include /etc/nginx/conf.d/*.conf;` in `nginx.conf`. stocky does not include it by name, and
  neither does this vhost. Do not add it.
- The proxy **passes the container's headers through** (CSP, nosniff, Referrer-Policy, Cache-Control).
  Nothing on piapps adds headers at http level, in `conf.d/` or in `snippets/` (grepped), so there is
  no duplication — verified with a per-header occurrence count on the public URL, not just presence.
- Steps as executed: write locally → `scp` to `piapps:/tmp` → `sudo install -m 644` into
  `sites-available` → `sudo ln -s` into `sites-enabled` → `sudo nginx -t` →
  `sudo systemctl reload nginx` (reload, not restart) → `journalctl -u nginx --since "5 min ago"`.
- **Cloudflare DNS: no change was needed.** The `python` A record already existed and already matched
  `stocky`/`kuma` byte for byte — `122.116.150.249`, Proxied (orange), TTL auto — and the zone SSL mode
  is already Full (strict). Before the vhost existed the hostname returned **525**, because the `443
  default_server` has `ssl_reject_handshake on` and no vhost claimed that SNI.
- **Cloudflare caveat.** The zone has Web Analytics with `auto_install: true`, which *can* inject
  `static.cloudflareinsights.com/beacon.min.js` into proxied HTML — which would break the no-CDN rule
  and trip `script-src 'self'`. It is not injecting (public `index.html` is byte-identical to the
  origin). Guard it with the sha256 check below rather than trusting the setting; the fix, if it ever
  fires, is to turn auto-install off — **not** to widen the CSP.
- **Verify from linuxsvr:**
  ```bash
  dig +short python.piapps.dev
  echo | openssl s_client -connect 192.168.50.102:443 -servername python.piapps.dev 2>/dev/null | openssl x509 -noout -subject -dates -ext subjectAltName
  curl -sI https://python.piapps.dev/
  # always_use_https makes the edge answer :80, so prove the ORIGIN redirect directly:
  curl -sI -H 'Host: python.piapps.dev' http://192.168.50.102/
  # no Cloudflare rewriting:
  curl -s https://python.piapps.dev/ | sha256sum
  ssh piapps 'curl -s http://192.168.50.120:5040/ | sha256sum'
  ```

Optional: a Cloudflare Access policy or an IP allowlist, if you'd rather not make it public. There is no server-side data, so public is low risk.

---

## 7. Monitoring and docs

- Uptime Kuma: **done 2026-10-09** — monitor id 60, name `py-scratchpad`, type **keyword**,
  URL `https://python.piapps.dev`, keyword `py-scratchpad` (it is the `<title>`), interval 60 s,
  retry 60 s, 2 retries, resend 30, accepted `200-299`, notification 1 `SIGINT → hexawulf`, no parent
  group. Field-for-field a copy of the `pitasker` / `netdata` monitors. First heartbeat:
  `UP — 200 - OK, keyword is found`. See [[uptime-kuma-piapps2]].
  Note: `kuma-push-provision.py` could not be used — it is push-only.
- Update [[sigint-piapps2-cronjobs-reference]] only if a cron gets added (none is planned, none added).
- **Done 2026-10-09:** the vault note's `status:` is `live`, and the service, port and vhost are in the
  hexawulf-homelab skill (`references/hosts-detail.md` piapps2 container list and
  `references/network.md` §6 vhost table).

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
5. **Ingress + DNS** (approval gate): browse `https://python.piapps.dev`, and add the Kuma monitor. **v0.1 is done here.** — **done 2026-10-09** (§6, §7; no cert and no DNS change were needed).
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
