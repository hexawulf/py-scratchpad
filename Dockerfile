# syntax=docker/dockerfile:1
# py-scratchpad — static site image.
# Stage 1 builds dist/ with Vite; stage 2 serves it with nginx. Both base images
# are multi-arch (linux/amd64 for linuxsvr, linux/arm64 for piapps2) and pinned
# to an exact patch version so a rebuild is reproducible.
#
#   docker buildx build --platform linux/amd64,linux/arm64 -t 0xwulf/py-scratchpad .
#   docker build -t py-scratchpad:dev .     # local, this machine's arch

ARG NODE_VERSION=22.23.3
ARG ALPINE_VERSION=3.24
ARG NGINX_VERSION=1.30.5

# --- build: produce dist/ -----------------------------------------------------
# $BUILDPLATFORM-pinned: dist/ is byte-identical on every arch, so the bundle is
# built once natively instead of a second time under QEMU emulation.
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS build
WORKDIR /app
# Copy the manifests first so the npm layer is cached while sources change.
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# --- runtime: serve dist/ -----------------------------------------------------
FROM nginx:${NGINX_VERSION}-alpine${ALPINE_VERSION}
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
