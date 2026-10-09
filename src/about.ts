/**
 * What the About dialog shows, and the pure functions that format it.
 *
 * This module never touches the DOM — `aboutdialog.ts` does that — so the
 * formatting can be unit-tested in the node environment.
 *
 * The version, the build date and the dependency versions are injected at
 * build time by `vite.config.ts` as one JSON string in `__BUILD_INFO__`, so
 * nothing here can drift from `package.json`. Under vitest that global does
 * not exist, which is the `version: 'dev'` fallback in `parseBuildInfo`.
 */

import type { RuntimeInfo } from './protocol.ts'
import { SCHEMA_VERSION, type ThemeName } from './storage.ts'

export const TAGLINE = 'A Python scratchpad that never leaves your browser tab.'

export const CONTACT = { author: '0xWulf', email: 'dev@0xwulf.dev' }

const REPO = 'https://github.com/hexawulf/py-scratchpad'

export interface AboutLink {
  label: string
  href: string
}

export const LINKS: readonly AboutLink[] = [
  { label: 'GitHub repository', href: REPO },
  { label: 'Docker Hub', href: 'https://hub.docker.com/r/0xwulf/py-scratchpad' },
  { label: 'Technical spec', href: `${REPO}/blob/main/docs/PLAN.md` },
  { label: 'Licence: MIT', href: `${REPO}/blob/main/LICENSE` },
]

// ---------------------------------------------------------------------------
// Build info
// ---------------------------------------------------------------------------

export interface BuildInfo {
  /** `package.json`'s `version`, or `dev` when nothing was injected. */
  version: string
  /** ISO timestamp of the build, or `''` when it is unknown. */
  date: string
  /** Exact versions of the dependencies the stack list names. */
  deps: Record<string, string>
}

const UNKNOWN_BUILD: BuildInfo = { version: 'dev', date: '', deps: {} }

/**
 * Turn the injected `__BUILD_INFO__` string into a `BuildInfo`. Anything
 * unexpected degrades to `UNKNOWN_BUILD` rather than throwing: a malformed
 * define must not stop the page from loading.
 */
export function parseBuildInfo(raw: unknown): BuildInfo {
  if (typeof raw !== 'string' || raw === '') return UNKNOWN_BUILD

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return UNKNOWN_BUILD
  }
  if (typeof parsed !== 'object' || parsed === null) return UNKNOWN_BUILD

  const record = parsed as Record<string, unknown>
  const version = typeof record.version === 'string' ? record.version : UNKNOWN_BUILD.version
  const date = typeof record.date === 'string' ? record.date : ''

  const deps: Record<string, string> = {}
  if (typeof record.deps === 'object' && record.deps !== null) {
    for (const [name, value] of Object.entries(record.deps as Record<string, unknown>)) {
      if (typeof value === 'string') deps[name] = value
    }
  }

  return { version, date, deps }
}

const BUILD: BuildInfo = parseBuildInfo(
  typeof __BUILD_INFO__ === 'string' ? __BUILD_INFO__ : null,
)

export const APP_VERSION = BUILD.version

/**
 * The build month, as `October 2026`. UTC, so a build late on the last day of
 * a month does not show the next one in a positive time zone. An unknown or
 * unparseable date gives `''`, which `versionLine` then leaves out.
 */
export function formatBuildMonth(iso: string): string {
  if (iso === '') return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date)
}

export const BUILD_MONTH = formatBuildMonth(BUILD.date)

/** `Version 0.1.1 · October 2026`, or just the version if the month is unknown. */
export function versionLine(version: string, month: string): string {
  return month === '' ? `Version ${version}` : `Version ${version} · ${month}`
}

// ---------------------------------------------------------------------------
// Tech stack
// ---------------------------------------------------------------------------

/** A `[label, value]` row of the stack list. */
export type StackRow = readonly [string, string]

/** ` 6.0.2` for a dependency that was injected, `''` for one that was not. */
function at(deps: Record<string, string>, name: string): string {
  const version = deps[name]
  return version === undefined ? '' : ` ${version}`
}

/**
 * The stack rows. Versions come from `package.json` via the build define;
 * nginx and Docker are described in words, since they are pinned in the
 * `Dockerfile` rather than here.
 */
export function buildStack(deps: Record<string, string>, schema: number): StackRow[] {
  return [
    [
      'Editor',
      `CodeMirror${at(deps, 'codemirror')}, lang-python${at(deps, '@codemirror/lang-python')}, one-dark${at(deps, '@codemirror/theme-one-dark')}`,
    ],
    ['Frontend', `vanilla TypeScript${at(deps, 'typescript')}, Vite${at(deps, 'vite')}`],
    ['Storage', `browser localStorage, versioned schema (v${schema}) with migrations`],
    [
      'Testing',
      `Vitest${at(deps, 'vitest')}, ESLint${at(deps, 'eslint')} (typescript-eslint${at(deps, 'typescript-eslint')})`,
    ],
    ['Serving', 'nginx Alpine, read-only rootfs, strict CSP'],
    ['Python', 'Pyodide (CPython compiled to WebAssembly) in a Web Worker, self-hosted'],
    ['Packaging', 'multi-arch Docker image (amd64/arm64), SBOM + provenance'],
  ]
}

export const STACK: readonly StackRow[] = buildStack(BUILD.deps, SCHEMA_VERSION)

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export type StorageKind = 'localStorage' | 'in-memory'

/** The parts of the diagnostics line that change while the page is open. */
export interface RuntimeDiagnostics {
  storage: StorageKind
  /** True while another tab owns the storage key (see tabsync.ts). */
  autosavePaused: boolean
  theme: ThemeName
  online: boolean
  /** Null until the first Run has finished fetching and starting Pyodide. */
  runtime: RuntimeInfo | null
  /**
   * `crossOriginIsolated`. It decides whether Stop can interrupt rather than
   * terminate, and whether `input()` can be answered while a program runs, so
   * it is the first thing to know about a report of either misbehaving.
   */
  isolated: boolean
}

export interface DiagnosticsInputs extends RuntimeDiagnostics {
  version: string
  codemirror: string
  schema: number
  pyodide: string
}

/**
 * One line to paste into a bug report, e.g.
 * `py-scratchpad v0.3.0 · CodeMirror 6.0.2 · schema v3 · storage localStorage ·
 * autosave active · theme dark · online · python loaded · isolated yes`.
 *
 * It deliberately carries no buffer content and no filename: the whole point
 * of this app is that what you type never leaves the tab.
 */
export function diagnosticsLine(inputs: DiagnosticsInputs): string {
  return [
    `py-scratchpad v${inputs.version}`,
    `CodeMirror ${inputs.codemirror === '' ? 'unknown' : inputs.codemirror}`,
    `schema v${inputs.schema}`,
    `storage ${inputs.storage}`,
    `autosave ${inputs.autosavePaused ? 'paused (other tab)' : 'active'}`,
    `theme ${inputs.theme}`,
    inputs.online ? 'online' : 'offline',
    `python ${inputs.runtime === null ? 'not loaded' : 'loaded'}`,
    `isolated ${inputs.isolated ? 'yes' : 'no'}`,
  ].join(' · ')
}

/**
 * The About dialog's Runtime row. The Pyodide version is known at build time;
 * CPython's exact patch level is only known once the runtime has started, and
 * it does not start until the first Run — so before that the row says so
 * rather than guessing it from the Pyodide version.
 */
export function runtimeLine(pyodide: string, runtime: RuntimeInfo | null): string {
  const name = pyodide === '' ? 'Pyodide' : `Pyodide ${pyodide}`
  if (runtime === null) return `${name} · CPython loads on the first Run`
  return `${name} · CPython ${runtime.python}`
}

/** The pinned Pyodide version, or `''` under vitest where no define exists. */
export const PYODIDE_VERSION =
  typeof __PYODIDE_VERSION__ === 'string' ? __PYODIDE_VERSION__ : ''

/** `diagnosticsLine` with this build's constants already filled in. */
export function currentDiagnosticsLine(diagnostics: RuntimeDiagnostics): string {
  return diagnosticsLine({
    ...diagnostics,
    version: APP_VERSION,
    codemirror: BUILD.deps.codemirror ?? '',
    schema: SCHEMA_VERSION,
    pyodide: PYODIDE_VERSION,
  })
}
