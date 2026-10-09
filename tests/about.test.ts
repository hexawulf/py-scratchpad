import { describe, expect, it } from 'vitest'

import {
  buildStack,
  type DiagnosticsInputs,
  diagnosticsLine,
  formatBuildMonth,
  LINKS,
  parseBuildInfo,
  versionLine,
} from '../src/about.ts'

const UNKNOWN = { version: 'dev', date: '', deps: {} }

describe('parseBuildInfo', () => {
  it('reads the version, the date and the dependency versions', () => {
    const raw = JSON.stringify({
      version: '0.1.1',
      date: '2026-10-09T04:21:00.000Z',
      deps: { codemirror: '6.0.2', vite: '8.3.4' },
    })
    expect(parseBuildInfo(raw)).toEqual({
      version: '0.1.1',
      date: '2026-10-09T04:21:00.000Z',
      deps: { codemirror: '6.0.2', vite: '8.3.4' },
    })
  })

  // Under vitest the define does not exist, which is this path.
  it('falls back to dev when nothing was injected', () => {
    expect(parseBuildInfo(null)).toEqual(UNKNOWN)
    expect(parseBuildInfo(undefined)).toEqual(UNKNOWN)
    expect(parseBuildInfo('')).toEqual(UNKNOWN)
  })

  it('falls back instead of throwing on a malformed payload', () => {
    expect(parseBuildInfo('{not json')).toEqual(UNKNOWN)
    expect(parseBuildInfo('"a string"')).toEqual(UNKNOWN)
    expect(parseBuildInfo('null')).toEqual(UNKNOWN)
    expect(parseBuildInfo('42')).toEqual(UNKNOWN)
  })

  it('keeps the fields it understands and drops the rest', () => {
    expect(parseBuildInfo('{"version":"0.2.0"}')).toEqual({
      version: '0.2.0',
      date: '',
      deps: {},
    })
    // A non-string version or dep is dropped, not coerced.
    expect(parseBuildInfo('{"version":7,"deps":{"vite":3,"eslint":"10.12.0"}}')).toEqual({
      version: 'dev',
      date: '',
      deps: { eslint: '10.12.0' },
    })
  })
})

describe('formatBuildMonth', () => {
  it('formats an ISO timestamp as a month and year', () => {
    expect(formatBuildMonth('2026-10-09T04:21:00.000Z')).toBe('October 2026')
    expect(formatBuildMonth('2027-01-02T00:00:00.000Z')).toBe('January 2027')
  })

  // Formatted in UTC: a build at 23:30 UTC on the 31st must not report the
  // next month just because the viewer sits in Asia/Taipei (UTC+8).
  it('uses UTC, not the viewer time zone', () => {
    expect(formatBuildMonth('2026-10-31T23:30:00.000Z')).toBe('October 2026')
    expect(formatBuildMonth('2026-11-01T00:30:00.000Z')).toBe('November 2026')
  })

  it('gives an empty string for an unknown or unparseable date', () => {
    expect(formatBuildMonth('')).toBe('')
    expect(formatBuildMonth('not a date')).toBe('')
  })
})

describe('versionLine', () => {
  it('joins the version and the build month', () => {
    expect(versionLine('0.1.1', 'October 2026')).toBe('Version 0.1.1 · October 2026')
  })

  it('leaves the separator out when the month is unknown', () => {
    expect(versionLine('dev', '')).toBe('Version dev')
  })
})

describe('buildStack', () => {
  const deps = {
    codemirror: '6.0.2',
    '@codemirror/lang-python': '6.2.1',
    '@codemirror/theme-one-dark': '6.1.3',
    typescript: '6.0.3',
    vite: '8.3.4',
    vitest: '5.0.3',
    eslint: '10.12.0',
    'typescript-eslint': '8.71.1',
  }

  it('names each layer once, in order', () => {
    expect(buildStack(deps, 2).map(([label]) => label)).toEqual([
      'Editor',
      'Frontend',
      'Storage',
      'Testing',
      'Serving',
      'Packaging',
    ])
  })

  it('takes the versions from package.json', () => {
    const rows = new Map(buildStack(deps, 2))
    expect(rows.get('Editor')).toBe('CodeMirror 6.0.2, lang-python 6.2.1, one-dark 6.1.3')
    expect(rows.get('Frontend')).toBe('vanilla TypeScript 6.0.3, Vite 8.3.4')
    expect(rows.get('Testing')).toBe('Vitest 5.0.3, ESLint 10.12.0 (typescript-eslint 8.71.1)')
  })

  it('takes the schema version from storage.ts, not a literal', () => {
    const rows = new Map(buildStack(deps, 3))
    expect(rows.get('Storage')).toBe(
      'browser localStorage, versioned schema (v3) with migrations',
    )
  })

  // A renamed or removed dependency must drop its version, not print
  // "CodeMirror undefined".
  it('omits the version of a dependency it was not given', () => {
    const rows = new Map(buildStack({ codemirror: '6.0.2' }, 2))
    expect(rows.get('Editor')).toBe('CodeMirror 6.0.2, lang-python, one-dark')
    expect(rows.get('Frontend')).toBe('vanilla TypeScript, Vite')
  })

  it('describes the layers that are pinned in the Dockerfile in words', () => {
    const rows = new Map(buildStack(deps, 2))
    expect(rows.get('Serving')).toBe('nginx Alpine, read-only rootfs, strict CSP')
    expect(rows.get('Packaging')).toBe(
      'multi-arch Docker image (amd64/arm64), SBOM + provenance',
    )
  })
})

describe('diagnosticsLine', () => {
  const base: DiagnosticsInputs = {
    version: '0.1.1',
    codemirror: '6.0.2',
    schema: 2,
    storage: 'localStorage',
    autosavePaused: false,
    theme: 'dark',
    online: true,
  }

  it('builds the healthy line', () => {
    expect(diagnosticsLine(base)).toBe(
      'py-scratchpad v0.1.1 · CodeMirror 6.0.2 · schema v2 · storage localStorage · ' +
        'autosave active · theme dark · online',
    )
  })

  it('reports the degraded state of each part', () => {
    expect(
      diagnosticsLine({
        ...base,
        storage: 'in-memory',
        autosavePaused: true,
        theme: 'light',
        online: false,
      }),
    ).toBe(
      'py-scratchpad v0.1.1 · CodeMirror 6.0.2 · schema v2 · storage in-memory · ' +
        'autosave paused (other tab) · theme light · offline',
    )
  })

  it('says unknown rather than printing an empty CodeMirror version', () => {
    expect(diagnosticsLine({ ...base, codemirror: '' })).toContain('CodeMirror unknown')
  })

  // The whole premise of the app is that the buffer never leaves the tab, so
  // the line a user pastes into a bug report must not carry it.
  it('carries no buffer content and no filename', () => {
    const line = diagnosticsLine(base)
    expect(line).not.toMatch(/\.py\b/)
    expect(line.split(' · ')).toHaveLength(7)
  })
})

describe('LINKS', () => {
  it('are absolute https URLs', () => {
    for (const link of LINKS) {
      expect(link.href.startsWith('https://')).toBe(true)
      expect(link.label).not.toBe('')
    }
  })
})
