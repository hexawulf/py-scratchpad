# py-scratchpad — static site image.
# Stage 1 builds dist/ with Vite; stage 2 serves it with nginx. Both base images
# are multi-arch (linux/amd64 for linuxsvr, linux/arm64 for piapps2) and pinned
# to an exact patch version so a rebuild is reproducible.

FROM node:22.23.3-alpine3.24 AS build
WORKDIR /app
# Copy the manifests first so the npm layer is cached while sources change.
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.30.5-alpine3.24
# The security headers live in a snippet because an add_header in a location
# block drops every add_header inherited from the server block; each location
# that sets a header has to include the snippet again.
COPY docker/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
