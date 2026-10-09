/**
 * The Pyodide worker: one interpreter, one run at a time.
 *
 * Everything about this file follows from two constraints.
 *
 * **It must be a worker.** `while True: pass` is a program a beginner writes
 * on purpose, and CPython-in-WASM has no pre-emption: on the main thread it
 * would freeze the tab, including the Stop button. Here it only freezes this
 * thread, and the page stays responsive throughout — including during the
 * ten-megabyte first load, which is why nothing is fetched until the first Run.
 *
 * **Nothing may leave the origin.** The CSP is `default-src 'self'` with
 * `connect-src 'self'`, so `indexURL` points at `/pyodide/<version>/` on this
 * host (staged by `build/pyodide.ts`) and `packageBaseUrl` is pinned to the
 * same place — otherwise `loadPyodide` would default it to jsdelivr and a
 * stray `loadPackage` could reach for a CDN. No package is ever loaded and
 * `micropip` is never imported: v0.3 is the standard library and nothing else.
 *
 * `pyodide.mjs` is imported from that URL rather than bundled. Its Node branch
 * `import`s `node:fs`, `node:vm` and `ws`, which a bundler has to be argued
 * out of resolving, and keeping it out of the bundle keeps the worker chunk
 * small enough to parse instantly.
 */

import type { PyodideInterface } from 'pyodide'

import {
  createOutputLimiter,
  FLUSH_MS,
  shouldFlush,
  TRUNCATED_NOTICE,
} from './output.ts'
import type { RunRequest, RunStatus, StartRequest, WorkerEvent, WorkerRequest } from './protocol.ts'
import runnerSource from './runner.py?raw'
import {
  awaitStdinLine,
  beginStdinWait,
  createLineQueue,
  resetStdin,
  type StdinViews,
  stdinViews,
} from './stdin.ts'

/**
 * The slice of the worker global scope this file uses. Declared rather than
 * pulled in from the `webworker` lib, because that lib and `DOM` cannot both
 * be in one program without colliding — and the rest of `src/` needs `DOM`.
 */
interface WorkerScope {
  postMessage(message: WorkerEvent): void
  addEventListener(type: 'message', handler: (event: { data: unknown }) => void): void
}

const scope = self as unknown as WorkerScope

function post(event: WorkerEvent): void {
  scope.postMessage(event)
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type PyscratchRun = (source: string, filename: string, mode: string) => string

let pyodide: PyodideInterface | null = null
let pyscratchRun: PyscratchRun | null = null
let stdin: StdinViews | null = null
/** Set for the duration of one run; `null` between runs. */
let current: RunRequest | null = null
/** The fallback input source, rebuilt per run when there is no stdin channel. */
let nextQueuedLine: (() => string | null) | null = null

const limiter = createOutputLimiter()

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const decoder = new TextDecoder()

/** Per-stream pending text, flushed together so interleaving is preserved. */
let pending: { stream: 'out' | 'err'; text: string }[] = []
let pendingChars = 0
let lastFlush = 0
/**
 * The current partial line of stdout — everything printed since the last
 * newline. That is exactly what `input("name? ")` leaves behind, so it is the
 * prompt the page shows next to its input field.
 */
let partialLine = ''

function flushOutput(): void {
  if (pending.length === 0) return
  const batch = pending
  pending = []
  pendingChars = 0
  lastFlush = performance.now()

  const id = current?.id ?? 0
  for (const chunk of batch) {
    post({ kind: 'output', id, stream: chunk.stream, text: chunk.text })
  }
}

function emit(stream: 'out' | 'err', text: string): void {
  if (text === '') return

  if (stream === 'out') {
    const lastBreak = text.lastIndexOf('\n')
    partialLine = lastBreak === -1 ? partialLine + text : text.slice(lastBreak + 1)
  }

  const wasTruncated = limiter.truncated
  const kept = limiter.accept(text)

  if (kept !== '') {
    const last = pending[pending.length - 1]
    // Coalesce consecutive writes to the same stream: `print` can produce
    // several, and one message per `print` is the cost this avoids.
    if (last !== undefined && last.stream === stream) last.text += kept
    else pending.push({ stream, text: kept })
    pendingChars += kept.length
  }

  if (!wasTruncated && limiter.truncated) {
    pending.push({ stream: 'err', text: TRUNCATED_NOTICE })
    pendingChars += TRUNCATED_NOTICE.length
    flushOutput()
    post({ kind: 'truncated', id: current?.id ?? 0 })
    return
  }

  if (shouldFlush(pendingChars, performance.now() - lastFlush)) flushOutput()
}

/**
 * `isatty: false` on purpose. With a tty, CPython routes an `input()` prompt
 * to **stderr** through the readline path; without one it goes to stdout, in
 * its own write, before stdin is read — which is what lets the prompt reach
 * the page at all. The `Writer` form (rather than `batched`) is what makes
 * that write arrive immediately instead of waiting for a newline that an
 * `input()` prompt never has.
 */
function installStreams(py: PyodideInterface): void {
  py.setStdout({
    isatty: false,
    write: (buffer: Uint8Array) => {
      emit('out', decoder.decode(buffer))
      return buffer.length
    },
  })

  py.setStderr({
    isatty: false,
    write: (buffer: Uint8Array) => {
      emit('err', decoder.decode(buffer))
      return buffer.length
    },
  })

  py.setStdin({
    isatty: false,
    // autoEOF (the default) terminates each returned line for us, so one call
    // of this function is exactly one line for `input()`.
    stdin: () => {
      // Whatever is pending — the prompt included — has to be on screen before
      // this thread parks, or the user is asked a question they cannot see.
      flushOutput()

      if (stdin !== null) {
        const prompt = partialLine
        beginStdinWait(stdin)
        post({ kind: 'stdin', id: current?.id ?? 0, prompt })
        return awaitStdinLine(stdin)
      }

      return nextQueuedLine?.() ?? null
    },
  })
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

interface PyodideModule {
  loadPyodide: (options: {
    indexURL: string
    packageBaseUrl: string
    packages: string[]
  }) => Promise<PyodideInterface>
}

async function start(request: StartRequest): Promise<void> {
  // @vite-ignore: the URL is built from a define, and the module must stay out
  // of the bundle (see the file comment).
  const module = (await import(/* @vite-ignore */ `${request.indexUrl}pyodide.mjs`)) as PyodideModule

  const py = await module.loadPyodide({
    indexURL: request.indexUrl,
    // Pinned to this origin as well: left unset it defaults to jsdelivr.
    packageBaseUrl: request.indexUrl,
    packages: [],
  })

  // Absent without cross-origin isolation, where Stop terminates instead.
  if (request.interrupt !== undefined) py.setInterruptBuffer(new Uint8Array(request.interrupt))

  if (request.stdin !== undefined) {
    stdin = stdinViews(request.stdin)
    resetStdin(stdin)
  }

  installStreams(py)

  // Defines `pyscratch_run`. Executed once, so each later Run is one call.
  py.runPython(runnerSource)

  // `globals` is a PyProxy, whose `get` is typed `any`; narrowing it here is
  // what keeps the rest of this file free of unchecked calls.
  const globals = py.globals as unknown as { get: (name: string) => unknown }
  const run = globals.get('pyscratch_run')
  if (typeof run !== 'function') throw new Error('runner.py did not define pyscratch_run')

  const python = py.runPython('import platform; platform.python_version()') as unknown

  pyodide = py
  pyscratchRun = run as PyscratchRun

  post({
    kind: 'ready',
    info: { pyodide: py.version, python: typeof python === 'string' ? python : 'unknown' },
  })
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function execute(request: RunRequest): void {
  if (pyscratchRun === null || pyodide === null) {
    post({ kind: 'failed', message: 'Python is not loaded yet.' })
    return
  }

  current = request
  limiter.reset()
  pending = []
  pendingChars = 0
  partialLine = ''
  lastFlush = performance.now() - FLUSH_MS
  nextQueuedLine = stdin === null ? createLineQueue(request.inputLines) : null
  if (stdin !== null) resetStdin(stdin)

  const started = performance.now()
  let status: RunStatus

  try {
    status = pyscratchRun(request.source, request.filename, request.mode) as RunStatus
  } catch (error) {
    // runner.py catches everything Python can raise, so reaching here means
    // the interpreter itself failed — a KeyboardInterrupt delivered between
    // statements, or an out-of-memory abort.
    const message = error instanceof Error ? error.message : String(error)
    status = /KeyboardInterrupt/.test(message) ? 'interrupt' : 'error'
    emit('err', `${message}\n`)
  }

  flushOutput()
  post({ kind: 'done', id: request.id, status, ms: performance.now() - started })
  current = null
  nextQueuedLine = null
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function isWorkerRequest(value: unknown): value is WorkerRequest {
  return typeof value === 'object' && value !== null && 'kind' in value
}

scope.addEventListener('message', (event) => {
  if (!isWorkerRequest(event.data)) return
  const request = event.data

  if (request.kind === 'start') {
    start(request).catch((error: unknown) => {
      post({
        kind: 'failed',
        message: error instanceof Error ? error.message : String(error),
      })
    })
    return
  }

  execute(request)
})
