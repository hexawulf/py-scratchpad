/**
 * The messages between the page and the Pyodide worker.
 *
 * One module imported by both sides, so a field can never be added on one end
 * and forgotten on the other. Everything here is plain data: no `PyProxy`, no
 * function and no DOM object ever crosses the boundary, which is what lets the
 * worker be terminated and replaced at any moment without leaving anything
 * half-converted behind.
 */

/** How a Run compiles the buffer. Persisted in settings; see storage.ts. */
export type RunMode = 'repl' | 'script'

export function isRunMode(value: unknown): value is RunMode {
  return value === 'repl' || value === 'script'
}

/** What `pyscratch_run` in runner.py reports. */
export type RunStatus = 'ok' | 'error' | 'interrupt' | 'exit'

export function isRunStatus(value: unknown): value is RunStatus {
  return value === 'ok' || value === 'error' || value === 'interrupt' || value === 'exit'
}

/** Which of the panel's three colours a piece of output belongs to. */
export type OutputStream = 'out' | 'err' | 'in'

/** Maximum length accepted for short protocol strings (error/version/prompt). */
export const MAX_PROTOCOL_INFO_CHARS = 128
export const MAX_PROTOCOL_MESSAGE_CHARS = 4096

/**
 * Valid shape for the Pyodide `indexUrl` passed to the worker: a single
 * versioned segment under `/pyodide/<version>/`, with no path traversal.
 */
const INDEX_URL_PATTERN = /^\/pyodide\/[0-9A-Za-z._-]+\/$/

export function isValidIndexUrl(value: unknown): value is string {
  return typeof value === 'string' && INDEX_URL_PATTERN.test(value) && !value.includes('..')
}

export interface RuntimeInfo {
  /** The npm package's version, e.g. `314.0.7`. */
  pyodide: string
  /** `platform.python_version()` inside it, e.g. `3.14.2`. */
  python: string
}

// ---------------------------------------------------------------------------
// Page → worker
// ---------------------------------------------------------------------------

export interface StartRequest {
  kind: 'start'
  /** `/pyodide/<version>/`, with the trailing slash `loadPyodide` wants. */
  indexUrl: string
  /**
   * One byte on a `SharedArrayBuffer`. Writing 2 (SIGINT) into it makes the
   * running interpreter raise `KeyboardInterrupt` at its next check, which is
   * how Stop keeps the interpreter — and its loaded modules — alive. Absent
   * when the page is not cross-origin isolated: `SharedArrayBuffer` does not
   * exist there, and Stop falls back to terminating the worker.
   */
  interrupt?: SharedArrayBuffer
  /**
   * The stdin channel, laid out by stdin.ts. Absent for the same reason, in
   * which case `input()` is fed from `inputLines` instead.
   */
  stdin?: SharedArrayBuffer
  /**
   * Optional dedicated reply channel transferred from the page. When present,
   * the worker replies exclusively on this closure-private port so user Python
   * code calling `js.postMessage(...)` on the worker global scope cannot spoof
   * protocol events.
   */
  port?: MessagePort
}

export interface RunRequest {
  kind: 'run'
  /** Increments per Run; a late message from a terminated worker is ignored. */
  id: number
  source: string
  /** The buffer's filename, so tracebacks and `__file__` name it. */
  filename: string
  mode: RunMode
  /**
   * Lines handed to `input()` in order when there is no stdin channel. Empty
   * when the channel exists, or when the user supplied nothing: `input()` then
   * raises `EOFError`, exactly as a piped-in empty stdin would.
   */
  inputLines: string[]
}

export type WorkerRequest = StartRequest | RunRequest

// ---------------------------------------------------------------------------
// Worker → page
// ---------------------------------------------------------------------------

export interface ReadyEvent {
  kind: 'ready'
  info: RuntimeInfo
}

export interface FailedEvent {
  kind: 'failed'
  message: string
}

export interface OutputEvent {
  kind: 'output'
  id: number
  stream: 'out' | 'err'
  text: string
}

/** `input()` was called and the worker is now blocked waiting for a line. */
export interface StdinEvent {
  kind: 'stdin'
  id: number
  /** Whatever the program printed since its last newline, e.g. `name? `. */
  prompt: string
}

export interface DoneEvent {
  kind: 'done'
  id: number
  status: RunStatus
  /** Wall-clock milliseconds the run took, for the panel's footer. */
  ms: number
}

export type WorkerEvent =
  | ReadyEvent
  | FailedEvent
  | OutputEvent
  | StdinEvent
  | DoneEvent

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isSharedArrayBuffer(value: unknown): value is SharedArrayBuffer {
  return typeof SharedArrayBuffer === 'function' && value instanceof SharedArrayBuffer
}

function isMessagePort(value: unknown): value is MessagePort {
  return typeof MessagePort === 'function' && value instanceof MessagePort
}

/**
 * Runtime validator for messages received by the page from the worker.
 * Untrusted Python inside Pyodide can reach `js.postMessage(...)` on the
 * worker global scope, so every field is checked before touching UI state.
 */
export function parseWorkerEvent(value: unknown): WorkerEvent | null {
  if (!isPlainRecord(value) || typeof value.kind !== 'string') return null

  switch (value.kind) {
    case 'ready': {
      if (!isPlainRecord(value.info)) return null
      if (typeof value.info.pyodide !== 'string' || typeof value.info.python !== 'string') {
        return null
      }
      return {
        kind: 'ready',
        info: {
          pyodide: value.info.pyodide.slice(0, MAX_PROTOCOL_INFO_CHARS),
          python: value.info.python.slice(0, MAX_PROTOCOL_INFO_CHARS),
        },
      }
    }

    case 'failed': {
      if (typeof value.message !== 'string') return null
      return {
        kind: 'failed',
        message: value.message.slice(0, MAX_PROTOCOL_MESSAGE_CHARS),
      }
    }

    case 'output': {
      if (!isPositiveInt(value.id)) return null
      if (value.stream !== 'out' && value.stream !== 'err') return null
      if (typeof value.text !== 'string') return null
      return { kind: 'output', id: value.id, stream: value.stream, text: value.text }
    }

    case 'stdin': {
      if (!isPositiveInt(value.id) || typeof value.prompt !== 'string') return null
      return { kind: 'stdin', id: value.id, prompt: value.prompt }
    }

    case 'done': {
      if (!isPositiveInt(value.id) || !isRunStatus(value.status)) return null
      if (typeof value.ms !== 'number' || !Number.isFinite(value.ms) || value.ms < 0) return null
      return { kind: 'done', id: value.id, status: value.status, ms: value.ms }
    }

    default:
      return null
  }
}

/** Runtime validator for messages received by the worker from the page. */
export function parseWorkerRequest(value: unknown): WorkerRequest | null {
  if (!isPlainRecord(value) || typeof value.kind !== 'string') return null

  if (value.kind === 'start') {
    if (!isValidIndexUrl(value.indexUrl)) return null
    if (value.interrupt !== undefined && (!isSharedArrayBuffer(value.interrupt) || value.interrupt.byteLength < 1)) {
      return null
    }
    if (value.stdin !== undefined && (!isSharedArrayBuffer(value.stdin) || value.stdin.byteLength < 8)) {
      return null
    }
    if (value.port !== undefined && !isMessagePort(value.port)) return null
    return {
      kind: 'start',
      indexUrl: value.indexUrl,
      ...(value.interrupt === undefined ? {} : { interrupt: value.interrupt }),
      ...(value.stdin === undefined ? {} : { stdin: value.stdin }),
      ...(value.port === undefined ? {} : { port: value.port }),
    }
  }

  if (value.kind === 'run') {
    if (!isPositiveInt(value.id)) return null
    if (typeof value.source !== 'string' || typeof value.filename !== 'string') return null
    if (!isRunMode(value.mode)) return null
    if (!Array.isArray(value.inputLines) || !value.inputLines.every((line) => typeof line === 'string')) {
      return null
    }
    return {
      kind: 'run',
      id: value.id,
      source: value.source,
      filename: value.filename,
      mode: value.mode,
      inputLines: value.inputLines,
    }
  }

  return null
}
