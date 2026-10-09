import { defineConfig } from 'vite'

// Static site, served from the domain root behind nginx.
// Everything must be bundled or vendored: no runtime CDN requests (CSP is default-src 'self').
export default defineConfig({
  base: '/',
  build: {
    // No source maps in the published build: the repo is private, and a .map
    // ships the full TypeScript source to anyone who loads the page.
    sourcemap: false,
    target: 'es2022',
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
})
