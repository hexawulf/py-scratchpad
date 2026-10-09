import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import { defineConfig } from 'vite'

import { pyodideIndexUrl, pyodidePlugin, pyodideVersion } from './build/pyodide.ts'

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
 * The build date, which must not come from the build clock.
 *
 * `new Date()` would make every build of the same source produce a different
 * bundle, so two builds could never be compared and a published image could
 * not be reproduced from its tag. The source's own timestamp is used instead,
 * in the order the reproducible-builds convention prescribes:
 *
 *  1. `SOURCE_DATE_EPOCH` (seconds since the epoch) when it is set — this is
 *     how the Docker build gets it, since `.dockerignore` excludes `.git`;
 *     `release.yml` passes the tagged commit's timestamp as a build arg.
 *  2. the last commit's committer date, for an ordinary build in a checkout.
 *  3. `''` — unknown. `about.ts` then shows the version with no month rather
 *     than inventing one.
 *
 * A dirty working tree deliberately reports the last commit's date: the date
 * identifies the source, not the moment `vite build` ran.
 */
function buildDate(): string {
  const epoch = process.env.SOURCE_DATE_EPOCH
  if (epoch !== undefined && /^\d+$/.test(epoch.trim())) {
    const date = new Date(Number(epoch.trim()) * 1000)
    if (!Number.isNaN(date.getTime())) return date.toISOString()
  }

  try {
    const iso = execFileSync('git', ['log', '-1', '--format=%cI'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    // Normalise to UTC, so the same commit built in two time zones agrees.
    const date = new Date(iso)
    return Number.isNaN(date.getTime()) ? '' : date.toISOString()
  } catch {
    return ''
  }
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

  return JSON.stringify({ version: pkg.version, date: buildDate(), deps })
}

const PYODIDE_VERSION = pyodideVersion()

export default defineConfig({
  base: '/',
  plugins: [pyodidePlugin()],
  // JSON.stringify twice: define takes a JS expression, so the payload has to
  // arrive as a quoted string literal.
  define: {
    __BUILD_INFO__: JSON.stringify(buildInfo()),
    // The runtime's version and the URL it is served from. Both come from the
    // installed package, so the path the worker asks for and the path the
    // build wrote can never disagree.
    __PYODIDE_VERSION__: JSON.stringify(PYODIDE_VERSION),
    __PYODIDE_INDEX_URL__: JSON.stringify(pyodideIndexUrl(PYODIDE_VERSION)),
  },
  build: {
    // No source maps in the published build: the repo is private, and a .map
    // ships the full TypeScript source to anyone who loads the page.
    sourcemap: false,
    target: 'es2022',
  },
  worker: {
    // The Pyodide worker is a module worker: it uses a dynamic import() for
    // pyodide.mjs, which a classic worker cannot do. Pyodide itself refuses to
    // start in a classic worker ("Classic web workers are not supported").
    format: 'es',
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
})
