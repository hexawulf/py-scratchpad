/**
 * The worker's lifecycle, seen from the page: load it, run the buffer, stop a
 * runaway, answer `input()`, throw the interpreter away and start again.
 *
 * Stop is the interesting part. There are two mechanisms and they are not
 * interchangeable:
 *
 *  - **Interrupt.** One byte on a `SharedArrayBuffer`; writing SIGINT into it
 *    makes the running interpreter raise `KeyboardInterrupt` at its next
 *    signal check. The interpreter — and everything it has imported — stays,
 *    so the next Run is instant. It needs cross-origin isolation.
 *  - **Terminate.** `worker.terminate()` always works and always costs a
 *    ten-megabyte reload afterwards.
 *
 * So Stop tries the interrupt, gives it `STOP_GRACE_MS`, and terminates if it
 * did not take — which also covers the case where the thread is parked on
 * `Atomics.wait` for input and is therefore not checking signals at all, and
 * the case where there is no isolation and no interrupt buffer to write to. A
 * fresh worker is started immediately rather than on the next Run, so the
 * reload happens while the user is reading their traceback.
 */

import type { OutputStream, RunMode, RunStatus, RuntimeInfo, WorkerEvent } from './protocol.ts'
import {
  isAwaitingStdin,
  sendStdinEof,
  sendStdinLine,
  type StdinViews,
  stdinBufferBytes,
  stdinViews,
} from './stdin.ts'

/** How long the interrupt gets before the worker is terminated instead. */
export const STOP_GRACE_MS = 500

/** The signal number `KeyboardInterrupt` is raised for. */
const SIGINT = 2

export type RunnerPhase =
  /** No worker: nothing has been run yet, or the last one was thrown away. */
  | 'cold'
  /** A worker exists and is fetching and starting Pyodide. */
  | 'loading'
  /** Loaded and idle. */
  | 'ready'
  /** Executing the buffer. */
  | 'running'
  /** Executing, and blocked inside `input()` waiting for a line. */
  | 'input'
  /** Loading failed; the message was reported through `onError`. */
  | 'failed'

export interface RunParams {
  source: string
  filename: string
  mode: RunMode
  /** Used only when there is no stdin channel; see `supportsInteractiveInput`. */
  inputLines: string[]
}

export interface RunnerOptions {
  /** `/pyodide/<version>/`. */
  indexUrl: string
  onPhase: (phase: RunnerPhase) => void
  onOutput: (stream: OutputStream, text: string) => void
  /** `input()` was reached; `prompt` is the partial line it printed. */
  onStdinPrompt: (prompt: string) => void
  onDone: (status: RunStatus, ms: number) => void
  onReady: (info: RuntimeInfo) => void
  onError: (message: string) => void
  /** Injectable so a test can drive the runner without a real worker. */
  createWorker?: () => Worker
}

export interface RunnerHandle {
  /** Load Python if necessary, then execute the buffer. */
  run: (params: RunParams) => void
  stop: () => void
  /** Throw the interpreter away and start a fresh one. */
  restart: () => void
  /** Answer a pending `input()`. Ignored when nothing is waiting. */
  sendInput: (line: string) => void
  /** End input, so `input()` raises `EOFError`. */
  endInput: () => void
  readonly phase: RunnerPhase
  readonly info: RuntimeInfo | null
  /**
   * Whether `input()` can be answered while the program runs. False without
   * cross-origin isolation, where the lines have to be supplied up front.
   */
  readonly supportsInteractiveInput: boolean
}

/**
 * Whether this document may use `SharedArrayBuffer`. Both halves are checked:
 * a browser can have the constructor and still refuse to let it back a
 * `WebAssembly.Memory` or an `Atomics.wait` without isolation.
 */
export function isCrossOriginIsolated(): boolean {
  return globalThis.crossOriginIsolated === true && typeof SharedArrayBuffer === 'function'
}

export function createRunner(options: RunnerOptions): RunnerHandle {
  const isolated = isCrossOriginIsolated()

  let worker: Worker | null = null
  let phase: RunnerPhase = 'cold'
  let info: RuntimeInfo | null = null

  /** The run waiting for the interpreter to finish loading, if any. */
  let queued: RunParams | null = null
  let runId = 0
  let stopTimer: number | undefined

  let interrupt: Uint8Array<SharedArrayBuffer> | null = null
  let interruptBuffer: SharedArrayBuffer | null = null
  let stdinBuffer: SharedArrayBuffer | null = null
  let stdin: StdinViews | null = null

  if (isolated) {
    interruptBuffer = new SharedArrayBuffer(1)
    interrupt = new Uint8Array(interruptBuffer)
    stdinBuffer = new SharedArrayBuffer(stdinBufferBytes())
    stdin = stdinViews(stdinBuffer)
  }

  function setPhase(next: RunnerPhase): void {
    if (phase === next) return
    phase = next
    options.onPhase(next)
  }

  function clearStopTimer(): void {
    if (stopTimer !== undefined) {
      window.clearTimeout(stopTimer)
      stopTimer = undefined
    }
  }

  function spawn(): Worker {
    const created =
      options.createWorker?.() ??
      new Worker(new URL('./pyodide.worker.ts', import.meta.url), { type: 'module' })

    created.addEventListener('message', (event: MessageEvent<WorkerEvent>) => {
      handle(created, event.data)
    })

    created.addEventListener('error', (event: ErrorEvent) => {
      if (created !== worker) return
      setPhase('failed')
      options.onError(event.message === '' ? 'The Python worker failed to start.' : event.message)
    })

    created.postMessage({
      kind: 'start',
      indexUrl: options.indexUrl,
      ...(interruptBuffer === null ? {} : { interrupt: interruptBuffer }),
      ...(stdinBuffer === null ? {} : { stdin: stdinBuffer }),
    })

    return created
  }

  function ensureWorker(): void {
    if (worker !== null) return
    setPhase('loading')
    worker = spawn()
  }

  function dispatch(params: RunParams): void {
    if (worker === null) return
    runId += 1
    setPhase('running')
    worker.postMessage({
      kind: 'run',
      id: runId,
      source: params.source,
      filename: params.filename,
      mode: params.mode,
      inputLines: params.inputLines,
    })
  }

  function handle(from: Worker, event: WorkerEvent): void {
    // A terminated worker's last messages are already in the queue; they are
    // about a run the user has abandoned, so they are dropped.
    if (from !== worker) return

    switch (event.kind) {
      case 'ready':
        info = event.info
        options.onReady(event.info)
        setPhase('ready')
        if (queued !== null) {
          const next = queued
          queued = null
          dispatch(next)
        }
        return

      case 'failed':
        setPhase('failed')
        options.onError(event.message)
        return

      case 'output':
        if (event.id !== runId) return
        options.onOutput(event.stream, event.text)
        return

      case 'truncated':
        return

      case 'stdin':
        if (event.id !== runId) return
        setPhase('input')
        options.onStdinPrompt(event.prompt)
        return

      case 'done':
        if (event.id !== runId) return
        clearStopTimer()
        setPhase('ready')
        options.onDone(event.status, event.ms)
        return
    }
  }

  /** Terminate and immediately start a replacement, so the reload overlaps. */
  function hardRestart(): void {
    clearStopTimer()
    worker?.terminate()
    worker = null
    info = null
    queued = null
    setPhase('cold')
    ensureWorker()
  }

  return {
    get phase() {
      return phase
    },
    get info() {
      return info
    },
    get supportsInteractiveInput() {
      return stdin !== null
    },

    run(params) {
      if (phase === 'running' || phase === 'input') return

      if (phase === 'failed') {
        hardRestart()
        queued = params
        return
      }

      if (worker === null || phase === 'cold' || phase === 'loading') {
        queued = params
        ensureWorker()
        return
      }

      dispatch(params)
    },

    stop() {
      if (phase === 'loading') {
        // Nothing is running yet, but the user asked to be let out of a
        // ten-megabyte download; a fresh worker starts it over cleanly.
        hardRestart()
        return
      }
      if (phase !== 'running' && phase !== 'input') return

      // A thread parked on Atomics.wait never reaches a signal check, so the
      // input has to be ended before the interrupt can possibly be seen.
      if (stdin !== null && isAwaitingStdin(stdin)) sendStdinEof(stdin)

      if (interrupt !== null) {
        Atomics.store(interrupt, 0, SIGINT)
        clearStopTimer()
        stopTimer = window.setTimeout(() => {
          stopTimer = undefined
          if (phase === 'running' || phase === 'input') {
            options.onOutput('err', 'Stopped — the interpreter was restarted.\n')
            hardRestart()
          }
        }, STOP_GRACE_MS)
        return
      }

      options.onOutput('err', 'Stopped — the interpreter was restarted.\n')
      hardRestart()
    },

    restart() {
      hardRestart()
    },

    sendInput(line) {
      if (stdin === null || !isAwaitingStdin(stdin)) return
      sendStdinLine(stdin, line)
      setPhase('running')
    },

    endInput() {
      if (stdin === null || !isAwaitingStdin(stdin)) return
      sendStdinEof(stdin)
      setPhase('running')
    },
  }
}
