import './style.css'

import type { RuntimeDiagnostics } from './about.ts'
import { createAboutDialog } from './aboutdialog.ts'
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
import {
  CONFLICT_NOTICE,
  isTransient,
  MOVE_NOTICE,
  MOVE_NOTICE_DISMISSED_KEY,
  type NoticeState,
  type NoticeTone,
  RELOADED_NOTICE,
  shouldShowMoveNotice,
} from './notice.ts'
import { linkifyOutput } from './output.ts'
import type { OutputStream, RunMode, RunStatus, RuntimeInfo } from './protocol.ts'
import { createRunner, isCrossOriginIsolated, type RunnerPhase } from './runner.ts'
import { splitInputLines } from './stdin.ts'
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
      <span class="group" role="group" aria-label="Run">
        <button type="button" id="run" class="run-button" title="Run (Ctrl+Enter)">Run</button>
        <button type="button" id="stop" title="Stop the running program" disabled>Stop</button>
      </span>
      <select id="run-mode" class="run-mode" aria-label="Run mode"
              title="REPL echo prints the value of a bare expression, as the >>> prompt does. Script runs the buffer like python3 file.py.">
        <option value="repl">REPL echo</option>
        <option value="script">Script</option>
      </select>
      <span class="toolbar-spacer"></span>
      <span class="group" role="group" aria-label="Font size">
        <button type="button" id="font-smaller" title="Smaller text">A&minus;</button>
        <button type="button" id="font-larger" title="Larger text">A+</button>
      </span>
      <button type="button" id="theme-toggle" class="theme-toggle"></button>
      <button type="button" id="about-open" class="icon-button" aria-label="About"
              title="About" aria-haspopup="dialog">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4" />
          <path d="M12 8h.01" />
        </svg>
      </button>
    </header>
    <details id="program-input" class="program-input" hidden>
      <summary>Program input</summary>
      <textarea id="program-input-text" class="program-input-text" rows="3" spellcheck="false"
                autocomplete="off" aria-describedby="program-input-note"
                placeholder="One line per input() call"></textarea>
      <p id="program-input-note" class="program-input-note"></p>
    </details>
    <div id="editor" class="editor"></div>
    <section id="output" class="output" hidden aria-label="Program output">
      <header class="output-head">
        <span class="output-title">Output</span>
        <span id="output-status" class="output-status" role="status" aria-live="polite"></span>
        <span class="toolbar-spacer"></span>
        <button type="button" id="restart-python"
                title="Throw the interpreter away and start a fresh one">Restart Python</button>
        <button type="button" id="output-clear">Clear</button>
      </header>
      <div id="output-log" class="output-log" tabindex="0"></div>
      <form id="stdin-form" class="stdin" hidden>
        <label id="stdin-prompt" class="stdin-prompt" for="stdin-input"></label>
        <input type="text" id="stdin-input" class="stdin-input" autocomplete="off"
               spellcheck="false" autocapitalize="off" aria-label="Program input line" />
        <button type="submit">Enter</button>
      </form>
    </section>
    <div id="notice" class="notice" role="status" aria-live="polite" hidden>
      <span id="notice-text" class="notice-text"></span>
      <a id="notice-link" class="notice-link" target="_blank" rel="noopener noreferrer" hidden></a>
      <span id="notice-actions" class="notice-actions" hidden>
        <button type="button" id="notice-reload">Reload</button>
        <button type="button" id="notice-keep">Keep mine</button>
      </span>
      <button type="button" id="notice-dismiss" class="notice-dismiss icon-button"
              aria-label="Dismiss this notice" title="Dismiss" hidden>
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M6 6l12 12" />
          <path d="M18 6L6 18" />
        </svg>
      </button>
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
const noticeLinkEl = must<HTMLAnchorElement>('#notice-link')
const noticeDismissButton = must<HTMLButtonElement>('#notice-dismiss')
const reloadButton = must<HTMLButtonElement>('#notice-reload')
const keepButton = must<HTMLButtonElement>('#notice-keep')
const filenameInput = must<HTMLInputElement>('#filename')
const fileInput = must<HTMLInputElement>('#file-input')
const openButton = must<HTMLButtonElement>('#open')
const downloadButton = must<HTMLButtonElement>('#download')
const themeButton = must<HTMLButtonElement>('#theme-toggle')
const smallerButton = must<HTMLButtonElement>('#font-smaller')
const largerButton = must<HTMLButtonElement>('#font-larger')
const aboutButton = must<HTMLButtonElement>('#about-open')
const runButton = must<HTMLButtonElement>('#run')
const stopButton = must<HTMLButtonElement>('#stop')
const runModeSelect = must<HTMLSelectElement>('#run-mode')
const outputPanel = must<HTMLElement>('#output')
const outputStatusEl = must<HTMLSpanElement>('#output-status')
const outputLogEl = must<HTMLDivElement>('#output-log')
const clearOutputButton = must<HTMLButtonElement>('#output-clear')
const restartButton = must<HTMLButtonElement>('#restart-python')
const stdinForm = must<HTMLFormElement>('#stdin-form')
const stdinPromptEl = must<HTMLLabelElement>('#stdin-prompt')
const stdinInput = must<HTMLInputElement>('#stdin-input')
const programInput = must<HTMLDetailsElement>('#program-input')
const programInputText = must<HTMLTextAreaElement>('#program-input-text')
const programInputNote = must<HTMLParagraphElement>('#program-input-note')

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
let runMode: RunMode = loaded.state.settings.runMode
let fileMeta: FileMeta = {
  lineEnding: loaded.state.buffer.lineEnding,
  bom: loaded.state.buffer.bom,
}

let noticeTimer: number | undefined
let saveFailed = false

/** Show one of the fixed notices from notice.ts: message, link and actions together. */
function showNoticeState(state: NoticeState): void {
  noticeTextEl.textContent = state.message
  noticeActionsEl.hidden = !state.actions

  if (state.link === undefined) {
    noticeLinkEl.hidden = true
    noticeLinkEl.removeAttribute('href')
    noticeLinkEl.textContent = ''
  } else {
    noticeLinkEl.href = state.link.href
    noticeLinkEl.textContent = state.link.label
    noticeLinkEl.hidden = false
  }

  noticeDismissButton.hidden = state.dismissible !== true
  noticeEl.classList.toggle('notice-error', state.tone === 'error')
  noticeEl.hidden = false
  if (noticeTimer !== undefined) window.clearTimeout(noticeTimer)
  // Errors and prompts stay up: they are waiting for the user, not reporting.
  noticeTimer = isTransient(state) ? window.setTimeout(hideNotice, NOTICE_TIMEOUT_MS) : undefined
}

function showNotice(message: string, tone: NoticeTone, withActions = false): void {
  showNoticeState({ message, tone, actions: withActions })
}

function hideNotice(): void {
  noticeEl.hidden = true
  noticeTextEl.textContent = ''
  noticeActionsEl.hidden = true
  noticeLinkEl.hidden = true
  noticeLinkEl.removeAttribute('href')
  noticeLinkEl.textContent = ''
  noticeDismissButton.hidden = true
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

function applyRunMode(): void {
  runModeSelect.value = runMode
}

applyTheme()
applyFontSize()
applyFilename()
applyRunMode()

const editor: EditorHandle = createEditor({
  parent: editorHost,
  content: loaded.state.buffer.content,
  cursor: loaded.state.buffer.cursor,
  theme,
  fontSize,
  onChange: scheduleSave,
  onRun: () => {
    startRun()
  },
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
    settings: { theme, fontSize, runMode },
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
  showNoticeState(CONFLICT_NOTICE)
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
  runMode = result.state.settings.runMode
  applyFilename()
  applyTheme()
  applyFontSize()
  applyRunMode()
  editor.setTheme(theme)
  editor.setFontSize(fontSize)

  dirty = false
  conflictPending = false
  lastWritten = result.raw
  updateUnloadGuard()

  if (result.problem !== undefined) showNotice(result.problem.message, 'error')
  else showNoticeState(RELOADED_NOTICE)
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
// The move notice
// ---------------------------------------------------------------------------

/**
 * `window.sessionStorage` throws outright when site data is blocked, exactly
 * as `localStorage` does, so both the read and the write are guarded. A
 * browser that cannot remember the dismissal simply shows the notice again.
 */
function readSessionFlag(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key)
  } catch {
    return null
  }
}

function writeSessionFlag(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value)
  } catch {
    // Nothing to do: the notice comes back, which is the harmless direction.
  }
}

noticeDismissButton.addEventListener('click', () => {
  writeSessionFlag(MOVE_NOTICE_DISMISSED_KEY, '1')
  hideNotice()
})

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

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

runModeSelect.addEventListener('change', () => {
  runMode = runModeSelect.value === 'script' ? 'script' : 'repl'
  applyRunMode()
  scheduleSave()
})

/**
 * Output is appended on an animation frame rather than per message: a `print`
 * loop produces thousands of small writes, and one DOM insertion each is what
 * makes the panel, rather than the interpreter, the slow part.
 */
let outputPending: { stream: OutputStream; text: string }[] = []
let outputFrame: number | undefined

/** Within this many pixels of the bottom counts as "following the output". */
const FOLLOW_SLACK_PX = 24

function logIsAtBottom(): boolean {
  const { scrollTop, scrollHeight, clientHeight } = outputLogEl
  return scrollHeight - scrollTop - clientHeight <= FOLLOW_SLACK_PX
}

/**
 * One chunk as DOM nodes. `File "<buffer>", line N` becomes a button, so a
 * traceback is navigable; everything else stays text, because output is the
 * program's and must never be interpreted as markup.
 */
function renderChunk(stream: OutputStream, text: string): Node[] {
  const nodes: Node[] = []

  for (const segment of linkifyOutput(text, bufferName)) {
    if (segment.line === undefined) {
      const span = document.createElement('span')
      span.className = `out-${stream}`
      span.textContent = segment.text
      nodes.push(span)
      continue
    }

    const button = document.createElement('button')
    button.type = 'button'
    button.className = `out-${stream} out-ref`
    button.textContent = segment.text
    button.dataset.line = String(segment.line)
    button.title = `Go to line ${String(segment.line)}`
    nodes.push(button)
  }

  return nodes
}

/**
 * Append everything queued. Called on an animation frame, and directly
 * whenever the UI is about to say something about the run — a status of
 * "Done in 207 ms", or an input() prompt — because either would otherwise be
 * on screen for a frame while the output it refers to was still queued.
 */
function flushOutputToDom(): void {
  if (outputFrame !== undefined) {
    window.cancelAnimationFrame(outputFrame)
    outputFrame = undefined
  }

  const batch = outputPending
  outputPending = []
  if (batch.length === 0) return

  const follow = logIsAtBottom()
  const fragment = document.createDocumentFragment()
  for (const chunk of batch) fragment.append(...renderChunk(chunk.stream, chunk.text))
  outputLogEl.append(fragment)
  if (follow) outputLogEl.scrollTop = outputLogEl.scrollHeight
}

function appendOutput(stream: OutputStream, text: string): void {
  if (text === '') return
  outputPending.push({ stream, text })
  outputFrame ??= window.requestAnimationFrame(flushOutputToDom)
}

function clearOutput(): void {
  outputPending = []
  if (outputFrame !== undefined) {
    window.cancelAnimationFrame(outputFrame)
    outputFrame = undefined
  }
  outputLogEl.replaceChildren()
}

function setRunStatus(message: string): void {
  outputStatusEl.textContent = message
}

outputLogEl.addEventListener('click', (event) => {
  const target = event.target
  if (!(target instanceof HTMLElement)) return
  const line = target.closest<HTMLElement>('.out-ref')?.dataset.line
  if (line === undefined) return
  editor.goToLine(Number(line))
})

// ---------------------------------------------------------------------------
// The worker
// ---------------------------------------------------------------------------

/** Set once Pyodide has reported its versions; the About dialog reads it. */
let runtimeInfo: RuntimeInfo | null = null

function endStdinPrompt(): void {
  stdinForm.hidden = true
  stdinPromptEl.textContent = ''
  stdinInput.value = ''
}

const STATUS_FOR_PHASE: Partial<Record<RunnerPhase, string>> = {
  loading: 'Loading Python…',
  running: 'Running…',
  input: 'Waiting for input…',
}

function applyPhase(phase: RunnerPhase): void {
  const busy = phase === 'running' || phase === 'input'
  runButton.disabled = busy
  stopButton.disabled = !busy && phase !== 'loading'
  runButton.classList.toggle('is-busy', busy || phase === 'loading')

  if (phase !== 'input') endStdinPrompt()
  const status = STATUS_FOR_PHASE[phase]
  if (status !== undefined) setRunStatus(status)
}

const runner = createRunner({
  indexUrl: typeof __PYODIDE_INDEX_URL__ === 'string' ? __PYODIDE_INDEX_URL__ : '/pyodide/',
  onPhase: applyPhase,
  onOutput: appendOutput,

  onReady: (info) => {
    runtimeInfo = info
  },

  onError: (message) => {
    setRunStatus('Python failed to load')
    appendOutput('err', `${message}\n`)
    showNotice(`Python could not be loaded: ${message}`, 'error')
  },

  onStdinPrompt: (prompt) => {
    // The prompt is the tail of output already sent; paint that first.
    flushOutputToDom()
    stdinPromptEl.textContent = prompt === '' ? 'Input:' : prompt
    stdinForm.hidden = false
    stdinInput.value = ''
    stdinInput.focus()
  },

  onDone: (status, ms) => {
    flushOutputToDom()
    setRunStatus(doneMessage(status, ms))
  },
})

function doneMessage(status: RunStatus, ms: number): string {
  const took = ms < 1000 ? `${String(Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`
  if (status === 'interrupt') return `Stopped after ${took}`
  if (status === 'error') return `Finished with an error in ${took}`
  if (status === 'exit') return `Exited after ${took}`
  return `Done in ${took}`
}

/**
 * `input()` cannot be answered mid-run without `SharedArrayBuffer`, which
 * needs cross-origin isolation — true on https://py-scratchpad.com, false on
 * the plain-HTTP LAN endpoint, which is not a secure context. There the lines
 * are supplied before the Run instead, and the box says why.
 */
if (!runner.supportsInteractiveInput) {
  programInput.hidden = false
  programInputNote.textContent =
    'This page is not cross-origin isolated (it needs HTTPS, or localhost), so a program cannot ' +
    'stop and ask while it runs. Lines typed here are fed to input() in order; when they run out, ' +
    'input() raises EOFError.'
}

function startRun(): void {
  if (runner.phase === 'running' || runner.phase === 'input') return

  outputPanel.hidden = false
  clearOutput()
  endStdinPrompt()
  setRunStatus(runner.phase === 'ready' ? 'Running…' : 'Loading Python…')

  runner.run({
    source: editor.getContent(),
    filename: bufferName,
    mode: runMode,
    inputLines: runner.supportsInteractiveInput ? [] : splitInputLines(programInputText.value),
  })
}

runButton.addEventListener('click', startRun)

stopButton.addEventListener('click', () => {
  runner.stop()
  setRunStatus('Stopping…')
})

clearOutputButton.addEventListener('click', () => {
  clearOutput()
  setRunStatus('')
  editor.focus()
})

restartButton.addEventListener('click', () => {
  runner.restart()
  appendOutput('err', 'Python restarted — every name from the last run is gone.\n')
  setRunStatus('Loading Python…')
})

stdinForm.addEventListener('submit', (event) => {
  event.preventDefault()
  if (runner.phase !== 'input') return

  const line = stdinInput.value
  // Echo it, the way a terminal shows what was typed at a prompt.
  appendOutput('in', `${line}\n`)
  // The field is cleared and hidden by applyPhase, which runs when sendInput
  // moves the phase back to 'running'. Leaving it to that means a send that
  // does not take leaves the prompt on screen rather than a dead end.
  runner.sendInput(line)
})

// Ctrl+Enter also works when the focus is outside the editor; inside it, the
// editor's own high-precedence keymap handles it (see editor.ts).
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.altKey || event.shiftKey) return
  if (!event.ctrlKey && !event.metaKey) return
  // Not while typing an answer to input(): there, Enter already means "send".
  if (event.target === stdinInput) return
  event.preventDefault()
  startRun()
})

// ---------------------------------------------------------------------------
// About
// ---------------------------------------------------------------------------

function aboutDiagnostics(): RuntimeDiagnostics {
  return {
    storage: storageAvailable ? 'localStorage' : 'in-memory',
    autosavePaused: conflictPending,
    theme,
    online: window.navigator.onLine,
    runtime: runtimeInfo,
    isolated: isCrossOriginIsolated(),
  }
}

createAboutDialog({ opener: aboutButton, diagnostics: aboutDiagnostics })

// Last, so a real problem with this tab's storage outranks the move notice.
// Any later notice replaces the move one; it returns on the next load of the
// old hostname unless it was dismissed.
if (shouldShowMoveNotice(window.location.hostname, readSessionFlag(MOVE_NOTICE_DISMISSED_KEY))) {
  showNoticeState(MOVE_NOTICE)
}

if (!storageAvailable) {
  showNotice('This browser is blocking site data, so nothing will be saved on reload.', 'error')
} else if (loaded.problem !== undefined) {
  showNotice(loaded.problem.message, 'error')
}

editor.focus()
