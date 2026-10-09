import { describe, expect, it } from 'vitest'

import {
  awaitStdinLine,
  beginStdinWait,
  createLineQueue,
  decodeStdinLine,
  encodeStdinLine,
  isAwaitingStdin,
  resetStdin,
  sendStdinEof,
  sendStdinLine,
  splitInputLines,
  STDIN_CONTROL_BYTES,
  STDIN_DATA_BYTES,
  STDIN_IDLE,
  stdinBufferBytes,
  type StdinViews,
  stdinViews,
} from '../src/stdin.ts'

/**
 * A real `SharedArrayBuffer`, as the browser uses. Node allows `Atomics.wait`
 * on its main thread, so the worker half of the protocol can be driven here
 * too — the page writes the answer first, and the wait then returns at once
 * through the `not-equal` path, which is the race the loop in
 * `awaitStdinLine` exists to survive.
 */
function channel(dataBytes: number = STDIN_DATA_BYTES): StdinViews {
  return stdinViews(new SharedArrayBuffer(stdinBufferBytes(dataBytes)))
}

describe('the stdin buffer layout', () => {
  it('is two control words plus the data area', () => {
    expect(STDIN_CONTROL_BYTES).toBe(8)
    expect(stdinBufferBytes(1024)).toBe(8 + 1024)

    const views = channel(1024)
    expect(views.control.length).toBe(2)
    expect(views.data.length).toBe(1024)
  })

  it('starts idle after a reset', () => {
    const views = channel(64)
    resetStdin(views)
    expect(views.control[0]).toBe(STDIN_IDLE)
    expect(isAwaitingStdin(views)).toBe(false)
  })
})

describe('encoding a line into shared memory', () => {
  it('round-trips ASCII', () => {
    const views = channel(64)
    const written = encodeStdinLine('Ada', views.data)
    expect(written).toBe(3)
    expect(decodeStdinLine(views.data, written)).toBe('Ada')
  })

  it('round-trips non-ASCII, counting bytes and not characters', () => {
    const views = channel(64)
    const line = 'héllo — 日本語 🐍'
    const written = encodeStdinLine(line, views.data)

    expect(written).toBeGreaterThan(line.length)
    expect(decodeStdinLine(views.data, written)).toBe(line)
  })

  it('round-trips an empty line, which is a legitimate answer', () => {
    const views = channel(64)
    expect(encodeStdinLine('', views.data)).toBe(0)
    expect(decodeStdinLine(views.data, 0)).toBe('')
  })

  it('cuts an over-long line on a code-point boundary, not mid-sequence', () => {
    // Eight bytes of data, and a four-byte emoji straddling the end.
    const views = channel(8)
    const written = encodeStdinLine('abcdef🐍', views.data)

    expect(written).toBe(6)
    // Short, but valid text — not a replacement character.
    expect(decodeStdinLine(views.data, written)).toBe('abcdef')
    expect(decodeStdinLine(views.data, written)).not.toContain('�')
  })

  it('clamps a length that is longer than the buffer', () => {
    const views = channel(4)
    encodeStdinLine('ab', views.data)
    expect(decodeStdinLine(views.data, 9999)).toHaveLength(4)
    expect(decodeStdinLine(views.data, -5)).toBe('')
  })
})

describe('the hand-over protocol', () => {
  it('delivers a line the page sent while the worker was waiting', () => {
    const views = channel(64)
    resetStdin(views)

    beginStdinWait(views)
    expect(isAwaitingStdin(views)).toBe(true)

    sendStdinLine(views, 'Ada')
    expect(isAwaitingStdin(views)).toBe(false)
    expect(awaitStdinLine(views)).toBe('Ada')
    // And it is back to idle, so a stale answer cannot leak into the next call.
    expect(views.control[0]).toBe(STDIN_IDLE)
  })

  it('returns null on EOF, which is what makes input() raise EOFError', () => {
    const views = channel(64)
    resetStdin(views)

    beginStdinWait(views)
    sendStdinEof(views)
    expect(awaitStdinLine(views)).toBeNull()
    expect(views.control[0]).toBe(STDIN_IDLE)
  })

  it('delivers several lines in order', () => {
    const views = channel(64)
    resetStdin(views)

    const got: (string | null)[] = []
    for (const line of ['one', 'two', '']) {
      beginStdinWait(views)
      sendStdinLine(views, line)
      got.push(awaitStdinLine(views))
    }

    expect(got).toEqual(['one', 'two', ''])
  })

  it('ignores a send when nothing is waiting, so Stop cannot be answered late', () => {
    const views = channel(64)
    resetStdin(views)
    expect(isAwaitingStdin(views)).toBe(false)
  })
})

describe('the no-SharedArrayBuffer fallback', () => {
  it('hands the supplied lines over in order, then EOF', () => {
    const next = createLineQueue(['Ada', '42'])
    expect(next()).toBe('Ada')
    expect(next()).toBe('42')
    expect(next()).toBeNull()
    expect(next()).toBeNull()
  })

  it('is EOF from the start when nothing was supplied', () => {
    expect(createLineQueue([])()).toBeNull()
  })

  it('splits a textarea into lines without inventing a trailing empty one', () => {
    expect(splitInputLines('Ada\n42\n')).toEqual(['Ada', '42'])
    expect(splitInputLines('Ada\n42')).toEqual(['Ada', '42'])
    expect(splitInputLines('')).toEqual([])
    expect(splitInputLines('\n')).toEqual([''])
  })

  it('keeps a blank line in the middle, which a program may well read', () => {
    expect(splitInputLines('a\n\nb\n')).toEqual(['a', '', 'b'])
  })

  it('normalises CRLF, since the box may be pasted into from Windows', () => {
    expect(splitInputLines('a\r\nb\r\n')).toEqual(['a', 'b'])
    expect(splitInputLines('a\rb\r')).toEqual(['a', 'b'])
  })
})
