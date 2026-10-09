---
title: py-scratchpad — deploy and update on piapps2
author: 0xWulf
created: 2026-10-09
hosts: [piapps2]
tags: [homelab, docker, nginx, py-scratchpad, runbook]
---

# py-scratchpad — deploy and update (piapps2)

Static site, no backend and no server-side state. Everything the user types
lives in their browser's `localStorage` under `py-scratchpad:v1`, so the
container holds nothing worth backing up and can be rebuilt or thrown away at
any time.

| Thing | Value |
|---|---|
| Host | piapps2, `192.168.50.120` (eth0 — never `.179`/wlan0) |
| Checkout | `/home/zk/bots/py-scratchpad` (pull-only; commits are made on linuxsvr) |
| Compose file | `/home/zk/bots/py-scratchpad/docker-compose.yml` |
| Container | `py-scratchpad` |
| Image | `py-scratchpad:local` (built on the host, so watchtower is opted out) |
| LAN endpoint | `http://192.168.50.120:5040/` |
| Public URL | `https://python.piapps.dev` (piapps nginx vhost — see PLAN.md §6) |

All commands use `docker compose -f` with an absolute path, so they work from
any working directory.

---

## 1. Update procedure

Run from linuxsvr. Each step has its own verification.

**1.1 Pull.** Fast-forward only; this checkout never carries local commits.

```
ssh piapps2 'git -C /home/zk/bots/py-scratchpad pull --ff-only ; git -C /home/zk/bots/py-scratchpad log --oneline -1'
```

If the pull is refused, the checkout has drifted. Do not force it — inspect
with `git -C /home/zk/bots/py-scratchpad status -sb` and resolve by hand.

**1.2 Rebuild and restart.** Compose rebuilds the image and recreates the
container; the old container is replaced only once the build succeeds.

```
ssh piapps2 'docker compose -f /home/zk/bots/py-scratchpad/docker-compose.yml up -d --build'
```

The first build on arm64 takes a few minutes (`npm ci` plus `vite build`);
later builds reuse the npm layer unless `package-lock.json` changed.

**1.3 Verify on the host.** The container must report `healthy`, keep its
read-only rootfs, and stay well under the 64 MB cap.

```
ssh piapps2 'docker compose -f /home/zk/bots/py-scratchpad/docker-compose.yml ps ; docker inspect -f "health={{.State.Health.Status}} read_only={{.HostConfig.ReadonlyRootfs}} mem={{.HostConfig.Memory}}" py-scratchpad ; docker stats --no-stream py-scratchpad'
```

**1.4 Verify over the LAN.** This is the real check: it proves the
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
- `/assets/*.js.map` → `404`. Source maps are off in `vite.config.ts`; a `200`
  means they were switched back on and the TypeScript source is being published.

Get the current hashed filename from the page itself:

```
curl -s http://192.168.50.120:5040/ | grep -o '/assets/[^"]*\.js'
```

**1.5 After an update that changes headers or caching,** re-check through the
public vhost too, since piapps nginx must pass the container's headers through
without adding its own:

```
curl -sI https://python.piapps.dev/
```

---

## 2. Rollback

In order, least to most destructive. There is no data to preserve.

**2.1 Stop the service.** Releases port 5040, keeps the checkout and the image.

```
ssh piapps2 'docker compose -f /home/zk/bots/py-scratchpad/docker-compose.yml down'
```

**2.2 Roll back to an earlier commit.** Check out the previous good commit and
rebuild from it. Find it with
`git -C /home/zk/bots/py-scratchpad log --oneline -10`.

```
ssh piapps2 'git -C /home/zk/bots/py-scratchpad checkout <sha> ; docker compose -f /home/zk/bots/py-scratchpad/docker-compose.yml up -d --build'
```

Return to the branch afterwards with
`git -C /home/zk/bots/py-scratchpad checkout main`, then re-run §1.2.

**2.3 Drop the image.** Only after §2.1; the next `up -d --build` recreates it.

```
ssh piapps2 'docker image rm py-scratchpad:local'
```

**2.4 Remove the checkout.** Needs operator confirmation, as always. A fresh
`git clone git@github.com:hexawulf/py-scratchpad.git /home/zk/bots/py-scratchpad`
is a complete restore, so this loses nothing — but do not run it reflexively.

---

## 3. Notes

- **Ingress, DNS and monitoring are not covered here.** The piapps nginx vhost,
  the Cloudflare `python` record and the Uptime Kuma monitor are PLAN.md §6–§7
  and sit behind the operator approval gate.
- **Base images are pinned exactly** in the `Dockerfile`
  (`node:22.23.3-alpine3.24`, `nginx:1.30.5-alpine3.24`). Bumping them is a
  deliberate commit, not something a rebuild does on its own.
- **The watchtower opt-out label must stay.** The image is built on the host,
  so there is no registry tag for watchtower to follow. (piapps2's watchtower
  runs with `WATCHTOWER_LABEL_ENABLE=true`, i.e. opt-in, so the label is
  belt-and-braces.)
- **Security headers live in `docker/security-headers.conf`** and are included
  by every nginx location that sets an `add_header` of its own. nginx drops all
  inherited `add_header` directives as soon as a location declares one, so a
  new location without that `include` would silently serve the page with no CSP.
