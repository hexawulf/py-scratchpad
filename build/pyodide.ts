/**
 * Staging the Pyodide runtime, at build time and in dev.
 *
 * The no-CDN rule (CSP `default-src 'self'`, `connect-src 'self'`) means every
 * byte Pyodide loads has to come from this origin. The `pyodide` npm package
 * ships thirteen files; the core runtime needs five of them, and the rest —
 * the CommonJS entry point, the two source maps, the `.d.ts` bundles and the
 * two `console.html` demos — are build-time or documentation files that would
 * only inflate the image. No packages are shipped at all: v0.3 is stdlib only,
 * so `micropip` and `loadPackage` are never called and `pyodide-lock.json`
 * exists purely because `loadPyodide` reads it before deciding there is
 * nothing to install.
 *
 * The files are **not** committed. They are copied from `node_modules` into
 * `dist/pyodide/<version>/` on a build, and served straight out of
 * `node_modules` by a dev middleware, so the version in the path is always the
 * version in `package-lock.json` and the two can never drift.
 *
 * Why a version in the path: `/pyodide/314.0.7/pyodide.asm.wasm` is immutable
 * the way Vite's hashed `/assets/*` names are, so nginx can cache it for a
 * year (see `docker/nginx.conf`). A bump changes the path, not the contents of
 * a path, so no cache anywhere has to be busted by hand.
 */

import { copyFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Plugin } from 'vite'

/** URL prefix the worker builds its `indexURL` from. */
export const PYODIDE_URL_PREFIX = '/pyodide'

/**
 * The files `loadPyodide` actually requests, in load order:
 *
 *  - `pyodide.mjs` — the JS API. Loaded as a module from this origin rather
 *    than bundled: its Node branch `import`s `node:fs`, `node:vm` and `ws`,
 *    which a bundler has to be talked out of resolving, and serving it keeps
 *    the worker chunk small.
 *  - `pyodide-lock.json` — the package index, fetched from `indexURL` before
 *    the interpreter starts.
 *  - `pyodide.asm.mjs` — the Emscripten glue, `import()`ed from `indexURL`.
 *  - `pyodide.asm.wasm` — CPython itself, instantiated by streaming.
 *  - `python_stdlib.zip` — mounted as `/lib/python314.zip`.
 */
export const PYODIDE_RUNTIME_FILES: readonly string[] = [
  'pyodide.mjs',
  'pyodide-lock.json',
  'pyodide.asm.mjs',
  'pyodide.asm.wasm',
  'python_stdlib.zip',
]

/** Pyodide's own licence, published next to the files it covers. */
export const PYODIDE_LICENCE_SOURCE = 'vendor/pyodide/LICENSE'
export const PYODIDE_LICENCE_NAME = 'LICENSE'

interface PyodidePackageJson {
  version: string
}

const require = createRequire(import.meta.url)

/** The installed `pyodide` package directory, resolved through Node. */
export function pyodideDir(): string {
  return dirname(require.resolve('pyodide/package.json'))
}

/** The exact installed version, read from the package rather than guessed. */
export function pyodideVersion(): string {
  const pkg = JSON.parse(
    readFileSync(join(pyodideDir(), 'package.json'), 'utf8'),
  ) as PyodidePackageJson
  return pkg.version
}

/** `/pyodide/314.0.7/` — with the trailing slash `loadPyodide` expects. */
export function pyodideIndexUrl(version: string): string {
  return `${PYODIDE_URL_PREFIX}/${version}/`
}

/** `text/javascript` and friends, by extension. Only these five types ship. */
export function contentTypeFor(name: string): string {
  if (name.endsWith('.mjs') || name.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (name.endsWith('.wasm')) return 'application/wasm'
  if (name.endsWith('.json')) return 'application/json; charset=utf-8'
  if (name.endsWith('.zip')) return 'application/zip'
  return 'text/plain; charset=utf-8'
}

/**
 * Where a request under `/pyodide/<version>/` is served from, or null when it
 * is not one of the files this build publishes. Exported so a test can check
 * the guard without starting a server: the dev middleware reads from
 * `node_modules`, so it must never turn a crafted path into a file read.
 */
export function resolveRuntimeRequest(urlPath: string, version: string): string | null {
  const prefix = pyodideIndexUrl(version)
  if (!urlPath.startsWith(prefix)) return null

  const name = urlPath.slice(prefix.length)
  if (PYODIDE_RUNTIME_FILES.includes(name)) return join(pyodideDir(), name)
  if (name === PYODIDE_LICENCE_NAME) return join(repoRoot(), PYODIDE_LICENCE_SOURCE)
  return null
}

/** The repository root: this file lives in `build/`, one level below it. */
function repoRoot(): string {
  return fileURLToPath(new URL('..', import.meta.url))
}

export interface PyodideStageResult {
  version: string
  /** Published path → bytes copied, for the build log. */
  files: { name: string; bytes: number }[]
}

/** Copy the runtime and its licence into `<outDir>/pyodide/<version>/`. */
export function stagePyodide(outDir: string, version: string): PyodideStageResult {
  const target = join(outDir, 'pyodide', version)
  mkdirSync(target, { recursive: true })

  const source = pyodideDir()
  const files: { name: string; bytes: number }[] = []

  for (const name of PYODIDE_RUNTIME_FILES) {
    const from = join(source, name)
    copyFileSync(from, join(target, name))
    files.push({ name, bytes: statSync(from).size })
  }

  const licence = join(repoRoot(), PYODIDE_LICENCE_SOURCE)
  copyFileSync(licence, join(target, PYODIDE_LICENCE_NAME))
  files.push({ name: PYODIDE_LICENCE_NAME, bytes: statSync(licence).size })

  return { version, files }
}

/**
 * The plugin. On a build it stages the files into `dist/`; in dev and preview
 * it serves them out of `node_modules`, so `npm run dev` needs no copy step
 * and `public/` stays empty of 13 MB of binaries.
 *
 * `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` are set on
 * every dev and preview response, because `crossOriginIsolated` — and with it
 * `SharedArrayBuffer`, the interrupt buffer and the `input()` bridge — is only
 * true when they are. Production sets them in `docker/security-headers.conf`;
 * setting them here is what makes dev behave like prod.
 */
export function pyodidePlugin(): Plugin {
  const version = pyodideVersion()

  function serve(server: {
    middlewares: {
      use: (
        handler: (
          req: { url?: string },
          res: {
            setHeader: (name: string, value: string) => void
            statusCode: number
            end: (body?: string | Uint8Array) => void
          },
          next: () => void,
        ) => void,
      ) => void
    }
  }): void {
    server.middlewares.use((req, res, next) => {
      // Isolation is a document-level property, so the headers belong on every
      // response the server makes, not only on the runtime files.
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')

      const urlPath = (req.url ?? '').split('?')[0]
      if (urlPath === undefined || !urlPath.startsWith(`${PYODIDE_URL_PREFIX}/`)) {
        next()
        return
      }

      const file = resolveRuntimeRequest(urlPath, version)
      if (file === null) {
        res.statusCode = 404
        res.end('404 Not Found\n')
        return
      }

      res.setHeader('Content-Type', contentTypeFor(urlPath))
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
      res.end(readFileSync(file))
    })
  }

  return {
    name: 'py-scratchpad:pyodide',

    configureServer: serve,
    configurePreviewServer: serve,

    // writeBundle, not generateBundle: the files are copied straight to disk
    // rather than held in rollup's asset map, which keeps a 9.6 MB wasm out of
    // the bundler's memory.
    writeBundle(options) {
      const outDir = options.dir ?? 'dist'
      const staged = stagePyodide(outDir, version)
      const total = staged.files.reduce((sum, file) => sum + file.bytes, 0)
      this.info(
        `pyodide ${version}: ${String(staged.files.length)} files, ${(total / 1024 / 1024).toFixed(1)} MB → ${posix.join(outDir, 'pyodide', version)}/`,
      )
    },
  }
}
