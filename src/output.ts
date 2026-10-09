/**
 * The output panel's arithmetic: how much output is kept, when it is handed
 * over, and which parts of it are clickable.
 *
 * None of it touches the DOM, because all three are easy to get wrong in ways
 * that only show up as a frozen tab:
 *
 *  - **The cap.** `for i in range(10**9): print(i)` is a one-line program a
 *    beginner writes by accident. Without a ceiling it fills memory in the
 *    worker, in the message queue and in the DOM at once.
 *  - **The batching.** One `postMessage` and one DOM write per `print` is what
 *    makes a loop of ten thousand prints take seconds instead of milliseconds.
 *    The worker coalesces by size *and* by elapsed time, because it is blocked
 *    inside synchronous Python the whole time a run lasts — no timer of its
 *    own can fire, so the check has to happen on the write itself.
 *  - **The `line N` references.** A traceback is text, and the only thing that
 *    makes "line 7" clickable is recognising `File "<the buffer>", line 7` in
 *    it — and *only* for this buffer's filename, so a program that prints
 *    something traceback-shaped does not get fake links.
 */

/** Roughly 1 MB of ASCII. Counted in UTF-16 code units, which is what a JS string costs. */
export const OUTPUT_MAX_CHARS = 1_000_000
export const OUTPUT_MAX_LINES = 10_000

export const TRUNCATED_NOTICE = '--- output truncated ---\n'

/** Coalescing thresholds, applied in the worker on every write. */
export const FLUSH_CHARS = 8192
export const FLUSH_MS = 50

export interface OutputLimits {
  maxChars: number
  maxLines: number
}

export const DEFAULT_OUTPUT_LIMITS: OutputLimits = {
  maxChars: OUTPUT_MAX_CHARS,
  maxLines: OUTPUT_MAX_LINES,
}

export interface OutputLimiter {
  /**
   * The part of `text` that still fits, which is `''` once the cap is reached.
   * Check `truncated` after each call: it flips exactly once, and that is when
   * the caller emits `TRUNCATED_NOTICE`.
   */
  accept(text: string): string
  readonly truncated: boolean
  readonly chars: number
  readonly lines: number
  /** Start a new run. */
  reset(): void
}

export function createOutputLimiter(limits: OutputLimits = DEFAULT_OUTPUT_LIMITS): OutputLimiter {
  let chars = 0
  let lines = 0
  let truncated = false

  return {
    get truncated() {
      return truncated
    },
    get chars() {
      return chars
    },
    get lines() {
      return lines
    },

    reset() {
      chars = 0
      lines = 0
      truncated = false
    },

    accept(text) {
      if (truncated || text === '') return ''

      // The character cap first, so the line scan below runs over at most the
      // remaining allowance rather than over a megabyte of one long line.
      let slice = text
      const charsLeft = Math.max(0, limits.maxChars - chars)
      if (slice.length > charsLeft) {
        slice = slice.slice(0, charsLeft)
        truncated = true
      }

      // Then the line cap. `lines` counts newlines emitted, so the cut is
      // *before* the newline that would exceed it — a partial last line is
      // better than one more than promised.
      const linesLeft = Math.max(0, limits.maxLines - lines)
      let newlines = 0
      let end = slice.length
      for (let i = 0; i < slice.length; i += 1) {
        if (slice.charCodeAt(i) !== 10) continue
        if (newlines === linesLeft) {
          end = i
          truncated = true
          break
        }
        newlines += 1
      }

      if (end < slice.length) slice = slice.slice(0, end)
      chars += slice.length
      lines += newlines
      return slice
    },
  }
}

/**
 * Whether the worker should post what it has accumulated. Size keeps a burst
 * of output moving; elapsed time keeps a slow trickle from sitting invisible
 * while a long run continues.
 */
export function shouldFlush(pendingChars: number, msSinceLastFlush: number): boolean {
  if (pendingChars === 0) return false
  return pendingChars >= FLUSH_CHARS || msSinceLastFlush >= FLUSH_MS
}

// ---------------------------------------------------------------------------
// The input() prompt
// ---------------------------------------------------------------------------

/**
 * What the page shows beside its input field: the stdout text written since
 * the last newline **and since the last `input()`**.
 *
 * There is no prompt in the protocol between CPython and a stream — `input("x? ")`
 * is a plain write of `x? ` with no newline, followed by a read — so the only
 * way to recover it is to remember the tail of stdout. Hence the first half of
 * the rule. The second half is what makes it a prompt rather than a running
 * total: reading it has to consume it, or the next `input()` in the same
 * program is handed everything printed before it too.
 */
export interface PromptTracker {
  /** Record text written to stdout. */
  write(text: string): void
  /** The prompt for the `input()` starting now. Consumes it. */
  take(): string
  /** Start a new run. */
  reset(): void
}

export function createPromptTracker(): PromptTracker {
  let pending = ''

  return {
    write(text) {
      if (text === '') return
      const lastBreak = text.lastIndexOf('\n')
      pending = lastBreak === -1 ? pending + text : text.slice(lastBreak + 1)
    },

    take() {
      const prompt = pending
      pending = ''
      return prompt
    },

    reset() {
      pending = ''
    },
  }
}

// ---------------------------------------------------------------------------
// Clickable line references
// ---------------------------------------------------------------------------

export interface OutputSegment {
  text: string
  /** Set on a `File "<buffer>", line N` run, which the panel renders as a button. */
  line?: number
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Split output text into plain runs and clickable `File "<filename>", line N`
 * runs. Both shapes a user meets carry that exact header — a traceback frame
 * and a `SyntaxError` block — so one pattern covers both, and restricting it
 * to the buffer's own filename keeps a frame from inside the standard library
 * (which the editor cannot jump to) unlinked.
 */
export function linkifyOutput(text: string, filename: string): OutputSegment[] {
  if (filename === '' || text === '') return text === '' ? [] : [{ text }]

  const pattern = new RegExp(`File "${escapeForRegExp(filename)}", line (\\d+)`, 'g')
  const segments: OutputSegment[] = []
  let last = 0

  for (const match of text.matchAll(pattern)) {
    const start = match.index
    const lineText = match[1]
    if (lineText === undefined) continue
    if (start > last) segments.push({ text: text.slice(last, start) })
    segments.push({ text: match[0], line: Number(lineText) })
    last = start + match[0].length
  }

  if (last < text.length) segments.push({ text: text.slice(last) })
  return segments
}
