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

export const RUN_MODES: readonly RunMode[] = ['repl', 'script']

export function isRunMode(value: unknown): value is RunMode {
  return value === 'repl' || value === 'script'
}

/** What `pyscratch_run` in runner.py reports. */
export type RunStatus = 'ok' | 'error' | 'interrupt' | 'exit'

/** Which of the panel's three colours a piece of output belongs to. */
export type OutputStream = 'out' | 'err' | 'in'

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

/** The cap was reached; the worker has stopped forwarding this run's output. */
export interface TruncatedEvent {
  kind: 'truncated'
  id: number
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
  | TruncatedEvent
  | StdinEvent
  | DoneEvent
