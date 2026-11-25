/**
 * The Stop / restart state machine in `src/runner.ts`, driven with a fake
 * worker.
 *
 * What it pins is the interrupt byte. It sits on a `SharedArrayBuffer` that
 * outlives every run and every worker, so a Stop that nothing consumed used to
 * be delivered to the next thing that ran Python: the following Run ended at
 * once with "Stopped after 0 ms", and a replacement worker failed to load with
 * "KeyboardInterrupt".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  parseWorkerEvent,
  parseWorkerRequest,
  type RunStatus,
  type WorkerEvent,
} from '../src/protocol.ts'
import { OUTPUT_MAX_CHARS, PROMPT_MAX_CHARS } from '../src/output.ts'
import { createRunner, type RunnerPhase, type RunParams, STOP_GRACE_MS } from '../src/runner.ts'
import { beginStdinWait, stdinViews } from '../src/stdin.ts'

const SIGINT = 2

interface StartMessage {
  kind: 'start'
  interrupt?: SharedArrayBuffer
  stdin?: SharedArrayBuffer
}

interface RunMessage {
  kind: 'run'
  id: number
}

class FakeWorker {
  readonly posted: (StartMessage | RunMessage)[] = []
  terminated = false
  private readonly listeners: ((event: { data: WorkerEvent }) => void)[] = []

  postMessage(message: StartMessage | RunMessage): void {
    this.posted.push(message)
  }

  addEventListener(type: string, listener: (event: { data: WorkerEvent }) => void): void {
    if (type === 'message') this.listeners.push(listener)
  }

  terminate(): void {
    this.terminated = true
  }

  /** Deliver a message from the "worker" to the page (allows malformed payloads in tests). */
  emit(event: unknown): void {
    for (const listener of this.listeners) listener({ data: event as WorkerEvent })
  }

  ready(): void {
    this.emit({ kind: 'ready', info: { pyodide: 'test', python: 'test' } })
  }

  get lastRunId(): number {
    const runs = this.posted.filter((message): message is RunMessage => message.kind === 'run')
    return runs[runs.length - 1]?.id ?? 0
  }

  /** The interrupt byte as this worker's interpreter would read it. */
  get interruptByte(): number {
    const start = this.posted.find((message): message is StartMessage => message.kind === 'start')
    if (start?.interrupt === undefined) throw new Error('no interrupt buffer was handed over')
    return new Uint8Array(start.interrupt)[0] ?? -1
  }
}

const PARAMS: RunParams = { source: 'pass', filename: 'scratch.py', mode: 'script', inputLines: [] }

function harness() {
  const workers: FakeWorker[] = []
  const phases: RunnerPhase[] = []
  const errors: string[] = []
  const output: string[] = []
  const done: RunStatus[] = []

  const runner = createRunner({
    indexUrl: '/pyodide/test/',
    onPhase: (phase) => phases.push(phase),
    onOutput: (_stream, text) => output.push(text),
    onStdinPrompt: () => undefined,
    onDone: (status) => done.push(status),
    onReady: () => undefined,
    onError: (message) => errors.push(message),
    createWorker: () => {
      const worker = new FakeWorker()
      workers.push(worker)
      return worker as unknown as Worker
    },
  })

  const latest = (): FakeWorker => {
    const worker = workers[workers.length - 1]
    if (worker === undefined) throw new Error('no worker was created')
    return worker
  }

  return { runner, workers, phases, errors, output, done, latest }
}

beforeEach(() => {
  vi.useFakeTimers()
  // The runner uses window.setTimeout and checks for cross-origin isolation.
  vi.stubGlobal('window', globalThis)
  vi.stubGlobal('crossOriginIsolated', true)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Stop', () => {
  it('writes SIGINT for the running program to see', () => {
    const { runner, latest } = harness()
    runner.run(PARAMS)
    latest().ready()
    expect(runner.phase).toBe('running')

    runner.stop()
    expect(latest().interruptByte).toBe(SIGINT)
  })

  it('does not leave SIGINT behind when the run was already finishing', () => {
    const { runner, latest, done } = harness()
    runner.run(PARAMS)
    const worker = latest()
    worker.ready()

    // Stop is clicked, but the program ends by itself before a signal check.
    runner.stop()
    worker.emit({ kind: 'done', id: worker.lastRunId, status: 'ok', ms: 3 })

    expect(done).toEqual(['ok'])
    expect(worker.interruptByte).toBe(0)

    // The next Run starts clean, and the grace timer does not fire later.
    runner.run(PARAMS)
    expect(worker.interruptByte).toBe(0)
    vi.advanceTimersByTime(STOP_GRACE_MS * 2)
    expect(runner.phase).toBe('running')
    expect(worker.terminated).toBe(false)
  })

  it('clears a stale SIGINT when a run is dispatched', () => {
    const { runner, latest } = harness()
    runner.run(PARAMS)
    const worker = latest()
    worker.ready()
    worker.emit({ kind: 'done', id: worker.lastRunId, status: 'ok', ms: 1 })

    // Something left the byte set between runs.
    const start = worker.posted[0] as StartMessage
    if (start.interrupt === undefined) throw new Error('no interrupt buffer')
    new Uint8Array(start.interrupt)[0] = SIGINT

    runner.run(PARAMS)
    expect(worker.interruptByte).toBe(0)
  })

  it('hands the replacement worker a cleared buffer after a forced stop', () => {
    const { runner, workers, latest, output, errors } = harness()
    runner.run(PARAMS)
    const first = latest()
    first.ready()

    // The program never reaches a signal check, so the grace period runs out.
    runner.stop()
    expect(first.interruptByte).toBe(SIGINT)
    vi.advanceTimersByTime(STOP_GRACE_MS)

    expect(first.terminated).toBe(true)
    expect(workers).toHaveLength(2)
    expect(output.join('')).toContain('the interpreter was restarted')

    // The same buffer, and nothing in it for runner.py to trip over.
    const second = latest()
    expect(second).not.toBe(first)
    expect(second.interruptByte).toBe(0)
    expect(runner.phase).toBe('loading')

    second.ready()
    runner.run(PARAMS)
    expect(runner.phase).toBe('running')
    expect(second.interruptByte).toBe(0)
    expect(errors).toEqual([])
  })

  it('ignores the terminated worker and its late messages', () => {
    const { runner, latest, done } = harness()
    runner.run(PARAMS)
    const first = latest()
    first.ready()
    const abandoned = first.lastRunId

    runner.stop()
    vi.advanceTimersByTime(STOP_GRACE_MS)
    first.emit({ kind: 'done', id: abandoned, status: 'interrupt', ms: 600 })

    expect(done).toEqual([])
    expect(runner.phase).toBe('loading')
  })

  it('clears the buffer on Restart Python too', () => {
    const { runner, latest } = harness()
    runner.run(PARAMS)
    latest().ready()
    runner.stop()

    runner.restart()
    expect(latest().interruptByte).toBe(0)
  })

  it('while loading, starts the download over instead of interrupting', () => {
    const { runner, workers } = harness()
    runner.run(PARAMS)
    expect(runner.phase).toBe('loading')

    runner.stop()
    expect(workers).toHaveLength(2)
    expect(workers[0]?.terminated).toBe(true)
    expect(workers[1]?.interruptByte).toBe(0)
  })
})

describe('protocol validation and worker isolation', () => {
  it('ignores malformed worker events and invalid streams without throwing', () => {
    const { runner, latest, output, done, errors } = harness()
    runner.run(PARAMS)
    const worker = latest()
    worker.ready()

    worker.emit(null)
    worker.emit('not-an-object')
    worker.emit({ kind: 'unknown' })
    worker.emit({ kind: 'output', id: worker.lastRunId, stream: 'out injected', text: 'bad' })
    worker.emit({ kind: 'output', id: worker.lastRunId, stream: 'out', text: 123 })
    worker.emit({ kind: 'done', id: worker.lastRunId, status: 'bogus', ms: 1 })
    worker.emit({ kind: 'done', id: worker.lastRunId, status: 'ok', ms: Number.NaN })

    expect(output).toEqual([])
    expect(done).toEqual([])
    expect(errors).toEqual([])
    expect(runner.phase).toBe('running')
  })

  it('rejects forged ready events while a run is active', () => {
    const { runner, latest } = harness()
    runner.run(PARAMS)
    const worker = latest()
    worker.ready()
    expect(runner.phase).toBe('running')

    // A spoofed ready event during an active run must not reset phase to ready.
    worker.emit({ kind: 'ready', info: { pyodide: 'fake', python: 'fake' } })
    expect(runner.phase).toBe('running')
  })

  it('rejects forged stdin events when the stdin SAB is not awaiting input', () => {
    const prompts: string[] = []
    const workers: FakeWorker[] = []
    const runner = createRunner({
      indexUrl: '/pyodide/test/',
      onPhase: () => undefined,
      onOutput: () => undefined,
      onStdinPrompt: (prompt) => prompts.push(prompt),
      onDone: () => undefined,
      onReady: () => undefined,
      onError: () => undefined,
      createWorker: () => {
        const w = new FakeWorker()
        workers.push(w)
        return w as unknown as Worker
      },
    })

    runner.run(PARAMS)
    const worker = workers[0]
    if (worker === undefined) throw new Error('expected worker')
    worker.ready()

    // Without beginStdinWait on the SAB, forged stdin events must be dropped.
    worker.emit({ kind: 'stdin', id: worker.lastRunId, prompt: 'spoof: ' })
    expect(runner.phase).toBe('running')
    expect(prompts).toEqual([])

    // When genuinely awaiting stdin, prompt is accepted and bounded to PROMPT_MAX_CHARS.
    const start = worker.posted[0]
    if (start?.kind !== 'start' || start.stdin === undefined) {
      throw new Error('expected start message with stdin buffer')
    }
    const views = stdinViews(start.stdin)
    beginStdinWait(views)
    worker.emit({ kind: 'stdin', id: worker.lastRunId, prompt: 'a'.repeat(PROMPT_MAX_CHARS + 50) })
    expect(runner.phase).toBe('input')
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toHaveLength(PROMPT_MAX_CHARS)
  })

  it('enforces a main-thread output cap even if the worker bypasses its own limiter', () => {
    const { runner, latest, output } = harness()
    runner.run(PARAMS)
    const worker = latest()
    worker.ready()

    const chunk = 'x'.repeat(200_000)
    for (let i = 0; i < 10; i += 1) {
      worker.emit({ kind: 'output', id: worker.lastRunId, stream: 'out', text: chunk })
    }

    const total = output.join('')
    expect(total).toContain('--- output truncated ---')
    expect(total.length).toBeLessThanOrEqual(OUTPUT_MAX_CHARS + 64)
  })

  it('validates worker requests and rejects unsafe indexUrl values', () => {
    expect(parseWorkerRequest({ kind: 'start', indexUrl: '/pyodide/314.0.8/' })).not.toBeNull()
    expect(parseWorkerRequest({ kind: 'start', indexUrl: 'https://evil.example/' })).toBeNull()
    expect(parseWorkerRequest({ kind: 'start', indexUrl: '/pyodide/../etc/' })).toBeNull()
    expect(parseWorkerRequest({ kind: 'unknown' })).toBeNull()
    expect(parseWorkerEvent({ kind: 'ready', info: { pyodide: '1', python: '3' } })).not.toBeNull()
  })
})
