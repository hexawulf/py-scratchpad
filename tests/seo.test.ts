import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const ORIGIN = 'https://py-scratchpad.com/'

const INDEX = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
const ROBOTS = readFileSync(new URL('../public/robots.txt', import.meta.url), 'utf8')
const SITEMAP = readFileSync(new URL('../public/sitemap.xml', import.meta.url), 'utf8')

/**
 * The same image serves py-scratchpad.com and python.piapps.dev, with no
 * redirect between them (localStorage is per origin). These pin what tells
 * Google the two are one page, and where Search Console finds the sitemap.
 */
describe('search engines see one canonical page', () => {
  it('names py-scratchpad.com as canonical, on every host that serves it', () => {
    expect(INDEX).toContain(`<link rel="canonical" href="${ORIGIN}" />`)
    expect(INDEX).toContain(`<meta property="og:url" content="${ORIGIN}" />`)
  })

  it('has a descriptive title and a description of a useful length', () => {
    const title = /<title>([^<]+)<\/title>/.exec(INDEX)?.[1] ?? ''
    expect(title).toMatch(/python/i)
    expect(title.length).toBeLessThanOrEqual(70)

    const description = /<meta name="description" content="([^"]+)"/.exec(INDEX)?.[1] ?? ''
    expect(description.length).toBeGreaterThanOrEqual(70)
    expect(description.length).toBeLessThanOrEqual(170)
  })

  it('ships structured data that parses as JSON', () => {
    const block = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(INDEX)?.[1]
    expect(block).toBeDefined()
    const data = JSON.parse(block ?? '') as Record<string, unknown>
    expect(data['@type']).toBe('WebApplication')
    expect(data.url).toBe(ORIGIN)
  })

  it('points robots.txt at the sitemap and blocks nothing', () => {
    expect(ROBOTS).toContain(`Sitemap: ${ORIGIN}sitemap.xml`)
    expect(ROBOTS).not.toMatch(/^Disallow:\s*\S/m)
  })

  it('lists exactly the canonical URL in the sitemap', () => {
    expect(SITEMAP.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(SITEMAP).toContain('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"')
    const locs = [...SITEMAP.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1])
    expect(locs).toEqual([ORIGIN])
  })
})
