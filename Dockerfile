# syntax=docker/dockerfile:1
# py-scratchpad — static site image.
# Stage 1 builds dist/ with Vite; stage 2 serves it with nginx-slim. Base
# images are literal and pinned by exact tag + multi-arch digest so Dependabot
# can update them automatically and tags cannot silently drift. Note that
# byte-reproducibility applies to the dist/ web bundle (via SOURCE_DATE_EPOCH);
# Stage 2 runs `apk upgrade --no-cache` to pull Alpine security fixes.
#
#   docker buildx build --platform linux/amd64,linux/arm64 -t 0xwulf/py-scratchpad .
#   docker build -t py-scratchpad:dev .     # local, this machine's arch

# --- build: produce dist/ -----------------------------------------------------
# $BUILDPLATFORM-pinned: dist/ is byte-identical on every arch, so the bundle is
# built once natively instead of a second time under QEMU emulation.
FROM --platform=$BUILDPLATFORM node:26.13.1-alpine3.24@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS build
# The About dialog's build date comes from the source's own timestamp, never
# from the build clock (see vite.config.ts). .dockerignore excludes .git, so
# `git log` cannot be the source here: release.yml passes the tagged commit's
# committer date as SOURCE_DATE_EPOCH. Left empty — as a plain local
# `docker build` does — the dialog shows the version with no month.
ARG SOURCE_DATE_EPOCH=
ENV SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}
WORKDIR /app
# Copy the manifests first so the npm layer is cached while sources change.
COPY .npmrc package.json package-lock.json ./
RUN npm ci --ignore-scripts
# Copy only build inputs explicitly rather than the entire context.
COPY index.html vite.config.ts tsconfig.json ./
COPY build ./build
COPY public ./public
COPY src ./src
COPY vendor ./vendor
RUN npm run build

# --- runtime: serve dist/ -----------------------------------------------------
FROM nginx:1.30.8-alpine3.24-slim@sha256:e9eaa7298465eab06d618c51556fdcf3fb5061f9ff40bd28ee898fbd7ee7f900
# The nginx tag is rebuilt upstream only now and then, so pull in Alpine's
# security fixes at build time. release.yml's Trivy gate fails a release on a
# fixable CRITICAL; 0.3.5 shipped with brotli-libs CVE-2026-111497 unpatched.
RUN apk upgrade --no-cache
ARG VERSION=dev
ARG REVISION=unknown

LABEL org.opencontainers.image.title="py-scratchpad" \
      org.opencontainers.image.description="Browser-only Python scratchpad: CodeMirror 6 editor, localStorage autosave, no backend" \
      org.opencontainers.image.source="https://github.com/hexawulf/py-scratchpad" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

# The security headers live in a snippet because an add_header in a location
# block drops every add_header inherited from the server block; each location
# that sets a header has to include the snippet again.
COPY docker/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
