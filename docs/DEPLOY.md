---
title: py-scratchpad — release and deploy on piapps2
author: 0xWulf
created: 2026-10-09
hosts: [piapps2]
tags: [homelab, docker, dockerhub, nginx, py-scratchpad, runbook]
---

# py-scratchpad — release and deploy (piapps2)

Static site, no backend and no server-side state. Everything the user types
lives in their browser's `localStorage` under `py-scratchpad:v1`, so the
container holds nothing worth backing up and can be replaced at any time.

The image is built by GitHub Actions on a pushed tag and published to Docker
Hub. piapps2 **pulls a pinned tag** and never builds; it holds one file.

| Thing | Value |
|---|---|
| Host | piapps2, `192.168.50.120` (eth0 — never `.179`/wlan0) |
| Compose file | `/home/zk/bots/py-scratchpad/docker-compose.yml` (a copy of the repo's, not a checkout) |
| Container | `py-scratchpad` |
| Image | `0xwulf/py-scratchpad:X.Y.Z` — pinned, so watchtower is opted out |
| LAN endpoint | `http://192.168.50.120:5040/` |
| Public URL | `https://python.piapps.dev` (piapps nginx vhost — see §6 below) |

All commands use `docker compose -f` with an absolute path, so they work from
any working directory.

---

## 1. Cutting a release

Run from linuxsvr, in `/home/zk/projects/python/py-scratchpad`.

**1.1 Pass the local gate.**

```
npm run lint && npm test && npm run build
```

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
expected. The workflow also moves `:X.Y` and `:latest`; piapps2 pins the full
`:X.Y.Z` regardless, so nothing on the host floats.

---

## 2. Deploying to piapps2

**2.1 Bump the pinned tag in both copies.** The tag appears in the repo's
`docker-compose.yml` and in piapps2's copy, so update the repo file, then copy
it over and prove the two are identical.

```
scp /home/zk/projects/python/py-scratchpad/docker-compose.yml piapps2:/home/zk/bots/py-scratchpad/docker-compose.yml
sha256sum /home/zk/projects/python/py-scratchpad/docker-compose.yml
ssh piapps2 'sha256sum /home/zk/bots/py-scratchpad/docker-compose.yml'
```

The two checksums must match. Commit the repo change with the release.

**2.2 Pull the image.** The running container keeps serving while this runs.

```
ssh piapps2 'docker compose -f /home/zk/bots/py-scratchpad/docker-compose.yml pull'
```

**2.3 Recreate the container.**

```
ssh piapps2 'docker compose -f /home/zk/bots/py-scratchpad/docker-compose.yml up -d'
```

**2.4 Verify on the host.** The container must report `healthy`, keep its
read-only rootfs, run the expected image digest, and stay under the 64 MB cap.

```
ssh piapps2 'docker compose -f /home/zk/bots/py-scratchpad/docker-compose.yml ps ; docker inspect -f "health={{.State.Health.Status}} read_only={{.HostConfig.ReadonlyRootfs}} mem={{.HostConfig.Memory}} image={{.Config.Image}}" py-scratchpad ; docker stats --no-stream py-scratchpad'
```

**2.5 Verify over the LAN.** This is the real check: it proves the
`192.168.50.120:5040` binding, the headers and the cache policy.

```
curl -sI http://192.168.50.120:5040/
curl -s http://192.168.50.120:5040/ | grep -o '<title>[^<]*</title>'
curl -s -o /dev/null -w 'status=%{http_code}\n' http://192.168.50.120:5040/does-not-exist
```

Expected:

- `/` → `200`, `Cache-Control: no-cache`, plus `Content-Security-Policy`,
  `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.
- the title is `py-scratchpad` (Uptime Kuma matches on this keyword).
- a path that does not exist → `404`, `Cache-Control: no-store`. There is no
  SPA fallback, so a `200` here means the config regressed.
- the hashed `/assets/*` file → `200`, `Cache-Control: public, max-age=31536000, immutable`.
- `/assets/*.js.map` → `404`. Source maps are off in `vite.config.ts`: the
  repo is public, so a map hides nothing, and it would add about 2 MB to every
  deploy for no benefit. A `200` here means they were switched back on.

Get the current hashed filename from the page itself:

```
curl -s http://192.168.50.120:5040/ | grep -o '/assets/[^"]*\.js'
```

**2.6 After a release that changes headers or caching,** re-check through the
public vhost too, since piapps nginx must pass the container's headers through
without adding its own:

```
curl -sI https://python.piapps.dev/
```

---

## 3. Local development build

piapps2's compose file pulls a pinned release and has no `build:`. To build and
run the working tree on a workstation, add `docker-compose.dev.yml`, which
builds the tree, tags it `py-scratchpad:dev` and binds to loopback:

```
docker compose -f /home/zk/projects/python/py-scratchpad/docker-compose.yml -f /home/zk/projects/python/py-scratchpad/docker-compose.dev.yml up -d --build
curl -sI http://127.0.0.1:5040/
docker compose -f /home/zk/projects/python/py-scratchpad/docker-compose.yml -f /home/zk/projects/python/py-scratchpad/docker-compose.dev.yml down
```

---

## 4. Rollback

In order, least to most destructive. There is no data to lose at any point.

**4.1 Stop the service.** Releases port 5040, keeps everything else.

```
ssh piapps2 'docker compose -f /home/zk/bots/py-scratchpad/docker-compose.yml down'
```

**4.2 Pin the previous version.** Edit the tag in both copies back to the last
good `X.Y.Z` (§2.1), then `pull` and `up -d`. Published tags are immutable, so
the earlier image is still there. This is the normal rollback.

**4.3 Fall back to a local build.** If Docker Hub or the registry is the
problem, build the previous tag on the host instead:

```
ssh piapps2 'git clone --branch v0.1.0 --depth 1 git@github.com:hexawulf/py-scratchpad.git /home/zk/bots/py-scratchpad-src ; docker build -t py-scratchpad:fallback /home/zk/bots/py-scratchpad-src'
```

Then point the compose file's `image:` at `py-scratchpad:fallback` and `up -d`.

**4.4 Restore the pre-Docker-Hub state.** The clone that built the image
locally was moved aside, not deleted:

```
ssh piapps2 'ls -ld /home/zk/backups/py-scratchpad.bak_*'
```

That directory still carries the old `build:`-style compose file and the full
source, so `docker compose -f <that dir>/docker-compose.yml up -d --build`
reproduces the pre-release deployment exactly.

**4.5 Drop an image.** Only after a `down`; the next `pull` fetches it again.

```
ssh piapps2 'docker image rm 0xwulf/py-scratchpad:0.1.0'
```

**4.6 Deleting the backup directory or a Docker Hub tag** needs operator
confirmation and is never part of a rollback.

---

## 6. Public ingress (piapps nginx vhost)

Live since 2026-10-09. **Production nginx on piapps is an operator approval gate** —
read this section, then propose, then wait for approval before touching it.

| Thing | Value |
|---|---|
| Vhost file | `/etc/nginx/sites-available/python.piapps.dev` (symlinked into `sites-enabled`) |
| Reference it was copied from | `/etc/nginx/sites-available/stocky.piapps.dev` |
| Backend | `proxy_pass http://192.168.50.120:5040` |
| TLS | shared wildcard `piapps.dev-0001` — `/etc/letsencrypt/live/piapps.dev-0001/` |
| Cloudflare | `python.piapps.dev` A → `122.116.150.249`, **Proxied**, zone SSL mode Full (strict) |
| Monitor | Uptime Kuma id 60, `py-scratchpad`, keyword monitor, keyword `py-scratchpad` |

**The certificate needs no work, ever.** `piapps.dev-0001` is a wildcard (SAN `piapps.dev` +
`*.piapps.dev`), so `python.piapps.dev` is already covered — exactly as `stocky` and `kuma` are,
and none of the three has a renewal config of its own. It renews itself via DNS-01
(`authenticator = dns-cloudflare`) with `renew_hook = systemctl reload nginx`.
**Never delete this certificate while rolling back a single vhost:** it serves `piapps.dev` and
every subdomain.

**No `add_header` belongs in this vhost.** The container owns the security headers
(`docker/security-headers.conf`) and nothing on piapps adds headers at http level, in `conf.d/`
or in `snippets/`. An `add_header` here would make each one appear **twice** on the public URL.
`cloudflare_real_ip.conf` is likewise already loaded at http level — do not include it per-vhost.

### 6.1 Changing the vhost

Never edit it in place. Write the file locally, copy it, install it, then test and reload:

```
scp /path/to/python.piapps.dev piapps:/tmp/python.piapps.dev
ssh piapps 'sudo nginx -T > /home/zk/backups/piapps-nginx-T.bak_$(date +%Y%m%d_%H%M%S)'
ssh piapps 'sudo install -m 644 -o root -g root /tmp/python.piapps.dev /etc/nginx/sites-available/python.piapps.dev'
ssh piapps 'sudo nginx -t'
ssh piapps 'sudo systemctl reload nginx'
ssh piapps 'sudo journalctl -u nginx --since "5 min ago" --no-pager ; rm -f /tmp/python.piapps.dev'
```

`reload`, never `restart` — a restart drops every other site on piapps with it.

**Always regression-check the other vhosts on that nginx afterwards.** They share the process
and the wildcard cert:

```
for u in https://stocky.piapps.dev https://kuma.piapps.dev https://piapps.dev ; do printf '%-34s ' "$u" ; curl -s -o /dev/null -w '%{http_code}\n' "$u" ; done
```

Expected, unchanged: `stocky 200`, `kuma 302`, `piapps.dev 200`.

### 6.2 Rollback

Removing the symlink is the whole rollback; the `sites-available` file and the certificate stay.

```
ssh piapps 'sudo rm /etc/nginx/sites-enabled/python.piapps.dev'
ssh piapps 'sudo nginx -t ; sudo systemctl reload nginx'
```

The hostname then returns Cloudflare **525** again — the `443 default_server` has
`ssl_reject_handshake on`, so an SNI no vhost claims is refused at the handshake. That is the
expected post-rollback state, not a fault.

### 6.3 Verifying the public URL

```
curl -sI https://python.piapps.dev/
curl -sI https://python.piapps.dev/assets/<hashed>.js
curl -s -o /dev/null -w '%{http_code}\n' https://python.piapps.dev/does-not-exist
```

- `/` → `200`, `cache-control: no-cache`; `/assets/*` → `200`, `public, max-age=31536000, immutable`;
  `*.js.map` and an unknown path → `404`, `no-store`.
- **Each security header must appear exactly once.** Count them, don't eyeball presence:
  ```
  H=$(curl -sI https://python.piapps.dev/) ; for h in content-security-policy x-content-type-options referrer-policy cache-control ; do printf '%-28s %s\n' "$h" "$(printf '%s\n' "$H" | grep -c -i "^$h:")" ; done
  ```
- **Prove Cloudflare is not rewriting the page.** The zone has Web Analytics with
  `auto_install: true`, which *could* inject `static.cloudflareinsights.com/beacon.min.js` — that
  would break the no-CDN rule and trip `script-src 'self'`. It is not injecting today; this is the
  check that would catch it:
  ```
  curl -s https://python.piapps.dev/ | sha256sum
  ssh piapps 'curl -s http://192.168.50.120:5040/ | sha256sum'
  ```
  The two must match. If they ever diverge, turn auto-install off for the zone — **do not** widen
  the CSP to accommodate it.
- `curl -sI http://python.piapps.dev` returns 301 from the **Cloudflare edge**
  (`always_use_https` is on), so it does not prove the origin. For that, ask the origin directly:
  ```
  curl -sI -H 'Host: python.piapps.dev' http://192.168.50.102/
  ```

---

## 7. Notes

- **Ingress, DNS and monitoring:** the piapps nginx vhost is §6 above. The Cloudflare `python`
  record and the Uptime Kuma monitor were set up in the same step (2026-10-09) and need no
  routine maintenance.
- **piapps2 is not a git checkout.** It holds `docker-compose.yml` and nothing
  else, matching `/home/zk/bots/stocky`. The repo is the source of truth; §2.1
  copies the file and checksums both ends.
- **Base images are pinned exactly** in the `Dockerfile` as build args
  (`NODE_VERSION=22.23.3`, `ALPINE_VERSION=3.24`, `NGINX_VERSION=1.30.5`).
  Bumping them is a deliberate commit, not something a rebuild does on its own.
  `package.json`'s `engines.node` keeps CI on the same Node major as the image.
- **The watchtower opt-out label must stay.** The tag is pinned on purpose;
  watchtower would otherwise move the container off the version this file names.
  (piapps2's watchtower runs with `WATCHTOWER_LABEL_ENABLE=true`, i.e. opt-in,
  so the label is belt-and-braces.)
- **Security headers live in `docker/security-headers.conf`** and are included
  by every nginx location that sets an `add_header` of its own. nginx drops all
  inherited `add_header` directives as soon as a location declares one, so a
  new location without that `include` would silently serve the page with no CSP.
- **Docker Hub credentials** are repo secrets `DOCKERHUB_USERNAME` and
  `DOCKERHUB_TOKEN`, referenced only by the `publish` job in `release.yml`,
  after the tests pass. `ci.yml` uses no secrets, so fork pull requests are safe.
