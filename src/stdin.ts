/**
 * The `input()` bridge: one `SharedArrayBuffer`, shared by the page and the
 * worker, over which a line of input is handed across.
 *
 * `input()` is synchronous. By the time Python calls it, the worker thread is
 * already inside a C call and cannot return to its event loop to receive a
 * `postMessage` — so the usual way of asking the page a question is not
 * available. The only mechanism that is, is to park the worker thread on
 * `Atomics.wait` and have the page wake it with `Atomics.notify`. That needs a
 * `SharedArrayBuffer`, which only exists when the document is **cross-origin
 * isolated** (`Cross-Origin-Opener-Policy: same-origin` plus
 * `Cross-Origin-Embedder-Policy: require-corp`, and a secure context). Where
 * it is not — `http://192.168.50.120:5040`, for instance — the page falls back
 * to supplying the lines before the run starts, and this module is unused.
 *
 * Layout, one buffer:
 *
 * ```
 *   byte 0..3    control[0]  state: IDLE | WAITING | LINE | EOF
 *   byte 4..7    control[1]  byte length of the line in the data area
 *   byte 8..     data        the line, UTF-8, no trailing newline
 * ```
 *
 * `Atomics.wait` throws on a browser's main thread, so only the worker ever
 * calls `awaitStdinLine`. Both sides share this one implementation, so the
 * state machine cannot be written down twice and drift.
 */

export const STDIN_IDLE = 0
/** The worker has asked and is parked on `Atomics.wait`. */
export const STDIN_WAITING = 1
/** A line is in the data area, `control[1]` bytes long. */
export const STDIN_LINE = 2
/** No more input: `input()` must raise `EOFError`. */
export const STDIN_EOF = 3

/** Two Int32 words of control, then the data area. */
export const STDIN_CONTROL_WORDS = 2
export const STDIN_CONTROL_BYTES = STDIN_CONTROL_WORDS * 4

/** 64 KiB is far more than a line of typed input; a longer one is cut. */
export const STDIN_DATA_BYTES = 64 * 1024

export interface StdinViews {
  control: Int32Array
  data: Uint8Array
}

export function stdinBufferBytes(dataBytes: number = STDIN_DATA_BYTES): number {
  return STDIN_CONTROL_BYTES + dataBytes
}

/**
 * The two views over one buffer. Taken fresh on each side: a `SharedArrayBuffer`
 * survives `postMessage`, a typed array over it does not.
 */
export function stdinViews(buffer: ArrayBufferLike): StdinViews {
  return {
    control: new Int32Array(buffer, 0, STDIN_CONTROL_WORDS),
    data: new Uint8Array(buffer, STDIN_CONTROL_BYTES),
  }
}

/**
 * Encode one line into the data area, returning the bytes written.
 *
 * `TextEncoder.encodeInto` would be the obvious call and cannot be used: a
 * view onto a `SharedArrayBuffer` is rejected outright — Chrome says *"The
 * provided Uint8Array value must not be shared"* — so the line is encoded into
 * a fresh array and copied across. The cut for an over-long line backs off
 * over UTF-8 continuation bytes (`10xxxxxx`), so it lands on a code-point
 * boundary and the decoded line is short rather than corrupt.
 */
export function encodeStdinLine(line: string, data: Uint8Array): number {
  const bytes = new TextEncoder().encode(line)
  let length = Math.min(bytes.length, data.length)
  while (length > 0 && length < bytes.length && ((bytes[length] ?? 0) & 0xc0) === 0x80) {
    length -= 1
  }
  data.set(bytes.subarray(0, length))
  return length
}

/**
 * `slice`, not `subarray`: it copies out of the shared buffer, which both
 * avoids handing `TextDecoder` a shared view and freezes the bytes against a
 * write from the other thread while they are being read.
 */
export function decodeStdinLine(data: Uint8Array, length: number): string {
  const end = Math.max(0, Math.min(length, data.length))
  return new TextDecoder().decode(data.slice(0, end))
}

// ---------------------------------------------------------------------------
// Page side
// ---------------------------------------------------------------------------

/** Whether the worker is parked waiting for a line right now. */
export function isAwaitingStdin(views: StdinViews): boolean {
  return Atomics.load(views.control, 0) === STDIN_WAITING
}

/** Hand the worker one line and wake it. The newline is not included. */
export function sendStdinLine(views: StdinViews, line: string): void {
  const written = encodeStdinLine(line, views.data)
  Atomics.store(views.control, 1, written)
  Atomics.store(views.control, 0, STDIN_LINE)
  Atomics.notify(views.control, 0)
}

/** Tell the worker there is no more input, so `input()` raises `EOFError`. */
export function sendStdinEof(views: StdinViews): void {
  Atomics.store(views.control, 1, 0)
  Atomics.store(views.control, 0, STDIN_EOF)
  Atomics.notify(views.control, 0)
}

/** Put the channel back to rest, so a stale answer cannot leak into the next run. */
export function resetStdin(views: StdinViews): void {
  Atomics.store(views.control, 1, 0)
  Atomics.store(views.control, 0, STDIN_IDLE)
  Atomics.notify(views.control, 0)
}

// ---------------------------------------------------------------------------
// Worker side
// ---------------------------------------------------------------------------

/**
 * Mark the channel as waiting. The caller must do this **before** posting the
 * request to the page: otherwise a fast answer could land first and then be
 * overwritten by the `WAITING` store, parking the worker forever.
 */
export function beginStdinWait(views: StdinViews): void {
  Atomics.store(views.control, 0, STDIN_WAITING)
}

/**
 * Block until the page answers. Returns the line, or `null` for EOF.
 *
 * The loop re-checks rather than trusting one `wait`: `Atomics.wait` may
 * return `'not-equal'` if the answer arrived between `beginStdinWait` and
 * here, and a spurious wake is permitted by the specification.
 */
export function awaitStdinLine(views: StdinViews): string | null {
  while (Atomics.load(views.control, 0) === STDIN_WAITING) {
    Atomics.wait(views.control, 0, STDIN_WAITING)
  }

  const state = Atomics.load(views.control, 0)
  const length = Atomics.load(views.control, 1)
  Atomics.store(views.control, 0, STDIN_IDLE)

  if (state !== STDIN_LINE) return null
  return decodeStdinLine(views.data, length)
}

// ---------------------------------------------------------------------------
// The no-SharedArrayBuffer fallback
// ---------------------------------------------------------------------------

/**
 * A queue of lines supplied before the run, read in order. Returns `null` once
 * it is empty, which is what makes `input()` raise `EOFError` — the same thing
 * `python3 file.py < short-file` does.
 */
export function createLineQueue(lines: readonly string[]): () => string | null {
  let index = 0
  return () => {
    if (index >= lines.length) return null
    const line = lines[index] ?? null
    index += 1
    return line
  }
}

/**
 * Split a textarea's contents into input lines. A trailing newline is not an
 * extra empty line, but a blank line in the middle is — a program may well
 * read one.
 */
export function splitInputLines(text: string): string[] {
  if (text === '') return []
  const normalised = text.replace(/\r\n?/g, '\n')
  const lines = normalised.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}
