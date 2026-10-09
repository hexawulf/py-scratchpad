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
const BASE_URL = `http://127.0.0.1:${String(PORT)}`

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

  webServer: {
    command: `npm run preview -- --port ${String(PORT)} --strictPort`,
    url: `${BASE_URL}/`,
    reuseExistingServer: process.env.CI === undefined,
    timeout: 60_000,
  },
})
