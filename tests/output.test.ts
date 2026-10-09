import { describe, expect, it } from 'vitest'

import {
  createOutputLimiter,
  createPromptTracker,
  DEFAULT_OUTPUT_LIMITS,
  FLUSH_CHARS,
  FLUSH_MS,
  linkifyOutput,
  OUTPUT_MAX_CHARS,
  OUTPUT_MAX_LINES,
  shouldFlush,
} from '../src/output.ts'

describe('the output cap', () => {
  it('passes everything through below the limits', () => {
    const limiter = createOutputLimiter({ maxChars: 100, maxLines: 10 })

    expect(limiter.accept('hello\n')).toBe('hello\n')
    expect(limiter.accept('world\n')).toBe('world\n')
    expect(limiter.truncated).toBe(false)
    expect(limiter.chars).toBe(12)
    expect(limiter.lines).toBe(2)
  })

  it('cuts the chunk that crosses the character limit', () => {
    const limiter = createOutputLimiter({ maxChars: 8, maxLines: 100 })

    expect(limiter.accept('abcde')).toBe('abcde')
    expect(limiter.truncated).toBe(false)
    expect(limiter.accept('fghij')).toBe('fgh')
    expect(limiter.truncated).toBe(true)
  })

  it('reports nothing more once it is truncated', () => {
    const limiter = createOutputLimiter({ maxChars: 4, maxLines: 100 })

    limiter.accept('abcdefgh')
    expect(limiter.truncated).toBe(true)
    expect(limiter.accept('more')).toBe('')
    expect(limiter.chars).toBe(4)
  })

  it('cuts before the newline that would exceed the line limit', () => {
    const limiter = createOutputLimiter({ maxChars: 1000, maxLines: 2 })

    expect(limiter.accept('one\ntwo\nthree\n')).toBe('one\ntwo\nthree')
    expect(limiter.lines).toBe(2)
    expect(limiter.truncated).toBe(true)
  })

  it('counts lines across chunks, not within one', () => {
    const limiter = createOutputLimiter({ maxChars: 1000, maxLines: 3 })

    expect(limiter.accept('a\n')).toBe('a\n')
    expect(limiter.accept('b\n')).toBe('b\n')
    expect(limiter.accept('c\nd\n')).toBe('c\nd')
    expect(limiter.lines).toBe(3)
    expect(limiter.truncated).toBe(true)
  })

  it('truncates a line-limited chunk whose first character is the newline', () => {
    const limiter = createOutputLimiter({ maxChars: 1000, maxLines: 1 })

    expect(limiter.accept('x\n')).toBe('x\n')
    expect(limiter.accept('\n')).toBe('')
    expect(limiter.truncated).toBe(true)
  })

  it('accepts nothing for an empty chunk and does not trip the cap', () => {
    const limiter = createOutputLimiter({ maxChars: 0, maxLines: 0 })
    expect(limiter.accept('')).toBe('')
    expect(limiter.truncated).toBe(false)
  })

  it('starts over on reset, which is what a new Run does', () => {
    const limiter = createOutputLimiter({ maxChars: 4, maxLines: 100 })
    limiter.accept('abcdef')
    expect(limiter.truncated).toBe(true)

    limiter.reset()
    expect(limiter.truncated).toBe(false)
    expect(limiter.accept('abcd')).toBe('abcd')
  })

  it('ships a megabyte and ten thousand lines by default', () => {
    expect(DEFAULT_OUTPUT_LIMITS).toEqual({
      maxChars: OUTPUT_MAX_CHARS,
      maxLines: OUTPUT_MAX_LINES,
    })
    expect(OUTPUT_MAX_CHARS).toBe(1_000_000)
    expect(OUTPUT_MAX_LINES).toBe(10_000)
  })

  it('survives a print loop without growing past the cap', () => {
    const limiter = createOutputLimiter()
    let kept = 0
    for (let i = 0; i < 200_000; i += 1) kept += limiter.accept(`${String(i)}\n`).length

    expect(limiter.truncated).toBe(true)
    expect(kept).toBeLessThanOrEqual(OUTPUT_MAX_CHARS)
    expect(limiter.lines).toBeLessThanOrEqual(OUTPUT_MAX_LINES)
  })
})

describe('when the worker hands output over', () => {
  it('holds a trickle back until the time threshold', () => {
    expect(shouldFlush(10, 0)).toBe(false)
    expect(shouldFlush(10, FLUSH_MS)).toBe(true)
  })

  it('flushes a burst on size alone', () => {
    expect(shouldFlush(FLUSH_CHARS, 0)).toBe(true)
    expect(shouldFlush(FLUSH_CHARS - 1, 0)).toBe(false)
  })

  it('never flushes nothing', () => {
    expect(shouldFlush(0, 10_000)).toBe(false)
  })
})

describe('the input() prompt', () => {
  it('is the text written since the last newline', () => {
    const prompt = createPromptTracker()

    prompt.write('hello\n')
    prompt.write('width: ')
    expect(prompt.take()).toBe('width: ')
  })

  it('does not carry the first prompt into the second', () => {
    // The 0.3.2 bug: `w = input("width: ")` followed by `h = input("height: ")`
    // showed `width: height: ` at the second field.
    const prompt = createPromptTracker()

    prompt.write('width: ')
    expect(prompt.take()).toBe('width: ')

    prompt.write('height: ')
    expect(prompt.take()).toBe('height: ')
  })

  it('keeps three consecutive prompts separate', () => {
    const prompt = createPromptTracker()

    for (const text of ['a: ', 'b: ', 'c: ']) {
      prompt.write(text)
      expect(prompt.take()).toBe(text)
    }
  })

  it('handles a prompt with no trailing space', () => {
    const prompt = createPromptTracker()

    prompt.write('width:')
    expect(prompt.take()).toBe('width:')

    prompt.write('height:')
    expect(prompt.take()).toBe('height:')
  })

  it('is not polluted by a print() between two inputs', () => {
    const prompt = createPromptTracker()

    prompt.write('width: ')
    expect(prompt.take()).toBe('width: ')

    // `print("ok")` reaches the stream as the text and the newline separately.
    prompt.write('ok')
    prompt.write('\n')
    prompt.write('height: ')
    expect(prompt.take()).toBe('height: ')
  })

  it('is empty for input() with no prompt', () => {
    const prompt = createPromptTracker()

    expect(prompt.take()).toBe('')

    // Still empty after a completed line: a bare `input()` prints nothing, so
    // there is nothing since the newline to show.
    prompt.write('some output\n')
    expect(prompt.take()).toBe('')

    // And after an earlier prompt was answered.
    prompt.write('width: ')
    expect(prompt.take()).toBe('width: ')
    expect(prompt.take()).toBe('')
  })

  it('takes the tail of a chunk that spans several lines', () => {
    const prompt = createPromptTracker()

    prompt.write('one\ntwo\nthree: ')
    expect(prompt.take()).toBe('three: ')
  })

  it('ignores an empty write and starts each run clean', () => {
    const prompt = createPromptTracker()

    prompt.write('width: ')
    prompt.write('')
    expect(prompt.take()).toBe('width: ')

    prompt.write('left over')
    prompt.reset()
    expect(prompt.take()).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Clickable line references
// ---------------------------------------------------------------------------

describe('clickable line references', () => {
  it('links a traceback frame for this buffer', () => {
    const text = '  File "scratch.py", line 7, in <module>\n    boom()\n'
    expect(linkifyOutput(text, 'scratch.py')).toEqual([
      { text: '  ' },
      { text: 'File "scratch.py", line 7', line: 7 },
      { text: ', in <module>\n    boom()\n' },
    ])
  })

  it('links the SyntaxError header, which has the same shape', () => {
    const text = '  File "scratch.py", line 2\n    x = (\n        ^\nSyntaxError: never closed\n'
    const linked = linkifyOutput(text, 'scratch.py').filter((segment) => segment.line !== undefined)
    expect(linked).toEqual([{ text: 'File "scratch.py", line 2', line: 2 }])
  })

  it('links every frame of a multi-frame traceback', () => {
    const text =
      'Traceback (most recent call last):\n' +
      '  File "scratch.py", line 6, in <module>\n' +
      '  File "scratch.py", line 2, in boom\n' +
      'ZeroDivisionError: division by zero\n'
    const lines = linkifyOutput(text, 'scratch.py')
      .map((segment) => segment.line)
      .filter((line) => line !== undefined)
    expect(lines).toEqual([6, 2])
  })

  it('leaves a frame from another file alone, because the editor cannot go there', () => {
    const text = '  File "/lib/python314.zip/json/decoder.py", line 355, in raw_decode\n'
    expect(linkifyOutput(text, 'scratch.py')).toEqual([{ text }])
  })

  it('does not invent a link for a program that prints traceback-shaped text', () => {
    const text = 'see File "other.py", line 1 for details\n'
    expect(linkifyOutput(text, 'scratch.py')).toEqual([{ text }])
  })

  it('treats a filename with regex characters literally', () => {
    const text = '  File "a+b(1).py", line 3, in <module>\n'
    const linked = linkifyOutput(text, 'a+b(1).py').filter((s) => s.line !== undefined)
    expect(linked).toEqual([{ text: 'File "a+b(1).py", line 3', line: 3 }])

    // And the escaped name must not match a different name that the unescaped
    // pattern would have: `a+b(1).py` as a regex also matches `aab1xpy`.
    expect(linkifyOutput('  File "aab1xpy", line 3\n', 'a+b(1).py')).toEqual([
      { text: '  File "aab1xpy", line 3\n' },
    ])
  })

  it('returns nothing for empty text, and no links without a filename', () => {
    expect(linkifyOutput('', 'scratch.py')).toEqual([])
    expect(linkifyOutput('File "x", line 1', '')).toEqual([{ text: 'File "x", line 1' }])
  })
})
