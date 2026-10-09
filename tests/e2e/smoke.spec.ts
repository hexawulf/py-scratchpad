/**
 * The v0.3 smoke test: does the built site actually run Python.
 *
 * It drives the real `dist/` through `npm run preview`, so it covers the parts
 * no unit test can — that the worker is reachable under the CSP, that the
 * runtime is served from `/pyodide/<version>/`, that COOP/COEP make the
 * document cross-origin isolated, and that Stop gets a runaway loop back.
 *
 * The buffer is seeded by writing the storage key rather than by typing: the
 * editor auto-indents, so typing a multi-line Python program through the
 * keyboard produces something other than what was asked for. Writing the key
 * also exercises the real schema, which is the thing a release can break.
 */

import { expect, type Page, test } from '@playwright/test'

const STORAGE_KEY = 'py-scratchpad:v1'
const SCHEMA_VERSION = 3

type RunMode = 'repl' | 'script'

/** Put `content` in the buffer and reload, so the page starts from it. */
async function seed(page: Page, content: string, mode: RunMode = 'repl'): Promise<void> {
  await page.goto('/')
  await page.evaluate(
    (seeded) => {
      window.localStorage.setItem(
        seeded.key,
        JSON.stringify({
          version: seeded.version,
          buffer: {
            name: 'scratch.py',
            content: seeded.content,
            cursor: { anchor: 0, head: 0 },
            lineEnding: '\n',
            bom: false,
          },
          settings: { theme: 'dark', fontSize: 14, runMode: seeded.mode },
        }),
      )
    },
    { key: STORAGE_KEY, version: SCHEMA_VERSION, content, mode },
  )
  await page.reload()
}

/** Click Run and wait for the panel's status line to report a finished run. */
async function run(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.locator('#output-status')).toHaveText(
    /^(Done|Finished with an error|Exited|Stopped) /,
    { timeout: 120_000 },
  )
}

function outputText(page: Page): Promise<string> {
  return page.locator('#output-log').innerText()
}

test('loads with no console error and no CSP violation', async ({ page }) => {
  const problems: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`)
  })
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  page.on('requestfailed', (request) => {
    problems.push(`requestfailed: ${request.url()}`)
  })

  await page.goto('/')
  await expect(page.locator('#editor .cm-content')).toBeVisible()

  // The move notice only belongs on python.piapps.dev, and nothing else should
  // be in the bar on a clean load.
  await expect(page.locator('#notice')).toBeHidden()
  // No output panel before the first Run: the editor gets the whole height.
  await expect(page.locator('#output')).toBeHidden()

  expect(problems).toEqual([])
})

test('the document is cross-origin isolated, so SharedArrayBuffer exists', async ({ page }) => {
  await page.goto('/')
  const isolated = await page.evaluate(() => ({
    crossOriginIsolated: window.crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer,
  }))

  expect(isolated.crossOriginIsolated).toBe(true)
  expect(isolated.sharedArrayBuffer).toBe('function')
})

test('Run prints to the output panel', async ({ page }) => {
  await seed(page, 'print(1 + 1)\n')
  await run(page)

  await expect(page.locator('#output')).toBeVisible()
  expect(await outputText(page)).toContain('2')
})

test('REPL echo prints a bare expression, Script does not', async ({ page }) => {
  const source = '10 + 20 * 30\n4**2 / 30\n(9**4 + 2) * 6 - 1\n'

  await seed(page, source, 'repl')
  await run(page)
  const echoed = await outputText(page)
  expect(echoed.trim().split('\n')).toEqual(['610', '0.5333333333333333', '39377'])

  await seed(page, source, 'script')
  await run(page)
  expect((await outputText(page)).trim()).toBe('')
})

test('a traceback names the buffer and the right line, and its reference is clickable', async ({
  page,
}) => {
  await seed(page, 'def boom():\n    return 1 / 0\n\n\nprint("before")\nboom()\n', 'script')
  await run(page)

  const text = await outputText(page)
  expect(text).toContain('before')
  expect(text).toContain('File "scratch.py", line 6')
  expect(text).toContain('File "scratch.py", line 2')
  expect(text).toContain('ZeroDivisionError: division by zero')
  // No Pyodide or worker frames.
  expect(text).not.toContain('pyodide')
  expect(text).not.toContain('<exec>')

  await page.locator('.out-ref', { hasText: 'line 2' }).first().click()
  const line = await page.evaluate(
    () => document.querySelector('#editor .cm-activeLine')?.textContent ?? '',
  )
  expect(line).toContain('return 1 / 0')
})

test('an unsupported module gets one friendly line, not a traceback', async ({ page }) => {
  await seed(page, 'import turtle\n', 'script')
  await run(page)

  const text = await outputText(page)
  expect(text).toContain('turtle draws through tkinter')
  expect(text).not.toContain('Traceback')
})

test('Stop gets an infinite loop back in under a second', async ({ page }) => {
  await seed(page, 'while True:\n    pass\n', 'script')

  const runButton = page.getByRole('button', { name: 'Run', exact: true })
  const stopButton = page.getByRole('button', { name: 'Stop' })

  await runButton.click()
  await expect(page.locator('#output-status')).toHaveText('Running…', { timeout: 120_000 })

  const started = Date.now()
  await stopButton.click()
  // Usable again: the Run button is enabled and the status is no longer the
  // running one. Either route out of Stop satisfies it — the interrupt raising
  // KeyboardInterrupt, or the worker being terminated and replaced.
  await expect(runButton).toBeEnabled({ timeout: 2000 })
  const elapsed = Date.now() - started

  expect(elapsed).toBeLessThan(1000)
  expect(await outputText(page)).toMatch(/KeyboardInterrupt|interpreter was restarted/)
})

test('input() asks inline and takes the answer', async ({ page }) => {
  await seed(page, 'name = input("name? ")\nprint("hello", name)\n', 'script')

  await page.getByRole('button', { name: 'Run', exact: true }).click()

  const prompt = page.locator('#stdin-prompt')
  await expect(prompt).toBeVisible({ timeout: 120_000 })
  await expect(prompt).toHaveText('name? ')

  await page.locator('#stdin-input').fill('Ada')
  await page.locator('#stdin-input').press('Enter')

  await expect(page.locator('#output-status')).toHaveText(/^Done /, { timeout: 30_000 })
  // A web-first assertion, not a one-shot read: output is appended on an
  // animation frame, so this is the thing that would be flaky if the status
  // line were ever allowed to get ahead of the panel.
  await expect(page.locator('#output-log')).toContainText('hello Ada')
})

/**
 * The other half of Part C: what the page does where it is **not** isolated —
 * `http://192.168.50.120:5040`, say. The headers are stripped on the way
 * through, which is the only way to get a non-isolated document out of a
 * server that sets them, and leaves everything else identical.
 */
test('without isolation, input() is fed from the Program input box', async ({ page }) => {
  await page.route('**/*', async (route) => {
    const response = await route.fetch()
    const headers = { ...response.headers() }
    delete headers['cross-origin-opener-policy']
    delete headers['cross-origin-embedder-policy']
    await route.fulfill({ response, headers })
  })

  await seed(page, 'print("hi", input("first? "))\nprint("and", input("second? "))\n', 'script')
  expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(false)

  // The box is shown only here, and it explains itself.
  const box = page.locator('#program-input')
  await expect(box).toBeVisible()
  await expect(page.locator('#program-input-note')).toContainText('not cross-origin isolated')

  await box.locator('summary').click()
  await page.locator('#program-input-text').fill('Ada\n')
  await run(page)

  const text = await outputText(page)
  expect(text).toContain('hi Ada')
  // The second input() runs out of lines, which is an EOFError — the same
  // thing `python3 file.py < one-line-file` does.
  expect(text).toContain('EOFError')
  // And the inline field is never offered here.
  await expect(page.locator('#stdin-form')).toBeHidden()
})

test('the runtime is served from this origin only', async ({ page }, testInfo) => {
  // The baseURL's origin, not page.url(): the listener is installed before the
  // first navigation, when the page is still about:blank.
  const origin = new URL(testInfo.project.use.baseURL ?? 'http://127.0.0.1:4173').origin
  const external: string[] = []

  page.on('request', (request) => {
    if (new URL(request.url()).origin !== origin) external.push(request.url())
  })

  await seed(page, 'print("hi")\n')
  await run(page)

  expect(external).toEqual([])
  expect(await outputText(page)).toContain('hi')
})
