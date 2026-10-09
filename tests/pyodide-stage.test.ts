/**
 * What gets published alongside the bundle, and under which headers.
 *
 * The Pyodide runtime is the one part of this site that is neither written
 * here nor hashed by Vite, so three things have to be asserted rather than
 * assumed: that exactly the files the runtime asks for are staged (no more, so
 * the image does not carry 2 MB of source maps and demo pages; no fewer, or
 * the first Run 404s), that the licence travels with them, and that nginx
 * serves them with the right type and cache policy.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  contentTypeFor,
  PYODIDE_LICENCE_NAME,
  PYODIDE_LICENCE_SOURCE,
  PYODIDE_RUNTIME_FILES,
  PYODIDE_URL_PREFIX,
  pyodideDir,
  pyodideIndexUrl,
  pyodideVersion,
  resolveRuntimeRequest,
} from '../build/pyodide.ts'

const repoRoot = new URL('..', import.meta.url)
const read = (path: string): string => readFileSync(new URL(path, repoRoot), 'utf8')

/** A TypeScript file with its comments removed, so prose about a hazard is not it. */
const readCode = (path: string): string =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')

const PACKAGE_JSON = JSON.parse(read('package.json')) as {
  dependencies: Record<string, string>
}
const NGINX = read('docker/nginx.conf')
const HEADERS = read('docker/security-headers.conf')
const VITE_CONFIG = read('vite.config.ts')
const PYODIDE_PLUGIN = read('build/pyodide.ts')
const GITIGNORE = read('.gitignore')

describe('the pinned Pyodide version', () => {
  it('is exact in package.json, with no range', () => {
    const pinned = PACKAGE_JSON.dependencies.pyodide
    expect(pinned).toBeDefined()
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('is read from the installed package, so the path cannot drift from the lock file', () => {
    expect(pyodideVersion()).toBe(PACKAGE_JSON.dependencies.pyodide)
  })

  it('puts the version in the URL, which is what makes the path immutable', () => {
    expect(pyodideIndexUrl('314.0.7')).toBe('/pyodide/314.0.7/')
    // The trailing slash is not cosmetic: loadPyodide concatenates onto it.
    expect(pyodideIndexUrl(pyodideVersion()).endsWith('/')).toBe(true)
    expect(PYODIDE_URL_PREFIX).toBe('/pyodide')
  })
})

describe('the files that are staged', () => {
  it('are the five the runtime loads, and all of them exist', () => {
    expect([...PYODIDE_RUNTIME_FILES]).toEqual([
      'pyodide.mjs',
      'pyodide-lock.json',
      'pyodide.asm.mjs',
      'pyodide.asm.wasm',
      'python_stdlib.zip',
    ])

    for (const name of PYODIDE_RUNTIME_FILES) {
      const path = join(pyodideDir(), name)
      expect(existsSync(path), `${name} is missing from the pyodide package`).toBe(true)
      expect(statSync(path).size).toBeGreaterThan(0)
    }
  })

  it('leave out everything the browser never asks for', () => {
    // Source maps, the CommonJS entry, the type bundles and the two demo
    // pages: about 2.5 MB that would ride along in every image.
    for (const name of [
      'pyodide.js',
      'pyodide.js.map',
      'pyodide.mjs.map',
      'pyodide.d.ts',
      'ffi.d.ts',
      'console.html',
      'console-v2.html',
      'README.md',
      'package.json',
    ]) {
      expect(PYODIDE_RUNTIME_FILES).not.toContain(name)
    }
  })

  it('include the Pyodide licence, which MPL-2.0 asks to travel with them', () => {
    const licence = read(PYODIDE_LICENCE_SOURCE)
    expect(licence).toContain('Mozilla Public License Version 2.0')
    expect(PYODIDE_LICENCE_NAME).toBe('LICENSE')
    expect(PYODIDE_PLUGIN).toContain(PYODIDE_LICENCE_SOURCE)
  })

  it('are never committed: npm already pins them exactly', () => {
    expect(GITIGNORE).toContain('public/pyodide/')
    expect(GITIGNORE).toContain('dist/')
  })
})

describe('the dev middleware that serves them out of node_modules', () => {
  const version = pyodideVersion()

  it('resolves each staged file and the licence', () => {
    for (const name of [...PYODIDE_RUNTIME_FILES, PYODIDE_LICENCE_NAME]) {
      expect(resolveRuntimeRequest(`/pyodide/${version}/${name}`, version)).not.toBeNull()
    }
  })

  it('refuses a name that is not on the list', () => {
    expect(resolveRuntimeRequest(`/pyodide/${version}/pyodide.js`, version)).toBeNull()
    expect(resolveRuntimeRequest(`/pyodide/${version}/console.html`, version)).toBeNull()
    expect(resolveRuntimeRequest(`/pyodide/${version}/`, version)).toBeNull()
  })

  it('refuses a path that tries to walk out of the directory', () => {
    // The allow-list is an exact match, not a prefix check, so traversal and
    // nested paths cannot turn into an arbitrary file read.
    expect(resolveRuntimeRequest(`/pyodide/${version}/../package.json`, version)).toBeNull()
    expect(resolveRuntimeRequest(`/pyodide/${version}/../../../etc/passwd`, version)).toBeNull()
    expect(resolveRuntimeRequest(`/pyodide/${version}/sub/pyodide.mjs`, version)).toBeNull()
  })

  it('refuses another version, so a stale cached path cannot be served', () => {
    expect(resolveRuntimeRequest('/pyodide/0.0.0/pyodide.mjs', version)).toBeNull()
    expect(resolveRuntimeRequest('/elsewhere/pyodide.mjs', version)).toBeNull()
  })

  it('types the wasm, the modules and the lock file correctly', () => {
    expect(contentTypeFor('pyodide.asm.wasm')).toBe('application/wasm')
    expect(contentTypeFor('pyodide.mjs')).toBe('text/javascript; charset=utf-8')
    expect(contentTypeFor('pyodide-lock.json')).toBe('application/json; charset=utf-8')
    expect(contentTypeFor('python_stdlib.zip')).toBe('application/zip')
    expect(contentTypeFor('LICENSE')).toBe('text/plain; charset=utf-8')
  })
})

describe('nginx serves the runtime the way the browser needs it', () => {
  it('caches /pyodide/ for a year, because the version is in the path', () => {
    expect(NGINX).toMatch(
      /location \/pyodide\/ \{[\s\S]*?Cache-Control "public, max-age=31536000, immutable"/,
    )
  })

  /**
   * 0.3.0 shipped broken because `.mjs` is not in nginx's `mime.types`, so
   * `pyodide.mjs` arrived as `application/octet-stream` and the browser
   * refused to execute it as a module — every Run failed with "Failed to fetch
   * dynamically imported module". `vite preview` types it correctly, so the
   * browser suite passed. These two tests are the config-level guard; the real
   * one is `npm run test:e2e:image`, which runs the browser against nginx.
   */
  it('asserts a Content-Type for every extension the runtime loads', () => {
    // Which extensions are actually staged, so a future Pyodide version that
    // ships a new one fails here rather than in a browser.
    const extensions = new Set(
      PYODIDE_RUNTIME_FILES.map((name) => /\.[^.]+$/.exec(name)?.[0] ?? ''),
    )
    expect([...extensions].sort()).toEqual(['.json', '.mjs', '.wasm', '.zip'])

    // The two that nginx cannot look up get an explicit default_type.
    expect(NGINX).toMatch(/location ~ \^\/pyodide\/\.\+\\\.wasm\$[\s\S]*?default_type application\/wasm/)
    expect(NGINX).toMatch(/location ~ \^\/pyodide\/\.\+\\\.mjs\$[\s\S]*?default_type text\/javascript/)
    // And the extensionless licence is readable rather than a download.
    expect(NGINX).toMatch(/location \/pyodide\/ \{[\s\S]*?default_type text\/plain/)
  })

  it('runs the browser suite against the image, not only against vite preview', () => {
    const playwright = read('playwright.config.ts')
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> }

    expect(pkg.scripts['test:e2e:image']).toBeDefined()
    expect(playwright).toContain('PY_SCRATCHPAD_BASE_URL')
    // The override must also switch the built-in preview server off, or
    // Playwright would start one and test that instead.
    expect(playwright).toContain('OWN_SERVER')
  })

  it('gives the .wasm its own location with an asserted content type', () => {
    // application/octet-stream makes instantiateStreaming refuse the module.
    expect(NGINX).toMatch(/location ~ \^\/pyodide\/\.\+\\\.wasm\$/)
    expect(NGINX).toMatch(/default_type application\/wasm/)
    // An EMPTY types block, which disables extension lookup for the location.
    // A non-empty one would replace the whole inherited table.
    expect(NGINX).toMatch(/types \{ \}/)
    expect(NGINX).not.toMatch(/types \{\s*\n\s*application\/wasm/)
  })

  it('gzips the wasm, the modules and the lock file', () => {
    const gzipTypes = /gzip_types([\s\S]*?);/.exec(NGINX)?.[1] ?? ''
    expect(gzipTypes).toContain('application/wasm')
    expect(gzipTypes).toContain('application/json')
    expect(gzipTypes).toContain('text/javascript')
  })

  it('includes the security headers in every location it adds a header to', () => {
    const locations = NGINX.match(/location [^{]*\{[\s\S]*?\n {4}\}/g) ?? []
    expect(locations.length).toBeGreaterThan(4)
    for (const block of locations) {
      expect(block, block.split('\n')[0]).toContain(
        'include /etc/nginx/snippets/security-headers.conf;',
      )
    }
  })
})

describe('cross-origin isolation', () => {
  it('is switched on in production by COOP and COEP', () => {
    expect(HEADERS).toMatch(/add_header Cross-Origin-Opener-Policy "same-origin" always;/)
    expect(HEADERS).toMatch(/add_header Cross-Origin-Embedder-Policy "require-corp" always;/)
  })

  it('is switched on in dev and preview too, so dev behaves like prod', () => {
    expect(PYODIDE_PLUGIN).toContain('configureServer')
    expect(PYODIDE_PLUGIN).toContain('configurePreviewServer')
    expect(PYODIDE_PLUGIN).toMatch(/'Cross-Origin-Opener-Policy', 'same-origin'/)
    expect(PYODIDE_PLUGIN).toMatch(/'Cross-Origin-Embedder-Policy', 'require-corp'/)
    expect(VITE_CONFIG).toContain('pyodidePlugin()')
  })

  it('keeps the CSP that allows the worker and the wasm, and nothing else', () => {
    const csp = /Content-Security-Policy "([^"]+)"/.exec(HEADERS)?.[1] ?? ''
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'")
    expect(csp).toContain("worker-src 'self'")
    // The no-CDN rule: the runtime is fetched from this origin only.
    expect(csp).toContain("connect-src 'self'")
    expect(csp).not.toContain('jsdelivr')
    expect(csp).not.toContain('unsafe-eval;')
  })

  it('never lets Pyodide fall back to a CDN for packages', () => {
    const worker = readCode('src/pyodide.worker.ts')
    // packageBaseUrl left unset defaults to cdn.jsdelivr.net.
    expect(worker).toContain('packageBaseUrl: request.indexUrl')
    expect(worker).toContain('packages: []')
    expect(worker).not.toContain('micropip')
    expect(worker).not.toContain('loadPackage')
  })
})

describe('the worker', () => {
  it('is a module worker, which Pyodide requires', () => {
    expect(VITE_CONFIG).toMatch(/worker: \{[\s\S]*?format: 'es'/)
    expect(readCode('src/runner.ts')).toContain("type: 'module'")
  })

  it('loads pyodide.mjs from the served path rather than from the bundle', () => {
    const worker = readCode('src/pyodide.worker.ts')
    expect(worker).toContain('${request.indexUrl}pyodide.mjs')
    // A value import of 'pyodide' would pull its Node branch into the bundle.
    expect(worker).not.toMatch(/^import \{[^}]*\} from 'pyodide'/m)
    expect(worker).toMatch(/^import type \{ PyodideInterface \} from 'pyodide'/m)
  })
})
