---
title: py-scratchpad — release and deploy on $APP_HOST
author: 0xWulf
created: 2026-10-09
hosts: [app-host]
tags: [homelab, docker, dockerhub, nginx, py-scratchpad, runbook]
---

# py-scratchpad — release and deploy ($APP_HOST)

Static site, no backend and no server-side state. Everything the user types
lives in their browser's `localStorage` under `py-scratchpad:v1`, so the
container holds nothing worth backing up and can be replaced at any time.
Since 0.3.0 the image also carries the **Pyodide runtime** under
`/pyodide/<version>/` — 13 MB of WebAssembly that the browser fetches on the
first Run. It is still static files: the Python runs in the user's tab, not
here.

The image is built by GitHub Actions on a pushed tag and published to Docker
Hub. $APP_HOST **pulls a pinned tag** and never builds; it holds one file.

| Thing | Value |
|---|---|
| Host | $APP_HOST, `$APP_HOST_IP` (wired interface only, never Wi-Fi) |
| Compose file | `~/bots/py-scratchpad/docker-compose.yml` (the repo's own file: that directory is the source clone) |
| Container | `py-scratchpad` |
| Image | `0xwulf/py-scratchpad:X.Y.Z` — pinned, so watchtower is opted out |
| LAN endpoint | `http://$APP_HOST_IP:5040/` |
| Public URL | `https://py-scratchpad.com` (+ `www`, which 301s to the apex) |
| Former host | `https://python.piapps.dev` — retired 2026-11-25 (vhost, DNS record and its Cloudflare cache rule removed) |

The public hostname is a $EDGE_HOST nginx vhost proxying the container. See §6.

**Placeholders.** This repo is public, so host names and addresses are written
as shell variables: `$APP_HOST` (ssh alias of the host that runs the
container), `$APP_HOST_IP` (its LAN address), `$EDGE_HOST` / `$EDGE_HOST_IP`
(the nginx + TLS host), `$ORIGIN_WAN_IP` (the Cloudflare-proxied origin) and
`$WORKSTATION`. The real values live in `docs/deploy.local.env` on the deploy
host, which is gitignored. Load it once per shell before running anything
below:

```
. ~/bots/py-scratchpad/docs/deploy.local.env
```

The compose port binding reads `PY_SCRATCHPAD_BIND_ADDR` from the gitignored
`.env` beside `docker-compose.yml`. Without it, the container binds to
`127.0.0.1` and the edge proxy cannot reach it (it fails closed).

All commands use `docker compose -f` with an absolute path, so they work from
any working directory.

---

## 1. Cutting a release

Run on $APP_HOST, in `~/bots/py-scratchpad`. That directory is both the
**only source clone** and the deploy directory: the repo's `docker-compose.yml`
is the file the production container runs from. No source clone lives on a
workstation (moved off $WORKSTATION 2026-11-21).

**1.1 Pass the local gate.**

```
npm run lint && npm test && npm run build
```

Then the browser smoke test, which runs against the `dist/` just built (it
starts `npm run preview` itself):

```
npx playwright install chromium
npm run test:e2e
```

`ci.yml` runs all four, so a green CI run is the same gate — but the e2e one is
the only check that the worker actually starts under the real CSP and that the
page is cross-origin isolated, so it is worth having locally before tagging.

**1.1a Run the same suite against the image.** This is not optional for a
release and `ci.yml` does not do it:

```
npm run test:e2e:image
```

It builds the image, runs it read-only as $APP_HOST does, asserts the
Content-Type of all six runtime files, and runs the browser suite against
**nginx** rather than against `vite preview`.

Why it exists: `vite preview` is a Vite dev server and types `.mjs` as
JavaScript, while **nginx has no `.mjs` mapping at all**. 0.3.0 shipped with
`pyodide.mjs` served as `application/octet-stream`, which a browser refuses to
execute as a module script, so every Run failed with *"Failed to fetch
dynamically imported module"* — and `npm run test:e2e` passed the whole way.
Anything that changes `docker/nginx.conf`, the staged runtime file list, or the
headers has to go through this check.

**1.1b Prove the build is reproducible.** The About dialog's build date comes
from the last commit, not the clock, so two builds of one commit must be
identical:

```
npm run build ; sha256sum dist/assets/*.js
npm run build ; sha256sum dist/assets/*.js
```

Same hashes **and** same filenames. If they differ, something has started
reading the build clock again — see `buildDate()` in `vite.config.ts`.

**1.2 Bump the version.** Edit `version` in `package.json`. `release.yml`
refuses to publish if the tag and `package.json` disagree, so these must match.

**1.3 Commit and push.** Signed, `git add` by explicit path.

```
git add package.json
git commit -S -m "release: 0.1.1"
git push
```

**1.4 Wait for CI on the push.** `ci.yml` runs lint, tests and the build.

```
gh run watch "$(gh run list --workflow ci.yml --branch main --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
```

Do not tag until this is green — the tag just runs the same suite again.

**1.5 Tag and push the tag.** Annotated and signed, matching `package.json`.

```
git tag -s v0.1.1 -m "py-scratchpad 0.1.1"
git push origin v0.1.1
```

**1.6 Watch the release workflow.** Three jobs in sequence: the tag check
(regex plus the `package.json` match), CI on the tag, then the multi-arch
build and push.

```
gh run watch "$(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
```

**1.7 Confirm both platforms were published.**

```
docker buildx imagetools inspect 0xwulf/py-scratchpad:0.1.1
```

`linux/amd64` and `linux/arm64` must both appear. The two
`unknown/unknown` entries are the SBOM and provenance attestations and are
expected. The workflow also moves `:X.Y` and `:latest`; $APP_HOST pins the full
`:X.Y.Z` regardless, so nothing on the host floats.

---

## 2. Deploying to $APP_HOST

**2.1 The pinned tag is already in place.** There is one copy of
`docker-compose.yml`: the deploy directory is the repo clone, so the tag bumped
in §1.2 and committed in §1.3 is what §2.2 pulls. Check it, and check the clone
matches `origin/main`:

```
cd ~/bots/py-scratchpad ; git fetch -q origin ; git status -sb ; grep -n 'image:' ~/bots/py-scratchpad/docker-compose.yml
```

Do not run §2.2/§2.3 before §1.7 has confirmed the image exists: between the
release commit and the published image the file names a tag Docker Hub does
not have yet (a failed pull leaves the running container as it is).

**2.2 Pull the image.** The running container keeps serving while this runs.

```
ssh "$APP_HOST" 'docker compose -f ~/bots/py-scratchpad/docker-compose.yml pull'
```

**2.3 Recreate the container.**

```
ssh "$APP_HOST" 'docker compose -f ~/bots/py-scratchpad/docker-compose.yml up -d'
```

**2.4 Verify on the host.** The container must report `healthy`, keep its
read-only rootfs, run the expected image digest, and stay under the 64 MB cap.

```
ssh "$APP_HOST" 'docker compose -f ~/bots/py-scratchpad/docker-compose.yml ps ; docker inspect -f "health={{.State.Health.Status}} read_only={{.HostConfig.ReadonlyRootfs}} mem={{.HostConfig.Memory}} image={{.Config.Image}}" py-scratchpad ; docker stats --no-stream py-scratchpad'
```

**2.5 Verify over the LAN.** This is the real check: it proves the
`$APP_HOST_IP:5040` binding, the headers and the cache policy.

```
curl -sI http://$APP_HOST_IP:5040/
curl -s http://$APP_HOST_IP:5040/ | grep -o '<title>[^<]*</title>'
curl -s -o /dev/null -w 'status=%{http_code}\n' http://$APP_HOST_IP:5040/does-not-exist
```

Expected:

- `/` → `200`, `Cache-Control: no-cache, no-transform`, plus `Content-Security-Policy`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and — since
  0.3.0 — `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`.
- the title contains `py-scratchpad` (Uptime Kuma matches on this keyword); since 0.3.4 it
  reads `py-scratchpad — run Python in your browser, no install`.
- a path that does not exist → `404`, `Cache-Control: no-store, no-transform`. There is no
  SPA fallback, so a `200` here means the config regressed.
- the hashed `/assets/*` file → `200`, `Cache-Control: public, max-age=31536000, immutable, no-transform`.
- `/assets/*.js.map` → `404`. Source maps are off in `vite.config.ts`: the
  repo is public, so a map hides nothing, and it would add about 2 MB to every
  deploy for no benefit. A `200` here means they were switched back on.

Get the current hashed filename from the page itself:

```
curl -s http://$APP_HOST_IP:5040/ | grep -o '/assets/[^"]*\.js'
```

**2.5b The Pyodide runtime (0.3.0 and later).** Three things have to be right
or the first Run fails, and none of them is visible on `/`:

```
V=$(curl -s http://$APP_HOST_IP:5040/assets/index-*.js 2>/dev/null | grep -o '/pyodide/[0-9.]*/' | head -n1)
curl -sI "http://$APP_HOST_IP:5040${V}pyodide.asm.wasm"
curl -sI -H 'Accept-Encoding: gzip' "http://$APP_HOST_IP:5040${V}pyodide.asm.wasm" | grep -i content-encoding
for f in pyodide.mjs pyodide-lock.json pyodide.asm.mjs pyodide.asm.wasm python_stdlib.zip LICENSE ; do printf '%-20s ' "$f" ; curl -s -o /dev/null -w '%{http_code}\n' "http://$APP_HOST_IP:5040${V}${f}" ; done
```

Expected — **and the `type=` of every file matters, not just the wasm's**:

| file | Content-Type | why it matters |
|---|---|---|
| `pyodide.mjs` | `text/javascript` | the worker `import()`s it; a non-JS type and the browser refuses to execute it |
| `pyodide.asm.mjs` | `text/javascript` | same, imported by Pyodide from `indexURL` |
| `pyodide.asm.wasm` | `application/wasm` | `instantiateStreaming` refuses anything else |
| `pyodide-lock.json` | `application/json` | from `mime.types` |
| `python_stdlib.zip` | `application/zip` | from `mime.types` |
| `LICENSE` | `text/plain` | cosmetic; it is for humans |

Neither `.mjs` nor the extensionless `LICENSE` is in nginx's `mime.types`, so
each is asserted by its own location in `docker/nginx.conf` with an **empty**
`types { }` plus `default_type`. **0.3.0 shipped with both `.mjs` files as
`application/octet-stream` and every Run broken.** `npm run test:e2e:image`
(§1.1a) is what now catches that before a tag exists.

- all six → `200`, `Cache-Control: public, max-age=31536000, immutable, no-transform`.
- `Content-Encoding: gzip` on the second call — 9.6 MB becomes about 3.5 MB.
- `LICENSE` is Pyodide's MPL-2.0, which has to travel with the files it covers.

The version in `$V` must match `pyodide` in `package.json` for the release
being deployed. The path is immutable by construction, so a version bump
changes the path rather than the contents of one — no cache anywhere needs
purging, and the old path simply stops being requested.

**2.6 After a release that changes headers or caching,** re-check through the
public vhost too, since $EDGE_HOST nginx must pass the container's headers through
without adding its own:

The public hostname:

```
curl -sI https://py-scratchpad.com/
```

**2.6b COOP/COEP must arrive exactly once, and isolation must actually be on.**
A duplicate `Cross-Origin-Embedder-Policy` is as broken as a missing one, and
presence in the headers is not proof that the browser agreed — so count them,
then ask a browser:

```
for u in https://py-scratchpad.com/ ; do H=$(curl -sI "$u") ; printf '%s\n' "$u" ; for h in cross-origin-opener-policy cross-origin-embedder-policy ; do printf '  %-32s %s\n' "$h" "$(printf '%s\n' "$H" | grep -c -i "^$h:")" ; done ; done
```

Both counts must be `1` on both hostnames.

Headers being present is not proof that the browser agreed to isolate the
document, so ask one. `playwright.config.ts` starts its own preview server and
cannot be pointed at production, so this is a one-off, run from the repo on
$APP_HOST (Chromium comes from `npx playwright install chromium`):

```
cd ~/bots/py-scratchpad
node --input-type=module -e 'import {chromium} from "playwright"; const b = await chromium.launch(); const p = await b.newPage(); for (const u of ["https://py-scratchpad.com/"]) { await p.goto(u); console.log(u, "crossOriginIsolated =", await p.evaluate(() => window.crossOriginIsolated)); } await b.close()'
```

Both must print `crossOriginIsolated = true`. That is the only thing that
proves Stop's interrupt and interactive `input()` will work. `false` means a
header was dropped, duplicated or rewritten between the container and the
browser — **widen nothing in the CSP to compensate**; find the header.

---

## 3. Local development build

$APP_HOST's compose file pulls a pinned release and has no `build:`.

**Never use `docker-compose.dev.yml` in `~/bots/py-scratchpad`.** That
directory is the production compose project, and the override keeps the same
service and `container_name: py-scratchpad`, so `up` would rebuild and
**replace the live container** with the working tree.

To run the working tree as an image on $APP_HOST, use the image test instead. It
builds `py-scratchpad:e2e`, runs it as `py-scratchpad-e2e` on
`127.0.0.1:5041` beside production, runs the browser suite and removes it:

```
cd ~/bots/py-scratchpad ; npm run test:e2e:image
```

The dev override is only for a throwaway clone on another machine, where no
production container exists:

```
docker compose -f <clone>/docker-compose.yml -f <clone>/docker-compose.dev.yml up -d --build
curl -sI http://127.0.0.1:5040/
docker compose -f <clone>/docker-compose.yml -f <clone>/docker-compose.dev.yml down
```

---

## 4. Rollback

In order, least to most destructive. There is no data to lose at any point.

**4.1 Stop the service.** Releases port 5040, keeps everything else.

```
ssh "$APP_HOST" 'docker compose -f ~/bots/py-scratchpad/docker-compose.yml down'
```

**4.2 Pin the previous version.** Back up
`~/bots/py-scratchpad/docker-compose.yml` to `~/backups/` (outside the repo),
edit its tag back to the last good `X.Y.Z` (§2.1) with nano, then `pull` and `up -d`. There is one copy of the
file, so this leaves the clone dirty until a commit reverts the tag on `main`. Published tags are immutable, so
the earlier image is still there. This is the normal rollback.

**4.3 Fall back to a local build.** If Docker Hub or the registry is the
problem, build the previous tag on the host instead:

```
ssh "$APP_HOST" 'git clone --branch v0.1.0 --depth 1 git@github.com:hexawulf/py-scratchpad.git ~/bots/py-scratchpad-src ; docker build -t py-scratchpad:fallback ~/bots/py-scratchpad-src'
```

Then point the compose file's `image:` at `py-scratchpad:fallback` and `up -d`.

**4.4 Restore the pre-Docker-Hub state.** The clone that built the image
locally was moved aside, not deleted:

```
ssh "$APP_HOST" 'ls -ld ~/backups/py-scratchpad.bak_*'
```

That directory still carries the old `build:`-style compose file and the full
source, so `docker compose -f <that dir>/docker-compose.yml up -d --build`
reproduces the pre-release deployment exactly.

**4.5 Drop an image.** Only after a `down`; the next `pull` fetches it again.

```
ssh "$APP_HOST" 'docker image rm 0xwulf/py-scratchpad:0.1.0'
```

**4.6 Deleting the backup directory or a Docker Hub tag** needs operator
confirmation and is never part of a rollback.

---

## 6. Public ingress ($EDGE_HOST nginx vhosts)

**Production nginx on $EDGE_HOST is an operator approval gate** — read this section, then propose,
then wait for approval before touching it.

One vhost proxies the container: `py-scratchpad.com`. The original host `python.piapps.dev` was
**retired on 2026-11-25** (vhost, Cloudflare DNS record and its `/pyodide/` cache rule removed;
vhost backup on $EDGE_HOST in `~/backups/python.piapps.dev.nginx.bak_20261125_211937`). Code a
user saved in that origin's `localStorage` stays in their browser but is no longer reachable;
bringing the host back (restore the vhost + a proxied A record) would make it reachable again.

| | `py-scratchpad.com` |
|---|---|
| Role | public home since 2026-10-09; only host since 2026-11-25 |
| Vhost file | `/etc/nginx/sites-available/py-scratchpad.com` |
| In repo | `docs/nginx/py-scratchpad.com` |
| Names | apex + `www` (`www` 301s to apex) |
| Backend | `proxy_pass http://$APP_HOST_IP:5040` |
| TLS | **dedicated** `py-scratchpad.com`, ECDSA P-256, SAN apex + `www`, expires 2027-01-07 |
| ACME | HTTP-01, `authenticator = webroot`, `/var/www/letsencrypt` |
| Cloudflare | zone `py-scratchpad.com`, apex + `www` A → `$ORIGIN_WAN_IP`, Proxied, SSL Full (strict) |
| Monitor | Uptime Kuma keyword monitor (`py-scratchpad`); taipei-watch piapps2 ingress probe |

`py-scratchpad.com` uses a dedicated server block for the `www` → apex redirect
rather than an `if ($host = ...)` rewrite.

**No `add_header` belongs in this vhost.** The container owns the security headers
(`docker/security-headers.conf`) and nothing on $EDGE_HOST adds headers at http level, in `conf.d/`
or in `snippets/`. An `add_header` here would make each one appear **twice** on the public URL
— and for `Cross-Origin-Embedder-Policy` (new in 0.3.0) a duplicate does not merely look
untidy: the browser refuses to isolate the document, and `SharedArrayBuffer` disappears.
`cloudflare_real_ip.conf` is likewise already loaded at http level — do not include it per-vhost.

### 6.1 The two certificates are not interchangeable

**Never delete the shared wildcard `piapps.dev-0001`** (SAN `piapps.dev` + `*.piapps.dev`, DNS-01)
while rolling back this vhost: it served the retired `python.piapps.dev` and still serves `piapps.dev`
and every subdomain.

**`py-scratchpad.com` has its own cert**, issued HTTP-01 via webroot — *not* the DNS-01
wildcard path. It never touches the Cloudflare credentials file.

```
[renewalparams]
account = <acme-account-id>
key_type = ecdsa
renew_hook = systemctl reload nginx
authenticator = webroot
webroot_path = /var/www/letsencrypt,
[[webroot_map]]
py-scratchpad.com = /var/www/letsencrypt
www.py-scratchpad.com = /var/www/letsencrypt
```

How it was issued (2026-10-09), and the order that matters — **the cert must exist before any
443 block references it**, so the vhost went in as port 80 only first:

```
# stage 1: port-80-only vhost (acme snippet + location-based 301), install, nginx -t, reload
# then prove the challenge path end to end BEFORE calling certbot:
curl -s -o /dev/null -w '%{http_code}\n' http://py-scratchpad.com/.well-known/acme-challenge/health
curl -s -o /dev/null -w '%{http_code}\n' http://www.py-scratchpad.com/.well-known/acme-challenge/health

ssh "$EDGE_HOST" 'sudo certbot certonly --non-interactive --agree-tos --webroot --webroot-path /var/www/letsencrypt --key-type ecdsa --cert-name py-scratchpad.com -d py-scratchpad.com -d www.py-scratchpad.com --deploy-hook "systemctl reload nginx"'

# stage 2: install the full vhost (adds the two 443 blocks), nginx -t, reload
ssh "$EDGE_HOST" 'sudo certbot renew --dry-run --cert-name py-scratchpad.com'
```

`--deploy-hook` is what writes `renew_hook` into the renewal config.

**Every redirect in this vhost lives in a `location /`, never at server level.** That is not a
style choice. nginx runs a server-level `return 301` in the **server-rewrite phase, before
location selection**, which makes `location ^~ /.well-known/acme-challenge/` unreachable in that
block. Keeping the ACME snippet in all three blocks and every redirect inside a `location`
ensures the challenge is served directly on port 80 **and** on 443 after Cloudflare's
`always_use_https` starts answering port 80 at the edge.

### 6.2 Changing a vhost

Never edit in place. Write the file locally, stage it in a private `0700` directory on `$EDGE_HOST`,
install it, then test and reload.
For `py-scratchpad.com` the local source is in this repo. It is a template: `envsubst` fills in
`$APP_HOST_IP` (load `docs/deploy.local.env` first), and the `grep` shows the rendered backend
before anything is installed:

```
STAGE=$(ssh "$EDGE_HOST" 'mkdir -p -m 700 ~/tmp ; mktemp ~/tmp/py-scratchpad.com.XXXXXX')
envsubst '$APP_HOST_IP' < ~/bots/py-scratchpad/docs/nginx/py-scratchpad.com | ssh "$EDGE_HOST" "cat > '$STAGE'"
ssh "$EDGE_HOST" "grep -n proxy_pass '$STAGE'"
ssh "$EDGE_HOST" 'sudo nginx -T > ~/backups/edge-nginx-T.bak_$(date +%Y%m%d_%H%M%S)'
ssh "$EDGE_HOST" "sudo install -m 644 -o root -g root '$STAGE' /etc/nginx/sites-available/py-scratchpad.com"
ssh "$EDGE_HOST" 'sudo nginx -t'
ssh "$EDGE_HOST" 'sudo systemctl reload nginx'
ssh "$EDGE_HOST" "sudo journalctl -u nginx --since '5 min ago' --no-pager ; rm -f '$STAGE'"
```

On a first install, add the symlink between `install` and `nginx -t`:

```
ssh "$EDGE_HOST" 'sudo ln -s /etc/nginx/sites-available/py-scratchpad.com /etc/nginx/sites-enabled/py-scratchpad.com'
```

`reload`, never `restart` — a restart drops every other site on $EDGE_HOST with it.

**Always regression-check the other vhosts on `$EDGE_HOST` afterwards.** They share the process —
confirm `https://py-scratchpad.com/` and any sibling vhosts listed
in your local deploy notes still answer as expected.

### 6.3 Rollback

Removing the symlink is the whole rollback; the `sites-available` file and the certificate stay.

```
ssh "$EDGE_HOST" 'sudo rm /etc/nginx/sites-enabled/py-scratchpad.com'
ssh "$EDGE_HOST" 'sudo nginx -t ; sudo systemctl reload nginx'
```

The hostname then returns Cloudflare **525** — the `443 default_server` has
`ssl_reject_handshake on`, so an SNI no vhost claims is refused at the handshake. That is the
expected post-rollback state, not a fault. (On port 80 it becomes **520**: the
`listen 80 default_server` block answers `return 444`, a reset, which the edge reports as 520.)
Since `python.piapps.dev` was retired (2026-11-25), a rollback takes the app offline publicly.

**Do not delete either certificate as part of a rollback.**

### 6.4 Verifying a public URL

```
curl -sI https://py-scratchpad.com/
curl -sI https://www.py-scratchpad.com/
curl -sI https://py-scratchpad.com/assets/<hashed>.js
curl -s -o /dev/null -w '%{http_code}\n' https://py-scratchpad.com/does-not-exist
```

- apex `/` → `200`, `cache-control: no-cache, no-transform`; `www/` → `301` to the apex;
  `/assets/*` → `200`, `public, max-age=31536000, immutable, no-transform`; `*.js.map` and an
  unknown path → `404`, `no-store, no-transform`. **Every one of them carries `no-transform`**
  — that is the anti-rewriting guard, not a caching detail; see the Cloudflare bullet below.
- the certificate, per name:
  ```
  echo | openssl s_client -connect $EDGE_HOST_IP:443 -servername py-scratchpad.com 2>/dev/null | openssl x509 -noout -subject -dates -ext subjectAltName
  echo | openssl s_client -connect $EDGE_HOST_IP:443 -servername www.py-scratchpad.com 2>/dev/null | openssl x509 -noout -subject -dates -ext subjectAltName
  ```
- **Each security header must appear exactly once.** Count them, don't eyeball presence.
  The two cross-origin ones are in the list since 0.3.0: a duplicated
  `Cross-Origin-Embedder-Policy` breaks isolation exactly as a missing one does, and with it
  Stop's interrupt and interactive `input()`.
  ```
  H=$(curl -sI https://py-scratchpad.com/) ; for h in content-security-policy x-content-type-options referrer-policy cache-control cross-origin-opener-policy cross-origin-embedder-policy ; do printf '%-32s %s\n' "$h" "$(printf '%s\n' "$H" | grep -c -i "^$h:")" ; done
  ```
- **Prove Cloudflare is not rewriting the page — and do it with browser headers.**
  Web Analytics `auto_install` injects `static.cloudflareinsights.com/beacon.min.js` into
  proxied HTML, which breaks the no-CDN rule and trips `script-src 'self'`.

  **`no-transform` on `Cache-Control` is the primary guard, since 0.3.2.** A proxy must not
  modify a payload sent with it, so the rewriter stops at the edge without anything being
  changed in a dashboard. Every `Cache-Control` the container sends carries it — the entry
  document as `no-cache, no-transform`, `/assets/*` and `/pyodide/*` as
  `public, max-age=31536000, immutable, no-transform`, the 404 path as
  `no-store, no-transform`, the unhashed public files as `public, max-age=3600, no-transform`
  — so no response is left transformable. `docker/nginx.conf` holds it,
  `tests/pyodide-stage.test.ts` asserts it per location and `npm run test:e2e:image` reads it
  back off the real nginx. Turning `auto_install` off for the zone is still the tidier
  dashboard-side fix and remains open; it is no longer what the page depends on.

  Widening the CSP is **never** the fix. The CSP is the second line — it blocks the script
  from executing — and must stay as narrow as it is.

  **A plain `curl` cannot see the injection.** Cloudflare's HTML rewriter only acts on
  browser-shaped requests, so the bare three-way `sha256sum` below passed on 2026-10-09 on
  both hostnames while headless Chrome reported the beacon blocked by CSP on both. So the
  check that matters carries a browser `User-Agent` and `Accept`:
  ```
  UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'
  AC='text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
  for u in https://py-scratchpad.com/ ; do printf '%-30s ' "$u" ; curl -s -H "User-Agent: $UA" -H "Accept: $AC" "$u" | grep -c cloudflareinsights ; done
  ```
  Both must print `0`. A `1` with `no-transform` present on the response means the edge is
  ignoring the directive — report that and stop; do not reach for the CSP.

  Then hash the **browser-shaped** response against the origin, not the bare one:
  ```
  for u in https://py-scratchpad.com/ ; do printf '%-30s ' "$u" ; curl -s -H "User-Agent: $UA" -H "Accept: $AC" "$u" | sha256sum ; done
  ssh "$EDGE_HOST" "curl -s http://$APP_HOST_IP:5040/ | sha256sum"
  ```
  All three hashes must match. And confirm the directive actually arrives:
  ```
  for u in https://py-scratchpad.com/ ; do printf '%-30s ' "$u" ; curl -sI "$u" | grep -i '^cache-control:' ; done
  ```
  Both must read `no-cache, no-transform`.
- `curl -sI http://py-scratchpad.com` returns 301 from the **Cloudflare edge** once
  `always_use_https` is on, so it does not prove the origin. For that, ask the origin directly:
  ```
  curl -sI -H 'Host: py-scratchpad.com' http://$EDGE_HOST_IP/
  curl -sI -H 'Host: www.py-scratchpad.com' http://$EDGE_HOST_IP/
  ```
  Both must be `301` to `https://py-scratchpad.com/`.

---

## 7. Notes

- **Ingress, DNS and monitoring:** both $EDGE_HOST nginx vhosts are §6 above. The Cloudflare
  `python` record and the Uptime Kuma monitor were set up on 2026-10-09; the
  `py-scratchpad.com` zone, its certificate and the monitor's new URL followed the same day.
  None of it needs routine maintenance — the one dated item is the `py-scratchpad.com`
  certificate, which renews itself from `/var/www/letsencrypt` and expires 2027-01-07.
- **`*.py-scratchpad.com` is a wildcard A record** on that zone, pointing at the same WAN IP.
  No vhost claims those names and the certificate does not cover them, so any unused
  subdomain returns Cloudflare 525. Harmless, but it is not a feature.
- **$APP_HOST holds the only source clone** (since 2026-11-21), and it is also the
  deploy directory: `~/bots/py-scratchpad/docker-compose.yml` is the
  file production runs from, so `git pull` there is what moves the pinned tag
  (§2.1). Never run `docker-compose.dev.yml` in it (§3).
- **Base images are pinned by exact tag and digest** in the `Dockerfile`
  (`node:22.23.5-alpine3.24` and `nginx:1.30.8-alpine3.24-slim`), so Dependabot
  can open update PRs automatically and tags cannot silently drift.
  `package.json`'s `engines.node` keeps CI on the same Node major as the image.
- **The build date comes from the source, not the clock.** `vite.config.ts`
  reads `SOURCE_DATE_EPOCH` first, then `git log -1 --format=%cI`. The image has
  no `.git` (`.dockerignore` excludes it), so `release.yml` passes the tagged
  commit's committer date as a `SOURCE_DATE_EPOCH` build arg. A plain local
  `docker build` without that arg produces a working image whose About dialog
  shows the version with **no month** — correct, not broken.
- **The Pyodide runtime is not in git.** `build/pyodide.ts` copies five files
  out of `node_modules/pyodide` into `dist/pyodide/<version>/` during
  `vite build`, plus `vendor/pyodide/LICENSE`. So the runtime version is
  whatever `package-lock.json` pins, and `npm ci` inside the Docker build is
  what fetches it. Bumping it is a `package.json` edit, a lock-file update and
  a new `/pyodide/<version>/` path — nothing on $APP_HOST or $EDGE_HOST changes.
- **`mem_limit: 64m` still holds.** nginx gzipping the 9.6 MB `.wasm` measured
  13.8 MiB with five concurrent fetches. The limit does not need raising for
  0.3.0.
- **The watchtower opt-out label must stay.** The tag is pinned on purpose;
  watchtower would otherwise move the container off the version this file names.
  ($APP_HOST's watchtower runs with `WATCHTOWER_LABEL_ENABLE=true`, i.e. opt-in,
  so the label is belt-and-braces.)
- **Security headers live in `docker/security-headers.conf`** and are included
  by every nginx location that sets an `add_header` of its own. nginx drops all
  inherited `add_header` directives as soon as a location declares one, so a
  new location without that `include` would silently serve the page with no CSP.
- **Docker Hub credentials** are repo secrets `DOCKERHUB_USERNAME` and
  `DOCKERHUB_TOKEN`, referenced only by the `publish` job in `release.yml`,
  after the tests pass. `ci.yml` uses no secrets, so fork pull requests are safe.
