import './style.css'

import { createEditor, type EditorHandle } from './editor.ts'
import {
  clampFontSize,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  load,
  save,
  type ScratchpadState,
  type StorageLike,
  type ThemeName,
} from './storage.ts'

/** Debounce for autosave. Short enough that a crash loses a keystroke, not a line. */
const SAVE_DELAY_MS = 300
const NOTICE_TIMEOUT_MS = 8000

const root = document.querySelector<HTMLDivElement>('#app')
if (root === null) throw new Error('#app is missing from index.html')

root.innerHTML = `
  <div class="app">
    <header class="toolbar">
      <span class="brand">py-scratchpad</span>
      <span class="toolbar-spacer"></span>
      <span class="group" role="group" aria-label="Font size">
        <button type="button" id="font-smaller" title="Smaller text">A&minus;</button>
        <button type="button" id="font-larger" title="Larger text">A+</button>
      </span>
      <button type="button" id="theme-toggle" class="theme-toggle"></button>
    </header>
    <div id="editor" class="editor"></div>
    <p id="notice" class="notice" role="status" aria-live="polite" hidden></p>
  </div>
`

function must<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector)
  if (el === null) throw new Error(`missing element: ${selector}`)
  return el
}

const editorHost = must<HTMLDivElement>('#editor')
const noticeEl = must<HTMLParagraphElement>('#notice')
const themeButton = must<HTMLButtonElement>('#theme-toggle')
const smallerButton = must<HTMLButtonElement>('#font-smaller')
const largerButton = must<HTMLButtonElement>('#font-larger')

/**
 * `window.localStorage` itself throws when site data is blocked, so even
 * reaching for it needs a guard. Without it the editor still works; it just
 * cannot persist, and the notice says so.
 */
function openStorage(): StorageLike | null {
  try {
    const probe = window.localStorage
    // Touch it: some browsers only throw on first use.
    probe.getItem('py-scratchpad:probe')
    return probe
  } catch {
    return null
  }
}

const memoryFallback = new Map<string, string>()
const realStorage = openStorage()
const storageAvailable = realStorage !== null
const storage: StorageLike = realStorage ?? {
  getItem: (key) => memoryFallback.get(key) ?? null,
  setItem: (key, value) => void memoryFallback.set(key, value),
}

function preferredTheme(): ThemeName {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

const loaded = load(storage, { defaultTheme: preferredTheme() })
let theme: ThemeName = loaded.state.settings.theme
let fontSize = clampFontSize(loaded.state.settings.fontSize)
const bufferName = loaded.state.buffer.name

let noticeTimer: number | undefined
let saveFailed = false

function showNotice(message: string, tone: 'info' | 'error'): void {
  noticeEl.textContent = message
  noticeEl.classList.toggle('notice-error', tone === 'error')
  noticeEl.hidden = false
  if (noticeTimer !== undefined) window.clearTimeout(noticeTimer)
  noticeTimer = tone === 'info' ? window.setTimeout(hideNotice, NOTICE_TIMEOUT_MS) : undefined
}

function hideNotice(): void {
  noticeEl.hidden = true
  noticeEl.textContent = ''
  noticeEl.classList.remove('notice-error')
}

function applyTheme(): void {
  document.documentElement.dataset.theme = theme
  themeButton.textContent = theme === 'dark' ? '☾ Dark' : '☀ Light'
  themeButton.title = `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`
  themeButton.setAttribute('aria-label', themeButton.title)
}

function applyFontSize(): void {
  smallerButton.disabled = fontSize <= FONT_SIZE_MIN
  largerButton.disabled = fontSize >= FONT_SIZE_MAX
}

applyTheme()
applyFontSize()

const editor: EditorHandle = createEditor({
  parent: editorHost,
  content: loaded.state.buffer.content,
  cursor: loaded.state.buffer.cursor,
  theme,
  fontSize,
  onChange: scheduleSave,
})

let saveTimer: number | undefined
let dirty = false

function currentState(): ScratchpadState {
  return {
    version: loaded.state.version,
    buffer: { name: bufferName, content: editor.getContent(), cursor: editor.getCursor() },
    settings: { theme, fontSize },
  }
}

function flushSave(): void {
  if (saveTimer !== undefined) {
    window.clearTimeout(saveTimer)
    saveTimer = undefined
  }
  if (!dirty) return

  const result = save(storage, currentState())
  if (result.ok) {
    dirty = false
    if (saveFailed) {
      saveFailed = false
      hideNotice()
    }
    return
  }

  // Leave `dirty` set so the next flush retries.
  saveFailed = true
  showNotice(`Autosave failed — your code is not being saved. ${result.message}`, 'error')
}

function scheduleSave(): void {
  dirty = true
  if (saveTimer !== undefined) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(flushSave, SAVE_DELAY_MS)
}

// A reload can beat the 300 ms debounce, so commit on the way out too.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushSave()
})
window.addEventListener('pagehide', flushSave)

themeButton.addEventListener('click', () => {
  theme = theme === 'dark' ? 'light' : 'dark'
  applyTheme()
  editor.setTheme(theme)
  scheduleSave()
})

function stepFontSize(delta: number): void {
  const next = clampFontSize(fontSize + delta)
  if (next === fontSize) return
  fontSize = next
  applyFontSize()
  editor.setFontSize(fontSize)
  scheduleSave()
}

smallerButton.addEventListener('click', () => {
  stepFontSize(-1)
})
largerButton.addEventListener('click', () => {
  stepFontSize(1)
})

if (!storageAvailable) {
  showNotice('This browser is blocking site data, so nothing will be saved on reload.', 'error')
} else if (loaded.problem !== undefined) {
  showNotice(loaded.problem.message, 'error')
}

editor.focus()
