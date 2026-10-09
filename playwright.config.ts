import { defineConfig, devices } from '@playwright/test'

/**
 * One headless-Chromium smoke test, run against `npm run preview` — the built
 * `dist/`, not the dev server. That matters: the Pyodide runtime only exists
 * in `dist/pyodide/<version>/` after a build, and preview is where the
 * COOP/COEP headers that give the page `crossOriginIsolated` are served the
 * way production serves them.
 *
 * Firefox and WebKit are deliberately not here. This is a smoke test for the
 * build gate, and a second 10 MB WebAssembly download per browser is minutes
 * of CI for little more signal; the manual checklist covers other browsers.
 */
const PORT = 4173

/**
 * `PY_SCRATCHPAD_BASE_URL` points the same suite at an already-running server
 * instead of starting `vite preview`. That is not a convenience: preview is a
 * Vite dev server and types `.mjs` as JavaScript, while **nginx does not** —
 * so a suite that only ever runs against preview cannot see a Content-Type
 * mistake in `docker/nginx.conf`. 0.3.0 shipped with `pyodide.mjs` served as
 * `application/octet-stream`, which broke every Run, and passed this suite.
 *
 * `npm run test:e2e:image` builds the image, runs it and sets this, so the
 * release gate now covers the real serving path.
 */
const BASE_URL = process.env.PY_SCRATCHPAD_BASE_URL ?? `http://127.0.0.1:${String(PORT)}`
const OWN_SERVER = process.env.PY_SCRATCHPAD_BASE_URL === undefined

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: process.env.CI !== undefined,
  retries: 0,
  // Pyodide's first load is about 13 MB off disk and a few seconds to start.
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: process.env.CI === undefined ? 'list' : [['github'], ['list']],

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  ...(OWN_SERVER
    ? {
        webServer: {
          command: `npm run preview -- --port ${String(PORT)} --strictPort`,
          url: `${BASE_URL}/`,
          reuseExistingServer: process.env.CI === undefined,
          timeout: 60_000,
        },
      }
    : {}),
})
