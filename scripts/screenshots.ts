/**
 * Takes the README's screenshots, and the site's link-preview image,
 * reproducibly.
 *
 *     npm run build && npm run screenshots
 *
 * It is a Playwright run rather than a standalone script so that it reuses the
 * pinned Chromium and the runner's TypeScript support instead of adding a
 * loader — see `playwright.screenshots.config.ts`, which also starts
 * `npm run preview`. Preview sends the COOP/COEP headers, so the page is
 * cross-origin isolated there exactly as it is in production; the first test
 * asserts that, because without isolation the second shot would quietly
 * document the Program-input fallback instead of the inline `input()` prompt.
 *
 * Each shot gets its own browser context, i.e. an empty `localStorage`, and
 * the code is **typed into the editor** rather than written to the storage
 * key: a screenshot should show what a visitor's own keystrokes produce.
 * Typing a Python program through a keyboard means fighting the editor's
 * auto-indent, so `typeSource` sets each new line's indentation with
 * Tab / Shift+Tab and then asserts that the saved buffer is
 * character-for-character the source asked for.
 *
 * Nothing waits on a fixed sleep: each capture waits for the output panel's
 * status line, or for the `input()` prompt, to say the run has got where the
 * shot wants it.
 *
 * Author: 0xWulf
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, test, type Page } from '@playwright/test'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const OUT_DIR = join(REPO, 'docs', 'screenshots')

/**
 * The Open Graph image is served by the site itself, so it lands in public/
 * rather than docs/. 1200x630 at 1x is the size Facebook, LinkedIn, Mastodon
 * and X all crop to without rescaling.
 */
const OG_IMAGE = join(REPO, 'public', 'og-image.png')
const OG_SIZE = { width: 1200, height: 630 }

const STORAGE_KEY = 'py-scratchpad:v1'

/** U+00A0, built rather than written out so the source stays plain ASCII. */
const NBSP = String.fromCharCode(0xa0)

/** 14px is the default; 16 keeps the code legible once the PNG is scaled down. */
const FONT_STEPS = 2

/** A PNG optimiser, if the host has one. `null` means neither is installed. */
interface Optimiser {
  command: string
  args: string[]
}

const OPTIMISERS: Optimiser[] = [
  { command: 'oxipng', args: ['-o', '4', '--strip', 'safe'] },
  { command: 'pngquant', args: ['--quality', '70-98', '--strip', '--force', '--ext', '.png'] },
]

function pickOptimiser(): Optimiser | null {
  for (const optimiser of OPTIMISERS) {
    const found = spawnSync('sh', ['-c', `command -v ${optimiser.command}`], { stdio: 'ignore' })
    if (found.status === 0) return optimiser
  }
  return null
}

const OPTIMISER = pickOptimiser()

/**
 * 2x where the PNG can be squeezed afterwards, 1.5x where it cannot: a 2x
 * screenshot of a full code editor is well past the ~400 KB a README image
 * should cost.
 */
const SCALE = OPTIMISER === null ? 1.5 : 2

/** The first shot: REPL echo, dark theme. Bare expressions show their value. */
const RUN_SOURCE = [
  '# Bare expressions print their value here, as the >>> prompt does.',
  '10 + 20 * 30',
  '7 / 2',
  '7 // 2',
  '2 ** 10',
  '',
  '',
  'def celsius(f):',
  '    """Convert a temperature in degrees Fahrenheit to Celsius."""',
  '    return (f - 32) * 5 / 9',
  '',
  '',
  'for f in (32, 72, 212):',
  '    print(f, "F is", round(celsius(f), 1), "C")',
  '',
  'celsius(98.6)',
]

/** The second shot: Script mode, light theme, stopped at the second input(). */
const INPUT_SOURCE = [
  '# Script mode: this runs the way python3 area.py would.',
  'print("Rectangle area")',
  '',
  'width = float(input("width:  "))',
  'height = float(input("height: "))',
  '',
  'print("area:", width * height)',
]

function indentOf(line: string): number {
  const match = /^ */.exec(line)
  return match === null ? 0 : match[0].length
}

/**
 * The text of the line the cursor is in, as the editor renders it.
 *
 * CodeMirror draws a run of spaces with a non-breaking space in it, so they
 * are folded back to ordinary spaces before anything compares the line to the
 * source it was meant to be.
 */
async function activeLineText(page: Page): Promise<string> {
  const text = await page.evaluate(
    () => document.querySelector('#editor .cm-activeLine')?.textContent ?? '',
  )
  return text.replaceAll(NBSP, ' ')
}

/** The indentation the editor has just put on the line the cursor is in. */
async function currentIndent(page: Page): Promise<number> {
  const match = /^\s*/.exec(await activeLineText(page))
  return match === null ? 0 : match[0].length
}

/** Tab / Shift+Tab until the current line's indentation is `target` spaces. */
async function setIndent(page: Page, target: number): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const indent = await currentIndent(page)
    if (indent === target) return
    await page.keyboard.press(indent > target ? 'Shift+Tab' : 'Tab')
  }
  throw new Error(`could not reach an indentation of ${String(target)} spaces`)
}

/**
 * Delete whatever the editor's bracket- and quote-closing left behind, so the
 * line is exactly `target`.
 *
 * Typing `"F is"` is fine — the second `"` types over the one that was
 * auto-inserted — but a triple-quoted string is not, and comes out with two
 * quotes too many. Rather than keep such things out of the sample code, every
 * line is squared up against its source once it has been typed.
 */
async function trimLine(page: Page, target: string): Promise<void> {
  await page.keyboard.press('End')
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const text = await activeLineText(page)
    if (text === target) return
    if (!text.startsWith(target)) break
    await page.keyboard.press('Backspace')
  }
  throw new Error(`the line came out as something other than ${JSON.stringify(target)}`)
}

/**
 * Type `lines` into the editor and prove the buffer holds exactly them.
 *
 * The editor auto-indents on Enter, so a line's own leading spaces are never
 * typed; the indentation is set with Tab / Shift+Tab instead, which is also
 * what empties the blank lines between the definitions. The assertion at the
 * end is the point of the helper: it fails the run rather than producing a
 * screenshot of a differently indented program.
 */
async function typeSource(page: Page, lines: string[]): Promise<void> {
  await page.locator('#editor .cm-content').click()
  for (const [index, line] of lines.entries()) {
    if (index > 0) await page.keyboard.press('Enter')
    await setIndent(page, indentOf(line))
    const text = line.trimStart()
    if (text === '') continue
    await page.keyboard.type(text)
    await trimLine(page, line)
  }

  // The autosave is debounced, so this is a web-first assertion on the real
  // storage key rather than a one-shot read.
  await expect
    .poll(
      () =>
        page.evaluate((key) => {
          const raw = window.localStorage.getItem(key)
          if (raw === null) return ''
          const state = JSON.parse(raw) as { buffer?: { content?: string } }
          return state.buffer?.content ?? ''
        }, STORAGE_KEY),
      { message: 'the editor should hold exactly the source asked for' },
    )
    .toBe(lines.join('\n'))
}

/** Open the page with an empty localStorage and the font bumped for legibility. */
async function openScratchpad(page: Page, theme: 'dark' | 'light'): Promise<void> {
  await page.goto('/')
  await expect(page.locator('#editor .cm-content')).toBeVisible()
  // Nothing in the bar: the move notice belongs on python.piapps.dev only.
  await expect(page.locator('#notice')).toBeHidden()

  for (let step = 0; step < FONT_STEPS; step += 1) await page.locator('#font-larger').click()

  const current = await page.evaluate(() => document.documentElement.dataset.theme ?? '')
  if (current !== theme) await page.locator('#theme-toggle').click()
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme ?? ''))
    .toBe(theme)
}

/** Capture the viewport into `path`, then squeeze the PNG. */
async function capture(page: Page, path: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true })
  // Playwright hides the text caret by default, so no blinking cursor is
  // frozen into the image.
  await page.screenshot({ path })

  if (OPTIMISER === null) return
  const result = spawnSync(OPTIMISER.command, [...OPTIMISER.args, path], { stdio: 'ignore' })
  // pngquant exits 98 when it cannot beat the original, which is not a
  // failure: the unoptimised file is still the file we want.
  if (result.status !== 0 && result.status !== 98) {
    throw new Error(`${OPTIMISER.command} failed on ${path} (exit ${String(result.status)})`)
  }
}

test.use({ deviceScaleFactor: SCALE })

test('the page is cross-origin isolated, so the shots show the real input()', async ({ page }) => {
  await page.goto('/')
  expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(true)
})

test.describe('dark', () => {
  test.use({ colorScheme: 'dark' })

  test('run-dark.png — a Run in REPL echo mode', async ({ page }) => {
    await openScratchpad(page, 'dark')
    await page.locator('#filename').fill('hello.py')
    await page.locator('#run-mode').selectOption('repl')
    await typeSource(page, RUN_SOURCE)

    await page.locator('#run').click()
    await expect(page.locator('#output-status')).toHaveText(/^Done /)

    // No focus ring anywhere: the shot is of the result, not of the button
    // that was clicked to get it.
    await page.evaluate(() => {
      const active = document.activeElement
      if (active instanceof HTMLElement) active.blur()
    })

    await capture(page, join(OUT_DIR, 'run-dark.png'))
  })
})

test.describe('light', () => {
  test.use({ colorScheme: 'light' })

  /**
   * The capture happens while the program is parked on its **first** prompt,
   * with the line `print` already wrote above it in the panel. The inline
   * field only exists because the page is cross-origin isolated, which the
   * first test has already asserted.
   *
   * Not the second prompt: the worker's `partialLine` is never cleared when
   * `stdin()` consumes it, so a later `input()` is labelled with every earlier
   * prompt as well — `width:  height: ` here. That is an app bug, not a
   * screenshot problem, and this shot stays off it rather than documenting it.
   */
  test('input-light.png — stopped at an input() prompt', async ({ page }) => {
    await openScratchpad(page, 'light')
    await page.locator('#filename').fill('area.py')
    await page.locator('#run-mode').selectOption('script')
    await typeSource(page, INPUT_SOURCE)

    await page.locator('#run').click()

    const prompt = page.locator('#stdin-prompt')
    await expect(prompt).toBeVisible()
    await expect(prompt).toHaveText('width:')
    await expect(page.locator('#output-log')).toContainText('Rectangle area')

    await capture(page, join(OUT_DIR, 'input-light.png'))
  })
})

/**
 * The link preview: the same REPL-echo run as run-dark.png, at the Open Graph
 * size and 1x, since a preview is shown far smaller than it is captured.
 */
test.describe('og-image', () => {
  test.use({ colorScheme: 'dark', viewport: OG_SIZE, deviceScaleFactor: 1 })

  test('og-image.png — the link preview', async ({ page }) => {
    await openScratchpad(page, 'dark')
    await page.locator('#filename').fill('hello.py')
    await page.locator('#run-mode').selectOption('repl')
    await typeSource(page, RUN_SOURCE)

    await page.locator('#run').click()
    await expect(page.locator('#output-status')).toHaveText(/^Done /)

    await page.evaluate(() => {
      const active = document.activeElement
      if (active instanceof HTMLElement) active.blur()
    })

    await capture(page, OG_IMAGE)
  })
})
