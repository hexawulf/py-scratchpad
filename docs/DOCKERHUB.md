# py-scratchpad

**A Python scratchpad that never leaves your browser tab.**

py-scratchpad is a small, self-hosted editor to keep open next to a course
video or a terminal: Python syntax highlighting, 4-space auto-indent, bracket
matching, search (`Ctrl+F`), comment toggle (`Ctrl+/`), undo history, a light
and dark theme, and import/export of `.py` files that round-trips byte for
byte. There is no backend, no account and no login — the container serves
static files and nothing else. Everything you type is autosaved to your
browser's `localStorage` and never reaches the server, so the image holds no
state, needs no volume and can be replaced at any time.

Source, issues and docs: **[github.com/hexawulf/py-scratchpad](https://github.com/hexawulf/py-scratchpad)**

## Quick start

```sh
docker run -d --name py-scratchpad --restart unless-stopped \
  -p 8080:80 0xwulf/py-scratchpad:0.1.0
```

Then open `http://<host>:8080/`. That is the whole setup: no data directory to
create, no first-run account, no configuration.

The image is happy on a read-only root filesystem if you give nginx its three
writable paths:

```sh
docker run -d --name py-scratchpad --restart unless-stopped \
  -p 8080:80 --read-only \
  --tmpfs /var/cache/nginx --tmpfs /var/run --tmpfs /tmp \
  0xwulf/py-scratchpad:0.1.0
```

## Docker Compose

```yaml
services:
  py-scratchpad:
    image: 0xwulf/py-scratchpad:0.1.0 # pin a release; :latest also exists
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
    healthcheck:
      test: ['CMD', 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1/']
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
```

```sh
docker compose up -d
```

## Tags and platforms

| Tag      | Meaning                                         |
| -------- | ----------------------------------------------- |
| `X.Y.Z`  | one exact release, e.g. `0.1.0`                 |
| `X.Y`    | the newest patch release of that minor line     |
| `latest` | the newest release (pre-releases never move it) |

**Pin `X.Y.Z`.** A pinned tag is immutable, so the container you verified is
the container that comes back after a host reboot or a `docker compose pull`.
`:X.Y` and `:latest` are conveniences for trying it out, and they move under
you. If you run a tag-watcher such as watchtower, exclude this container.

- Platforms: `linux/amd64` and `linux/arm64` (Raspberry Pi 4/5) in one
  multi-arch manifest.
- Images are built and pushed by
  [GitHub Actions](https://github.com/hexawulf/py-scratchpad/actions/workflows/release.yml)
  from GPG-signed git tags, only after lint, the test suite and the production
  build pass on that tag. The workflow refuses to publish if the tag and
  `package.json`'s version disagree.
- Each image carries **SBOM** and **SLSA provenance** attestations:
  `docker buildx imagetools inspect 0xwulf/py-scratchpad:latest --format '{{ json .Provenance }}'`
  (or `.SBOM`).
- OCI labels give the version and the exact source commit
  (`org.opencontainers.image.revision`).

## Container details

| Item        | Value                                                                 |
| ----------- | --------------------------------------------------------------------- |
| Port        | `80` (HTTP, static files)                                             |
| Volume      | none — there is no server-side state to persist                       |
| User        | nginx's default: master as root, worker processes as `nginx`          |
| Healthcheck | not baked in; the Compose snippet above adds one with busybox `wget`  |
| Base        | `nginx:1.30.5-alpine3.24`, built with `node:22.23.3-alpine3.24`       |
| Size        | about 26 MB compressed, 5–15 MiB RAM idle                             |

**Reverse proxy:** serve it over HTTPS on its own hostname. It is plain static
files over HTTP/1.1 — no WebSockets, no server-sent events, no buffering
quirks. The one thing to get right is to **pass the container's response
headers through unchanged** and not add your own `Content-Security-Policy` or
`Cache-Control` at the proxy, or you will end up with duplicates that browsers
resolve to the most restrictive value.

## Security

- **No telemetry, no analytics, no third-party requests.** The page loads only
  from its own origin; the Content-Security-Policy is `default-src 'self'` with
  `object-src 'none'`, `base-uri 'none'` and `frame-ancestors 'none'`. Your
  code is never transmitted anywhere.
- **No source maps.** The bundle ships without them, so the page is a few MB
  smaller and there is nothing extra to fetch. The TypeScript source is on
  GitHub if you want to read it.
- **Read-only root filesystem supported** (see above). The nginx entrypoint
  detects it and skips its config rewrite instead of failing.
- `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer` on every
  response, including error pages.
- **No SPA fallback:** an unknown path returns a real `404`, and error
  responses are sent `Cache-Control: no-store` so a miss is never cached.
- The container writes no files, opens no outbound connections and runs fine
  with `--network` restricted to its published port.

## Changelog

- **0.1.0** — first release. CodeMirror 6 editor with Python highlighting,
  `localStorage` autosave that survives a reload, byte-exact `.py` import and
  export (drag-and-drop, `Ctrl+S`), a multi-tab guard, light/dark theme and
  font-size controls. Multi-arch image with SBOM and provenance.

## Links

- GitHub: https://github.com/hexawulf/py-scratchpad
- Build plan and scope: https://github.com/hexawulf/py-scratchpad/blob/main/docs/PLAN.md
- Deployment and release guide: https://github.com/hexawulf/py-scratchpad/blob/main/docs/DEPLOY.md
- Release workflow: https://github.com/hexawulf/py-scratchpad/actions/workflows/release.yml
- Issues: https://github.com/hexawulf/py-scratchpad/issues
