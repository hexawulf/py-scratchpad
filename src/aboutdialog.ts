/**
 * The About dialog: what this is, how it is built, who made it, and one
 * diagnostics line to paste into a bug report.
 *
 * A native `<dialog>` opened with `showModal()`, so the browser gives us the
 * focus trap, the Esc key and the `::backdrop` for free. The content and the
 * formatting live in `about.ts`; this module is only DOM.
 *
 * No inline handlers and no inline script: the CSP is `script-src 'self'`.
 */

import {
  APP_VERSION,
  BUILD_MONTH,
  CONTACT,
  currentDiagnosticsLine,
  LINKS,
  PYODIDE_VERSION,
  type RuntimeDiagnostics,
  runtimeLine,
  STACK,
  TAGLINE,
  versionLine,
} from './about.ts'

/** "Copied" is a receipt and can go quickly. */
const COPIED_TIMEOUT_MS = 2500
/** The fallback hint is an instruction, so it has to outlive the reading of it. */
const HINT_TIMEOUT_MS = 10_000

export interface AboutDialogOptions {
  /** The toolbar button that opens it; focus returns here on close. */
  opener: HTMLButtonElement
  /** Read on every open, so the diagnostics line shows the live state. */
  diagnostics: () => RuntimeDiagnostics
}

function pick<T extends Element>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector)
  if (el === null) throw new Error(`missing element: ${selector}`)
  return el
}

/**
 * Copy to the clipboard, reporting whether it worked.
 *
 * `navigator.clipboard` is gated on a secure context, so it simply does not
 * exist on `http://192.168.50.120:5040` — the LAN endpoint this app is also
 * served from. The caller falls back to selecting the text.
 */
async function writeClipboard(text: string): Promise<boolean> {
  if (!window.isSecureContext) return false
  try {
    await window.navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export function createAboutDialog(options: AboutDialogOptions): void {
  const dialog = document.createElement('dialog')
  dialog.className = 'about'
  dialog.setAttribute('aria-labelledby', 'about-title')
  dialog.innerHTML = `
    <section class="about-card">
      <header class="about-head">
        <div>
          <h2 id="about-title">About py-scratchpad</h2>
          <p class="about-tagline"></p>
        </div>
        <button type="button" class="about-close" aria-label="Close">&#10005;</button>
      </header>
      <p class="about-version"></p>
      <h3>Runtime</h3>
      <p class="about-runtime"></p>
      <h3>Tech stack</h3>
      <dl class="about-stack"></dl>
      <h3>Contact</h3>
      <p class="about-contact"></p>
      <h3>Links</h3>
      <ul class="about-links"></ul>
      <h3>Diagnostics</h3>
      <div class="about-diag">
        <code class="about-diag-line"></code>
        <button type="button" class="about-copy">Copy</button>
      </div>
      <p class="about-copied" role="status" aria-live="polite"></p>
    </section>
  `

  const closeButton = pick<HTMLButtonElement>(dialog, '.about-close')
  const copyButton = pick<HTMLButtonElement>(dialog, '.about-copy')
  const taglineEl = pick<HTMLParagraphElement>(dialog, '.about-tagline')
  const versionEl = pick<HTMLParagraphElement>(dialog, '.about-version')
  const runtimeEl = pick<HTMLParagraphElement>(dialog, '.about-runtime')
  const stackEl = pick<HTMLDListElement>(dialog, '.about-stack')
  const contactEl = pick<HTMLParagraphElement>(dialog, '.about-contact')
  const linksEl = pick<HTMLUListElement>(dialog, '.about-links')
  const diagEl = pick<HTMLElement>(dialog, '.about-diag-line')
  const copiedEl = pick<HTMLParagraphElement>(dialog, '.about-copied')

  // Static content, written as text rather than markup.
  taglineEl.textContent = TAGLINE
  versionEl.textContent = versionLine(APP_VERSION, BUILD_MONTH)

  for (const [label, value] of STACK) {
    const dt = document.createElement('dt')
    dt.textContent = label
    const dd = document.createElement('dd')
    dd.textContent = value
    stackEl.append(dt, dd)
  }

  const mail = document.createElement('a')
  mail.href = `mailto:${CONTACT.email}`
  mail.textContent = CONTACT.email
  contactEl.append(`${CONTACT.author} · `, mail)

  for (const link of LINKS) {
    const anchor = document.createElement('a')
    anchor.href = link.href
    anchor.textContent = link.label
    // External, so a new tab — and never a reference back to this one.
    anchor.target = '_blank'
    anchor.rel = 'noopener noreferrer'
    const item = document.createElement('li')
    item.append(anchor)
    linksEl.append(item)
  }

  document.body.append(dialog)

  // -------------------------------------------------------------------------
  // Copy
  // -------------------------------------------------------------------------

  let feedbackTimer: number | undefined

  function showFeedback(message: string, timeout: number): void {
    copiedEl.textContent = message
    if (feedbackTimer !== undefined) window.clearTimeout(feedbackTimer)
    feedbackTimer = window.setTimeout(() => {
      copiedEl.textContent = ''
    }, timeout)
  }

  function clearFeedback(): void {
    if (feedbackTimer !== undefined) window.clearTimeout(feedbackTimer)
    feedbackTimer = undefined
    copiedEl.textContent = ''
  }

  /** Select the whole line, so the hint to press Ctrl+C is actionable. */
  function selectDiagnostics(): void {
    const selection = window.getSelection()
    if (selection === null) return
    const range = document.createRange()
    range.selectNodeContents(diagEl)
    selection.removeAllRanges()
    selection.addRange(range)
  }

  async function copyDiagnostics(): Promise<void> {
    if (await writeClipboard(diagEl.textContent ?? '')) {
      showFeedback('Copied', COPIED_TIMEOUT_MS)
      return
    }
    selectDiagnostics()
    showFeedback('Selected — press Ctrl+C to copy.', HINT_TIMEOUT_MS)
  }

  copyButton.addEventListener('click', () => {
    void copyDiagnostics()
  })

  // -------------------------------------------------------------------------
  // Open and close
  // -------------------------------------------------------------------------

  closeButton.addEventListener('click', () => {
    dialog.close()
  })

  // A click on the ::backdrop of a modal dialog reports the dialog itself as
  // its target; anything inside reports the card or a child of it. The dialog
  // has no padding of its own, so this cannot swallow a click on the card.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close()
  })

  // Browsers restore focus to the opener themselves, but only when it is still
  // focusable. Doing it here makes it certain, and covers Esc too.
  dialog.addEventListener('close', () => {
    clearFeedback()
    options.opener.focus()
  })

  options.opener.addEventListener('click', () => {
    const diagnostics = options.diagnostics()
    // Read on every open, not once at startup: Pyodide only reports CPython's
    // version after the first Run, so this row changes while the page is open.
    runtimeEl.textContent = runtimeLine(PYODIDE_VERSION, diagnostics.runtime)
    diagEl.textContent = currentDiagnosticsLine(diagnostics)
    clearFeedback()
    dialog.showModal()
    closeButton.focus()
  })
}
