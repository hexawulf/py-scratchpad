import { defineConfig } from 'vite'

// Static site, served from the domain root behind nginx.
// Everything must be bundled or vendored: no runtime CDN requests (CSP is default-src 'self').
export default defineConfig({
  base: '/',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
})
