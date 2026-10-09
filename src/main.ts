import './style.css'

import { createEditor, type EditorHandle } from './editor.ts'
import {
  type DecodedFile,
  decodeFile,
  encodeFile,
  type FileMeta,
  needsOpenConfirm,
  sanitizeFilename,
} from './files.ts'
import {
  clampFontSize,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  load,
  save,
  type ScratchpadState,
  STORAGE_KEY,
  type StorageLike,
  type ThemeName,
} from './storage.ts'
import { decideOnExternalWrite, shouldWarnBeforeUnload } from './tabsync.ts'

/** Debounce for autosave. Short enough that a crash loses a keystroke, not a line. */
const SAVE_DELAY_MS = 300
const NOTICE_TIMEOUT_MS = 8000
/** Chrome cancels a download whose object URL is revoked too soon. */
const REVOKE_DELAY_MS = 30_000

const root = document.querySelector<HTMLDivElement>('#app')
if (root === null) throw new Error('#app is missing from index.html')

root.innerHTML = `
  <div class="app">
    <header class="toolbar">
      <span class="brand">py-scratchpad</span>
      <input type="text" id="filename" class="filename" aria-label="File name"
             spellcheck="false" autocomplete="off" autocapitalize="off" />
      <span class="group" role="group" aria-label="File">
        <button type="button" id="open" title="Open a .py or .txt file">Open</button>
        <button type="button" id="download" title="Download (Ctrl+S)">Download</button>
      </span>
      <input type="file" id="file-input" accept=".py,.txt,text/x-python,text/plain" hidden />
      <span class="toolbar-spacer"></span>
      <span class="group" role="group" aria-label="Font size">
        <button type="button" id="font-smaller" title="Smaller text">A&minus;</button>
        <button type="button" id="font-larger" title="Larger text">A+</button>
      </span>
      <button type="button" id="theme-toggle" class="theme-toggle"></button>
    </header>
    <div id="editor" class="editor"></div>
    <div id="notice" class="notice" role="status" aria-live="polite" hidden>
      <span id="notice-text"></span>
      <span id="notice-actions" class="notice-actions" hidden>
        <button type="button" id="notice-reload">Reload</button>
        <button type="button" id="notice-keep">Keep mine</button>
      </span>
    </div>
  </div>
`

function must<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector)
  if (el === null) throw new Error(`missing element: ${selector}`)
  return el
}

const editorHost = must<HTMLDivElement>('#editor')
const noticeEl = must<HTMLDivElement>('#notice')
const noticeTextEl = must<HTMLSpanElement>('#notice-text')
const noticeActionsEl = must<HTMLSpanElement>('#notice-actions')
const reloadButton = must<HTMLButtonElement>('#notice-reload')
const keepButton = must<HTMLButtonElement>('#notice-keep')
const filenameInput = must<HTMLInputElement>('#filename')
const fileInput = must<HTMLInputElement>('#file-input')
const openButton = must<HTMLButtonElement>('#open')
const downloadButton = must<HTMLButtonElement>('#download')
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
let bufferName = loaded.state.buffer.name
let fileMeta: FileMeta = {
  lineEnding: loaded.state.buffer.lineEnding,
  bom: loaded.state.buffer.bom,
}

let noticeTimer: number | undefined
let saveFailed = false

function showNotice(message: string, tone: 'info' | 'error', withActions = false): void {
  noticeTextEl.textContent = message
  noticeActionsEl.hidden = !withActions
  noticeEl.classList.toggle('notice-error', tone === 'error')
  noticeEl.hidden = false
  if (noticeTimer !== undefined) window.clearTimeout(noticeTimer)
  // Errors and prompts stay up: they are waiting for the user, not reporting.
  noticeTimer =
    tone === 'info' && !withActions ? window.setTimeout(hideNotice, NOTICE_TIMEOUT_MS) : undefined
}

function hideNotice(): void {
  noticeEl.hidden = true
  noticeTextEl.textContent = ''
  noticeActionsEl.hidden = true
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

function applyFilename(): void {
  filenameInput.value = bufferName
}

applyTheme()
applyFontSize()
applyFilename()

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
/** Set while this module is writing the document, so the write is not a change. */
let applyingState = false

// ---------------------------------------------------------------------------
// Autosave
// ---------------------------------------------------------------------------

/**
 * Exactly what this tab last wrote to, or read from, the storage key. The
 * multi-tab guard compares `storage` events against it; see tabsync.ts.
 */
let lastWritten: string | null = loaded.raw
/** True once another tab has written and the user has not yet chosen. */
let conflictPending = false

function currentState(): ScratchpadState {
  return {
    version: loaded.state.version,
    buffer: {
      name: bufferName,
      content: editor.getContent(),
      cursor: editor.getCursor(),
      lineEnding: fileMeta.lineEnding,
      bom: fileMeta.bom,
    },
    settings: { theme, fontSize },
  }
}

function cancelSaveTimer(): void {
  if (saveTimer !== undefined) {
    window.clearTimeout(saveTimer)
    saveTimer = undefined
  }
}

function flushSave(): void {
  cancelSaveTimer()
  if (!dirty) return
  // Paused: another tab owns the key until the user picks Reload or Keep mine.
  if (conflictPending) return

  const result = save(storage, currentState())
  if (result.ok) {
    dirty = false
    lastWritten = result.raw
    updateUnloadGuard()
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

function flushSaveAndGuard(): void {
  flushSave()
  updateUnloadGuard()
}

function scheduleSave(): void {
  if (applyingState) return
  dirty = true
  if (conflictPending) {
    // Paused and now dirty: leaving the page would lose this edit.
    updateUnloadGuard()
    return
  }
  cancelSaveTimer()
  saveTimer = window.setTimeout(flushSave, SAVE_DELAY_MS)
}

// A reload can beat the 300 ms debounce, so commit on the way out too.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushSave()
})
window.addEventListener('pagehide', flushSave)

/**
 * While autosave is paused, `pagehide` deliberately does not write — so edits
 * made during a pause would vanish on a close or a reload with no warning.
 * This is the one case where the browser's "leave site?" prompt is worth it;
 * the listener is attached only then, because a permanently registered
 * beforeunload handler can disable the back/forward cache.
 */
function warnBeforeUnload(event: BeforeUnloadEvent): void {
  event.preventDefault()
  // Ignored as text by every current browser, but still what some of them
  // check to decide whether to prompt at all.
  event.returnValue = 'Autosave is paused: unsaved changes would be lost.'
}

let unloadGuardArmed = false

function updateUnloadGuard(): void {
  const wanted = shouldWarnBeforeUnload({ paused: conflictPending, dirty })
  if (wanted === unloadGuardArmed) return

  unloadGuardArmed = wanted
  if (wanted) window.addEventListener('beforeunload', warnBeforeUnload)
  else window.removeEventListener('beforeunload', warnBeforeUnload)
}

// ---------------------------------------------------------------------------
// Multi-tab guard
// ---------------------------------------------------------------------------

window.addEventListener('storage', (event) => {
  const decision = decideOnExternalWrite({
    event: { key: event.key, newValue: event.newValue },
    storageKey: STORAGE_KEY,
    lastWritten,
    paused: conflictPending,
  })
  if (decision.kind !== 'pause') return

  conflictPending = true
  cancelSaveTimer()
  updateUnloadGuard()
  showNotice('Changed in another tab — autosave is paused here.', 'error', true)
})

/** Take the other tab's version: re-read storage and rebuild everything. */
function reloadFromStorage(): void {
  const result = load(storage, { defaultTheme: preferredTheme() })

  applyingState = true
  try {
    editor.setContent(result.state.buffer.content, result.state.buffer.cursor)
  } finally {
    applyingState = false
  }

  bufferName = result.state.buffer.name
  fileMeta = { lineEnding: result.state.buffer.lineEnding, bom: result.state.buffer.bom }
  theme = result.state.settings.theme
  fontSize = clampFontSize(result.state.settings.fontSize)
  applyFilename()
  applyTheme()
  applyFontSize()
  editor.setTheme(theme)
  editor.setFontSize(fontSize)

  dirty = false
  conflictPending = false
  lastWritten = result.raw
  updateUnloadGuard()

  if (result.problem !== undefined) showNotice(result.problem.message, 'error')
  else showNotice('Reloaded the version from the other tab.', 'info')
  editor.focus()
}

/** Keep this tab's version: resume autosave and win the race immediately. */
function keepMine(): void {
  conflictPending = false
  dirty = true
  hideNotice()
  // Order matters: hide the prompt first, so a failing save can put its own
  // notice up instead of having it wiped a line later.
  flushSaveAndGuard()
  editor.focus()
}

reloadButton.addEventListener('click', reloadFromStorage)
keepButton.addEventListener('click', keepMine)

// ---------------------------------------------------------------------------
// Filename
// ---------------------------------------------------------------------------

filenameInput.addEventListener('input', () => {
  const name = sanitizeFilename(filenameInput.value)
  if (name === bufferName) return
  bufferName = name
  scheduleSave()
})

// Snap the field to what is actually stored once the user is done typing, so
// an emptied field visibly becomes scratch.py rather than silently.
filenameInput.addEventListener('change', applyFilename)

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

function applyOpenedFile(name: string, file: DecodedFile): void {
  bufferName = name
  fileMeta = { lineEnding: file.lineEnding, bom: file.bom }
  applyFilename()
  editor.setContent(file.content)
  // Opening is a deliberate write to this tab's buffer, so it also settles a
  // pending multi-tab conflict in this tab's favour — otherwise the notice
  // below would replace the prompt and leave autosave paused with no way back.
  conflictPending = false
  dirty = true
  flushSaveAndGuard()
  showNotice(`Opened ${name}.`, 'info')
  editor.focus()
}

async function openFile(file: File): Promise<void> {
  const name = sanitizeFilename(file.name)

  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await file.arrayBuffer())
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    showNotice(`Could not read ${name}: ${reason}`, 'error')
    return
  }

  const decoded = decodeFile(bytes)
  if (!decoded.ok) {
    showNotice(`${name}: ${decoded.message}`, 'error')
    return
  }

  if (
    needsOpenConfirm(editor.getContent(), decoded.file.content) &&
    !window.confirm(`Replace the buffer with ${name}? Ctrl+Z undoes it.`)
  ) {
    return
  }

  applyOpenedFile(name, decoded.file)
}

openButton.addEventListener('click', () => {
  fileInput.click()
})

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0]
  // Clear it, or re-picking the same path fires no second change event.
  fileInput.value = ''
  if (file !== undefined) void openFile(file)
})

function dragHasFiles(event: DragEvent): boolean {
  return event.dataTransfer !== null && Array.from(event.dataTransfer.types).includes('Files')
}

/**
 * Capture phase, so a file drag is taken before CodeMirror's own drop handling
 * sees it. Text dragged inside the editor is left alone.
 */
editorHost.addEventListener(
  'dragover',
  (event) => {
    if (!dragHasFiles(event)) return
    event.preventDefault()
    event.stopPropagation()
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy'
    editorHost.classList.add('drop-target')
  },
  { capture: true },
)

editorHost.addEventListener('dragleave', (event) => {
  // Fires when crossing into a child too; only a real exit counts.
  const to = event.relatedTarget
  if (to instanceof Node && editorHost.contains(to)) return
  editorHost.classList.remove('drop-target')
})

editorHost.addEventListener(
  'drop',
  (event) => {
    if (!dragHasFiles(event)) return
    event.preventDefault()
    event.stopPropagation()
    editorHost.classList.remove('drop-target')
    const file = event.dataTransfer?.files[0]
    if (file !== undefined) void openFile(file)
  },
  { capture: true },
)

// A file dropped anywhere else would otherwise navigate the tab to it, which
// unloads the editor. Swallow it window-wide and say where it should go.
window.addEventListener('dragover', (event) => {
  if (dragHasFiles(event)) event.preventDefault()
})

window.addEventListener('drop', (event) => {
  if (!dragHasFiles(event)) return
  event.preventDefault()
  showNotice('Drop the file onto the editor to open it.', 'info')
})

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function downloadBuffer(): void {
  // The field may hold something the sanitizer rejects; the stored name wins.
  applyFilename()
  const bytes = encodeFile(editor.getContent(), fileMeta)
  const url = URL.createObjectURL(new Blob([bytes], { type: 'text/x-python' }))

  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = bufferName
  anchor.rel = 'noopener'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()

  window.setTimeout(() => {
    URL.revokeObjectURL(url)
  }, REVOKE_DELAY_MS)
}

downloadButton.addEventListener('click', downloadBuffer)

// Ctrl+S / Cmd+S downloads the buffer instead of opening "save page as".
window.addEventListener('keydown', (event) => {
  if (event.key.toLowerCase() !== 's' || event.altKey) return
  if (!event.ctrlKey && !event.metaKey) return
  event.preventDefault()
  downloadBuffer()
})

// ---------------------------------------------------------------------------
// Appearance
// ---------------------------------------------------------------------------

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
