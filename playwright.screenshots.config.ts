import { defineConfig, devices } from '@playwright/test'

/**
 * The config behind `npm run screenshots`, which takes the README's images.
 *
 * It is separate from `playwright.config.ts` because this is not a test run:
 * `scripts/screenshots.ts` writes PNGs into `docs/screenshots/`, and it must
 * never be picked up by the release gate's `npm run test:e2e`. Sharing the
 * runner is the point, though — Playwright is already a pinned
 * devDependency, so the shots are taken with the same pinned Chromium the
 * smoke test uses, and the runner's TypeScript support means the script needs
 * no loader of its own.
 *
 * Like the smoke test it drives `npm run preview`, i.e. the built `dist/`, so
 * the COOP/COEP headers are present and the page is cross-origin isolated
 * exactly as production serves it. Run `npm run build` first.
 *
 * The viewport is 1280x800; `deviceScaleFactor` is set by the script itself,
 * because it depends on whether a PNG optimiser is installed, and a `test.use`
 * in the script beats anything a project sets here.
 */
const PORT = 4176
const BASE_URL = `http://127.0.0.1:${String(PORT)}`

export default defineConfig({
  testDir: 'scripts',
  testMatch: 'screenshots.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // Pyodide's first load is about 13 MB off disk and a few seconds to start.
  timeout: 180_000,
  expect: { timeout: 60_000 },
  reporter: 'list',

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },

  // The viewport comes after the device preset on purpose: `Desktop Chrome`
  // carries its own 1280x720, and a project's `use` wins over the top-level
  // one.
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
  ],

  webServer: {
    command: `npm run preview -- --port ${String(PORT)} --strictPort`,
    url: `${BASE_URL}/`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
