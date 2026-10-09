import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { formatBuildMonth, parseBuildInfo } from '../src/about.ts'

const VITE_CONFIG = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8')

/** The config with its comments removed, so prose about a hazard is not it. */
const VITE_CODE = VITE_CONFIG.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
const DOCKERFILE = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8')
const RELEASE = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')

/**
 * The build date must identify the *source*, not the moment `vite build` ran:
 * otherwise no two builds of one commit agree and a published image cannot be
 * reproduced from its tag. `npm run build` is what actually proves it — these
 * tests pin the three places the wiring can fall apart.
 */
describe('the build dates itself from the source, not from the clock', () => {
  it('takes SOURCE_DATE_EPOCH first, then the last commit, then gives up', () => {
    expect(VITE_CONFIG).toMatch(/process\.env\.SOURCE_DATE_EPOCH/)
    expect(VITE_CONFIG).toMatch(/'git',\s*\['log', '-1', '--format=%cI'\]/)
  })

  it('never calls new Date() with no argument for the build date', () => {
    // `new Date(...)` with an argument is fine — that is parsing, not reading
    // the clock. A bare `new Date()` is the regression.
    expect(VITE_CODE).not.toMatch(/new Date\(\)/)
  })

  it('passes SOURCE_DATE_EPOCH into the image, which has no .git', () => {
    expect(DOCKERFILE).toMatch(/ARG SOURCE_DATE_EPOCH=/)
    expect(DOCKERFILE).toMatch(/ENV SOURCE_DATE_EPOCH=\$\{SOURCE_DATE_EPOCH\}/)
    expect(RELEASE).toMatch(/git log -1 --format=%ct/)
    expect(RELEASE).toMatch(/SOURCE_DATE_EPOCH=\$\{\{ steps\.rev\.outputs\.epoch \}\}/)
  })

  it('agrees with git about this checkout, the same way the build will', () => {
    const iso = execFileSync('git', ['log', '-1', '--format=%cI'], {
      encoding: 'utf8',
      cwd: new URL('..', import.meta.url),
    }).trim()
    const month = formatBuildMonth(new Date(iso).toISOString())
    expect(month).not.toBe('')
    // A real month name, not a date-less fallback.
    expect(month).toMatch(/^[A-Z][a-z]+ \d{4}$/)
  })

  it('shows the version with no month when the date is unknown', () => {
    const info = parseBuildInfo(JSON.stringify({ version: '0.3.0', date: '', deps: {} }))
    expect(info.date).toBe('')
    expect(formatBuildMonth(info.date)).toBe('')
  })
})
