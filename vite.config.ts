import { readFileSync } from 'node:fs'

import { defineConfig } from 'vite'

// Static site, served from the domain root behind nginx.
// Everything must be bundled or vendored: no runtime CDN requests (CSP is default-src 'self').

/**
 * Dependencies the About dialog names. Their versions are read from
 * package.json at build time, so the dialog cannot claim a version the lock
 * file no longer has.
 */
const SHOWN_DEPENDENCIES = [
  'codemirror',
  '@codemirror/lang-python',
  '@codemirror/theme-one-dark',
  'typescript',
  'vite',
  'vitest',
  'eslint',
  'typescript-eslint',
]

interface PackageJson {
  version: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

/**
 * The `__BUILD_INFO__` payload: version, build timestamp and the dependency
 * versions above, as one JSON string. `src/about.ts` parses it and formats the
 * date as a month, so the dialog never hard-codes a version string.
 */
function buildInfo(): string {
  const pkg = JSON.parse(
    readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
  ) as PackageJson

  const declared: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies }
  const deps: Record<string, string> = {}
  for (const name of SHOWN_DEPENDENCIES) {
    const version = declared[name]
    if (version !== undefined) deps[name] = version
  }

  return JSON.stringify({ version: pkg.version, date: new Date().toISOString(), deps })
}

export default defineConfig({
  base: '/',
  // JSON.stringify twice: define takes a JS expression, so the payload has to
  // arrive as a quoted string literal.
  define: {
    __BUILD_INFO__: JSON.stringify(buildInfo()),
  },
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
