---
title: py-scratchpad — browser-only Python scratchpad at py-scratchpad.com (build plan)
author: 0xWulf
created: 2026-10-08
hosts: [piapps2, piapps]
status: draft
tags: [homelab, webapp, python, codemirror, pyodide, docker, nginx, cloudflare, study]
---

# py-scratchpad — browser-only Python scratchpad (build plan)

A small editor to keep open next to a Udemy course. It has syntax highlighting, import/export, autosave, and optionally a **Run** button. Everything stays in the browser: no backend, no accounts, no login, and no data on the server.

Build it with Claude Code + VS Code in a new GitHub repo. Host it on **piapps2** behind **piapps** nginx. It launched as `python.piapps.dev`; the public home is now `py-scratchpad.com`, with the original hostname still serving (§6.1).

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
| Public URL | `https://py-scratchpad.com` (+ `www` → apex); also `https://python.piapps.dev` |

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

### v0.3 — Run in browser (Pyodide) — **built 2026-10-09**, released as 0.3.0

Built as planned, with the corrections below. v0.2 (multi-file) was **skipped for now**: a
Run button is what the editor was wanted for, and the single buffer is what v0.3 runs.

- A **Run** button (`Ctrl+Enter`) and an output panel below the editor that shows stdout, stderr and tracebacks.
- Pyodide runs in a **Web Worker**, so an infinite loop never freezes the tab.
- Pyodide is lazy-loaded on the first Run (about 13 MB, then cached), with a "Loading Python…" indicator.
- "Clear" button, plus **Restart Python**, which recreates the worker.
- **Correction 1 — Stop is two mechanisms, not one.** The plan said "terminate the worker and
  spawn a fresh one … needs no special headers", and that is only the fallback. Terminating
  costs a full 13 MB reload every time, which on an exercise you are iterating on is painful.
  So Stop first writes SIGINT into Pyodide's **interrupt buffer** (one byte on a
  `SharedArrayBuffer`), which raises `KeyboardInterrupt` and *keeps* the interpreter and
  everything it imported; only if that has not taken within 500 ms — or there is no isolation
  to give a `SharedArrayBuffer` — is the worker terminated. A thread parked on
  `Atomics.wait` for `input()` never reaches a signal check, so Stop sends EOF first.
- **Correction 2 — two modes were needed, not one.** The plan assumed one way of running the
  buffer. An exercise file of bare arithmetic (`10 + 20 * 30`) prints **nothing** under
  `python3 file.py`, which is not what a learner typing it expects. So there is a persisted
  toggle: **REPL echo** (the default) compiles each top-level statement on its own with
  `compile(ast.Interactive([stmt]), …, "single")`, so `sys.displayhook` prints a bare
  expression's `repr` as the `>>>` prompt does; **Script** compiles the whole buffer with
  `exec`. Compiling *everything* before running *anything* is what keeps a `SyntaxError` on
  the last line from letting the lines above it print first.
- **Correction 3 — "Reset interpreter … clears globals between runs" is the wrong default.**
  Every Run already gets a fresh namespace, like `python3 file.py`, so a stale name can never
  leak in. Restart Python is therefore about the *interpreter*, not the globals.
- **Correction 4 — `input()`'s prompt comes out of stdout, and only with `isatty: false`.**
  `pyodide.setStdin` hands the callback no prompt. With `isatty: true` CPython routes the
  prompt to **stderr** through the readline path and it arrives *after* the stdin call; with
  `isatty: false` it is written to **stdout** in its own write, *before* stdin is read — which
  is what lets the page show it. The streams therefore use the `Writer` form
  (`write(buffer)`) with `isatty: false`, not `batched`, because `batched` waits for a newline
  that an `input()` prompt never has.
- **Correction 5 — `TextEncoder.encodeInto` refuses a `SharedArrayBuffer`.** Chrome: *"The
  provided Uint8Array value must not be shared."* The line is encoded into a fresh array and
  copied across, cutting on a code-point boundary. This cost an hour; see `src/stdin.ts`.
- **`input()` support** works as planned where the document is cross-origin isolated
  (COOP + COEP, §5, plus a secure context). Where it is not — `http://192.168.50.120:5040` is
  not a secure context — it does **not** drop back to "not supported": a **Program input** box
  supplies the lines before the Run, fed to `input()` in order, with `EOFError` when they run
  out, and a one-line note saying why.
- **Dropped: `micropip` / `loadPackage`.** `connect-src 'self'` and the no-CDN rule mean no
  package can be fetched, and vendoring numpy would multiply the image size. v0.3 is the
  standard library and nothing else; `tkinter`, `turtle` and a missing third-party package
  each get one explanatory line instead of a raw `ModuleNotFoundError`.
- **Added: an output cap.** 1,000,000 characters or 10,000 lines, then
  `--- output truncated ---`. `for i in range(10**9): print(i)` is a program a beginner
  writes by accident, and without a ceiling it fills the worker, the message queue and the
  DOM at once. Output is coalesced in the worker by size *and* elapsed time (the worker is
  blocked inside synchronous Python, so no timer of its own can fire) and appended to the DOM
  on an animation frame.
- **Correction 6 — `.mjs` is not in nginx's `mime.types`, and that broke 0.3.0 in production.**
  `pyodide.mjs` and `pyodide.asm.mjs` were served as `application/octet-stream`, and a browser
  refuses to execute a module script that does not arrive with a JavaScript MIME type — so
  every Run failed with *"Failed to fetch dynamically imported module"*. The whole test suite
  passed, because `vite preview` is a Vite dev server and types `.mjs` correctly while nginx
  does not: **no test ran the browser against nginx.** Fixed in 0.3.1 with a `.mjs` location
  carrying an empty `types { }` plus `default_type text/javascript` (the same shape the
  `.wasm` already used), and guarded by `npm run test:e2e:image`, which builds the image, runs
  it read-only, asserts all six Content-Types and points the browser suite at nginx. Both the
  unit guard and the image guard were verified to fail when the location is removed.
- **Correction 7 — the Cloudflare beacon check has to use browser headers.** §6.1 below claims
  Web Analytics is absent for the `py-scratchpad.com` zone. On 2026-10-09 headless Chrome
  reported `static.cloudflareinsights.com/beacon.min.js` blocked by CSP on **both** hostnames,
  while all three bare-`curl` sha256 hashes matched. Cloudflare's HTML rewriter only acts on
  browser-shaped requests, so the curl-based guard in `docs/DEPLOY.md` §6.4 is blind to it.
  The CSP does block the script, so nothing third-party executes — but the HTML is modified
  in flight. Operator action: turn `auto_install` off for both zones. **Not** a CSP change.
- **Added: the runtime is staged, not vendored into git.** `build/pyodide.ts` copies the five
  files the core runtime needs out of `node_modules/pyodide` into `dist/pyodide/<version>/`,
  with Pyodide's MPL-2.0 licence beside them, and serves the same files out of `node_modules`
  in dev. `public/pyodide/` in the plan's §4 layout is therefore **not** used — 13 MB of
  binaries npm already pins exactly do not belong in the repository.

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
  - **Done 2026-10-09 (v0.3).** COOP/COEP are in `docker/security-headers.conf`, which every
    location includes. **A `types { application/wasm wasm; }` block at server level would be a
    bug, not a fix:** nginx's `types` directive *replaces* the whole inherited table rather
    than adding to it, so it would un-type every CSS and JS file in the image. The `.wasm`
    instead gets its own regex location with an **empty** `types { }` (which disables
    extension lookup there) plus `default_type application/wasm`.
  - Hashed assets (`/assets/*`): `Cache-Control: public, max-age=31536000, immutable`.
    `/pyodide/<version>/*` likewise — the version is in the path, so each URL is immutable.
    `index.html`: `no-cache`.
  - gzip covers js/css/wasm/json. The 9.6 MB `.wasm` gzips to 3.5 MB; serving five of those
    concurrently under the 64 MB `mem_limit` measured 13.8 MiB.
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

### 6.1 Domain move to py-scratchpad.com — done 2026-10-09

The public home became **`https://py-scratchpad.com`** (apex, with `www` 301ing to it) later the
same day. `python.piapps.dev` **keeps serving exactly as before, and there is no redirect from
it**: `localStorage` is scoped per origin, so code saved at the old hostname would be unreachable
after a redirect. The operational detail lives in `docs/DEPLOY.md` §6; what follows is what this
step turned up.

- **Second vhost, not a rename.** `/etc/nginx/sites-available/py-scratchpad.com`, copied from
  `python.piapps.dev`, with the `www` → apex redirect structured as in `doubletrees.app`
  (a separate `443` server block) rather than the `if ($host = ...)` of `linuxsvr.org`.
  Source of truth is now in the repo at `docs/nginx/py-scratchpad.com` — `python.piapps.dev`
  has no such file.
- **Correction to §6's certificate story.** That section is right that `python.piapps.dev` needs
  no certificate work, but the new host is **not** on the wildcard. It got its own ECDSA P-256
  cert, SAN apex + `www`, expiring 2027-01-07, issued by **HTTP-01 `webroot`** — the method
  `containeryard.org`, `snippetmate.com` and `linuxsvr.org` use. DNS-01 was the first plan and
  was dropped: the certbot credential in `/root/.secrets/certbot/cloudflare.ini` is a **scoped
  token with access to `piapps.dev` only** (`GET /zones` returns exactly that one zone), so it
  cannot answer a DNS challenge for the new domain. Nothing in this step read or wrote that file,
  which matters because `piapps.dev-0001` renewed from it the next day.
- **Order is load-bearing.** The cert must exist before any `443` block names it, so the vhost
  went in as **port 80 only** first, the challenge path was proved end to end through Cloudflare,
  then certbot ran, then the `443` blocks were added. Two installs, two reloads.
- **Every redirect sits in a `location /`, never at server level.** nginx runs a server-level
  `return 301` in the server-rewrite phase, *before* location selection, which makes
  `location ^~ /.well-known/acme-challenge/` unreachable in that block. Measured on piapps:
  `containeryard.org` answers `200` for an existing challenge file, while `doubletrees.app`,
  `snippetmate.com` and `linuxsvr.org` answer `301`. Those three still renew — Let's Encrypt
  follows redirects and their `443` blocks (or, for `doubletrees.app`, the `nginx` authenticator)
  serve the token; both dry-runs passed. So it is survivable, not fatal. This vhost does not rely
  on the rescue: the ACME snippet is in all three blocks.
- **Cloudflare.** The zone was already active with apex, `www` and a wildcard `*` A record, all
  proxied to `122.116.150.249` — byte-identical to the `python` record on `piapps.dev` except
  that `www` is an A record rather than a CNAME, which is the same style the reference uses.
  Two settings differed from `piapps.dev` and were corrected operator-side: **SSL `full` →
  `strict`** and **Always Use HTTPS `off` → `on`**. `rocket_loader`, all three `minify` flags and
  bot JS (`fight_mode`, `enable_js`) were already off, matching the reference.
- ~~**Web Analytics is absent for this zone**, not merely disabled.~~ **Wrong, corrected
  2026-10-09 during the 0.3.0 release.** The claim rested on a bare-`curl` sha256 comparison,
  which Cloudflare's HTML rewriter does not act on: it only injects for browser-shaped
  requests. Headless Chrome reports
  `static.cloudflareinsights.com/beacon.min.js` **blocked by CSP on both hostnames**, and a
  `curl` carrying a browser `User-Agent` and `Accept` header finds the beacon in the HTML
  while a bare one does not. So the beacon-injection risk is live on this zone too. Nothing
  third-party executes — `script-src 'self'` stops it — but the page is being rewritten.
  The guard in `docs/DEPLOY.md` §6.4 now sends browser headers. **Open, operator action:**
  turn `auto_install` off for `py-scratchpad.com` and `piapps.dev`.
- **Open:** the wildcard `*.py-scratchpad.com` record has no vhost and no SAN coverage, so unused
  subdomains return 525; and a later small release should show a one-line "moved to
  py-scratchpad.com — download your files first" notice when served at `python.piapps.dev`
  (`src/notice.ts` is already the mechanism).

---

## 7. Monitoring and docs

- Uptime Kuma: **done 2026-10-09** — monitor id 60, name `py-scratchpad`, type **keyword**,
  URL `https://python.piapps.dev` (**repointed to `https://py-scratchpad.com` later the same day,
  see §6.1**), keyword `py-scratchpad` (it is the `<title>`), interval 60 s,
  retry 60 s, 2 retries, resend 30, accepted `200-299`, notification 1 `SIGINT → hexawulf`, no parent
  group. Field-for-field a copy of the `pitasker` / `netdata` monitors. First heartbeat:
  `UP — 200 - OK, keyword is found`. See [[uptime-kuma-piapps2]].
  Note: `kuma-push-provision.py` could not be used — it is push-only. The later URL change was
  made with a one-off script on the same socket.io pattern (`getMonitor` 60 → replace `url` →
  `editMonitor`), run inside the container and deleted afterwards.
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
- Deploy target: piapps2 `/home/zk/bots/py-scratchpad`, container `py-scratchpad`, port 192.168.50.120:5040, vhosts py-scratchpad.com and python.piapps.dev on piapps.
```

---

## 9. Build order (Claude Code sessions)

1. **Scaffold:** `npm create vite@latest py-scratchpad -- --template vanilla-ts`, add CodeMirror, then the seed `CLAUDE.md`, README and `.gitignore`. Push to GitHub.
2. **Editor + autosave:** one buffer, theme toggle, font size. Check by reloading the page: the code is still there.
3. **Import/export:** Open, drag-drop, Download, `Ctrl+S`. Round-trip a `.py` file and diff it against the original: it must be identical, including the trailing newline and tabs vs spaces.
4. **Docker + deploy to piapps2:** curl the LAN port.
5. **Ingress + DNS** (approval gate): browse the public URL, and add the Kuma monitor. **v0.1 is done here.** — **done 2026-10-09** (§6, §7; for `python.piapps.dev` no cert and no DNS change were needed). The move to `py-scratchpad.com` followed the same day (§6.1) and *did* need a cert of its own.
6. **v0.2 multi-file + zip export.**
7. **v0.3 Pyodide:** worker runner, Stop, output panel; then the `input()` bridge with COOP/COEP.
   — **done 2026-10-09**, all of it in one step (see §2 v0.3 for the five corrections). Step 6
   (v0.2 multi-file) was skipped and is still open.

Each step ends with a commit and a manual check in the browser.

---

## 10. Acceptance checks

- [ ] Type code, close the tab, reopen: the code is still there.
- [ ] Open a `.py` file, edit, download: the content round-trips exactly.
- [ ] `Ctrl+S` downloads the file and does not show the browser's save-page dialog.
- [ ] The DevTools Network tab shows no requests to any host other than the one serving the page (`py-scratchpad.com`, or `python.piapps.dev`).
- [ ] The DevTools console shows no CSP violations.
- [ ] It works in Vivaldi/Opera/Chromium and Firefox on linuxsvr, and side by side with a Udemy tab (narrow window ≈ 600 px).
- [x] v0.3: `while True: pass` → Stop recovers within 1 s; `input("name? ")` works; tracebacks show line numbers.
  — all three are in `tests/e2e/smoke.spec.ts`, which also pins the three-expression REPL-echo
  case, a clicked traceback reference, `crossOriginIsolated === true`, the non-isolated
  `Program input` fallback, and that no request leaves the origin.
- [x] v0.3: two builds of one commit emit byte-identical `dist/assets/*.js` (the build date
  comes from the source commit, not the clock).

---

## 11. Effort estimate

| Part | Time |
|---|---|
| Scaffold + editor + autosave + import/export | ~1–1.5 h |
| Docker + piapps2 + piapps vhost + DNS + Kuma | ~45 min |
| v0.2 multi-file + zip | ~45 min |
| v0.3 Pyodide worker + Stop | ~1 h |
| v0.3 `input()` via SharedArrayBuffer + COOP/COEP | ~1 h |

Actual for v0.3: about three hours, most of it on the two things the plan did not anticipate
— that an exercise file of bare expressions needs a REPL-echo mode to be useful at all, and
that `encodeInto` will not write into shared memory.
