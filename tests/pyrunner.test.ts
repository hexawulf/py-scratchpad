/**
 * `src/runner.py`, exercised in the real interpreter.
 *
 * The `pyodide` npm package runs under Node, so the identical source the
 * worker loads can be checked here without a browser — which is the only way
 * to pin the two things the UI cannot fake: that REPL echo mode prints what
 * the `>>>` prompt prints, and that a traceback carries the editor's own line
 * numbers with no runtime frames above them.
 *
 * It is the same pinned package `build/pyodide.ts` stages into `dist/`, so a
 * version bump is checked here before it reaches a browser.
 */

import { readFileSync } from 'node:fs'

import { beforeAll, describe, expect, it } from 'vitest'

import { loadPyodide } from 'pyodide'

const RUNNER_SOURCE = readFileSync(new URL('../src/runner.py', import.meta.url), 'utf8')
const FILENAME = 'scratch.py'

/** Starting CPython in WASM is seconds, not milliseconds. */
const BOOT_TIMEOUT_MS = 120_000

type RunMode = 'repl' | 'script'
type RunStatus = 'ok' | 'error' | 'interrupt' | 'exit'

interface Captured {
  status: RunStatus
  out: string
  err: string
}

let runOnce: (source: string, filename: string, mode: RunMode) => Captured

beforeAll(async () => {
  const py = await loadPyodide({ packages: [] })
  py.runPython(RUNNER_SOURCE)

  const globals = py.globals as unknown as { get: (name: string) => unknown }
  const pyscratchRun = globals.get('pyscratch_run') as (
    source: string,
    filename: string,
    mode: string,
  ) => string

  let out = ''
  let err = ''
  const decoder = new TextDecoder()

  // Exactly the worker's stream setup: a Writer with isatty false, which is
  // what puts an input() prompt on stdout before stdin is read.
  py.setStdout({
    isatty: false,
    write: (buffer: Uint8Array) => {
      out += decoder.decode(buffer)
      return buffer.length
    },
  })
  py.setStderr({
    isatty: false,
    write: (buffer: Uint8Array) => {
      err += decoder.decode(buffer)
      return buffer.length
    },
  })
  py.setStdin({ isatty: false, stdin: () => null })

  runOnce = (source, filename, mode) => {
    out = ''
    err = ''
    const status = pyscratchRun(source, filename, mode) as RunStatus
    return { status, out, err }
  }
}, BOOT_TIMEOUT_MS)

describe('REPL echo mode', () => {
  it('prints the value of each bare expression, as the >>> prompt does', () => {
    const result = runOnce('10 + 20 * 30\n4**2 / 30\n(9**4 + 2) * 6 - 1\n', FILENAME, 'repl')

    expect(result.status).toBe('ok')
    expect(result.err).toBe('')
    expect(result.out.trimEnd().split('\n')).toEqual(['610', '0.5333333333333333', '39377'])
  })

  it('prints nothing for None, a statement or an assignment', () => {
    const result = runOnce('None\nx = 5\nif True:\n    pass\n', FILENAME, 'repl')

    expect(result.status).toBe('ok')
    expect(result.out).toBe('')
  })

  it('shows a repr, not a str — the difference the prompt makes visible', () => {
    expect(runOnce('"hi"\n', FILENAME, 'repl').out).toBe("'hi'\n")
    expect(runOnce('print("hi")\n', FILENAME, 'repl').out).toBe('hi\n')
  })

  it('keeps print output and echoed values in order', () => {
    const result = runOnce('print("first")\n2 + 2\nprint("last")\n', FILENAME, 'repl')
    expect(result.out).toBe('first\n4\nlast\n')
  })

  it('binds _ to the last value, as the prompt does', () => {
    expect(runOnce('1 + 1\n_ * 10\n', FILENAME, 'repl').out).toBe('2\n20\n')
  })
})

describe('Script mode', () => {
  it('runs the buffer like python3 file.py: a bare expression prints nothing', () => {
    const result = runOnce('10 + 20 * 30\n4**2 / 30\n(9**4 + 2) * 6 - 1\n', FILENAME, 'script')

    expect(result.status).toBe('ok')
    expect(result.out).toBe('')
    expect(result.err).toBe('')
  })

  it('still prints what the program prints', () => {
    expect(runOnce('print(6 * 7)\n', FILENAME, 'script').out).toBe('42\n')
  })

  it('sets __name__ to __main__, so the usual guard fires', () => {
    const source = 'if __name__ == "__main__":\n    print("main")\n'
    expect(runOnce(source, FILENAME, 'script').out).toBe('main\n')
  })

  it('names the buffer as __file__', () => {
    expect(runOnce('print(__file__)\n', 'exercise1.py', 'script').out).toBe('exercise1.py\n')
  })
})

describe('a fresh namespace per run', () => {
  it('does not carry a name over from the previous run', () => {
    expect(runOnce('leftover = 1\n', FILENAME, 'script').status).toBe('ok')

    const second = runOnce('print(leftover)\n', FILENAME, 'script')
    expect(second.status).toBe('error')
    expect(second.err).toContain("NameError: name 'leftover' is not defined")
  })

  it('does not carry an import over either', () => {
    expect(runOnce('import math\n', FILENAME, 'script').status).toBe('ok')
    expect(runOnce('print(math.pi)\n', FILENAME, 'script').err).toContain('NameError')
  })
})

describe('tracebacks', () => {
  it('uses the buffer filename and the editor line numbers', () => {
    const source = 'def boom():\n    return 1 / 0\n\n\nprint("before")\nboom()\n'
    const result = runOnce(source, FILENAME, 'script')

    expect(result.status).toBe('error')
    expect(result.out).toBe('before\n')
    expect(result.err).toContain('File "scratch.py", line 6, in <module>')
    expect(result.err).toContain('File "scratch.py", line 2, in boom')
    expect(result.err).toContain('ZeroDivisionError: division by zero')
  })

  it('strips the frames above the buffer', () => {
    const result = runOnce('1 / 0\n', FILENAME, 'script')

    // Exactly one frame: the user's line. Nothing from runner.py, nothing
    // from whatever Pyodide compiled this module as.
    expect(result.err.match(/ {2}File /g)).toHaveLength(1)
    expect(result.err).not.toContain('<exec>')
    expect(result.err).not.toContain('pyscratch_run')
    expect(result.err).not.toContain('runner.py')
  })

  it('shows the offending source line and its caret', () => {
    const result = runOnce('x = 1\ny = x + nope\n', FILENAME, 'script')
    expect(result.err).toContain('y = x + nope')
    expect(result.err).toMatch(/\^/)
  })

  it('keeps a standard-library frame, which is part of the story', () => {
    const result = runOnce('import json\njson.loads("{oops}")\n', FILENAME, 'script')
    expect(result.err).toContain('File "scratch.py", line 2')
    expect(result.err).toContain('decoder.py')
    expect(result.err).toContain('JSONDecodeError')
  })

  it('strips the runtime frames from a chained exception too', () => {
    const source = 'try:\n    1 / 0\nexcept ZeroDivisionError:\n    raise ValueError("boom")\n'
    const result = runOnce(source, FILENAME, 'script')

    expect(result.err).toContain('File "scratch.py", line 2')
    expect(result.err).toContain('File "scratch.py", line 4')
    expect(result.err).toContain('During handling of the above exception')
    expect(result.err).not.toContain('<exec>')
  })

  it('reports a traceback the same way in REPL echo mode', () => {
    const result = runOnce('print("a")\n1 / 0\n', FILENAME, 'repl')
    expect(result.out).toBe('a\n')
    expect(result.err).toContain('File "scratch.py", line 2, in <module>')
  })
})

describe('syntax errors', () => {
  it('are reported before anything runs, even in REPL echo mode', () => {
    const result = runOnce('print("never")\nx = (\n', FILENAME, 'repl')

    expect(result.status).toBe('error')
    // The crucial part: the good line above did not run.
    expect(result.out).toBe('')
    expect(result.err).toContain('File "scratch.py", line 2')
    expect(result.err).toContain('SyntaxError')
  })

  it('carry the line and a caret', () => {
    const result = runOnce('def f(:\n    pass\n', FILENAME, 'script')
    expect(result.err).toContain('File "scratch.py", line 1')
    expect(result.err).toMatch(/\^/)
  })

  it('catch a compile-time error that parsing alone does not', () => {
    const result = runOnce('return 1\n', FILENAME, 'repl')
    expect(result.status).toBe('error')
    expect(result.err).toContain('SyntaxError')
    expect(result.out).toBe('')
  })

  it('report an IndentationError as one', () => {
    const result = runOnce('def f():\nreturn 1\n', FILENAME, 'script')
    expect(result.err).toContain('IndentationError')
    expect(result.err).toContain('File "scratch.py", line 2')
  })
})

describe('modules that cannot exist in a browser tab', () => {
  it('explains turtle in one line instead of dumping a traceback', () => {
    const result = runOnce('import turtle\n', FILENAME, 'script')

    expect(result.status).toBe('error')
    expect(result.err).toContain('turtle draws through tkinter')
    expect(result.err).not.toContain('Traceback')
    expect(result.err.trimEnd().split('\n')).toHaveLength(1)
  })

  it('explains tkinter, however it is imported', () => {
    expect(runOnce('import tkinter\n', FILENAME, 'script').err).toContain(
      'tkinter needs a desktop window system',
    )
    expect(runOnce('from tkinter import ttk\n', FILENAME, 'script').err).toContain(
      'tkinter needs a desktop window system',
    )
  })

  it('says why a third-party package is missing, rather than just that it is', () => {
    const result = runOnce('import numpy\n', FILENAME, 'script')

    expect(result.err).toContain("No module named 'numpy'")
    expect(result.err).toContain('standard library only')
    expect(result.err).not.toContain('Traceback')
  })

  it('leaves a real ImportError from a present module as a normal traceback', () => {
    const result = runOnce('from math import nope\n', FILENAME, 'script')
    expect(result.err).toContain('Traceback')
    expect(result.err).toContain('ImportError')
    expect(result.err).toContain('File "scratch.py", line 1')
  })

  it('imports the standard library it does have', () => {
    const source = 'import math, json, random, datetime\nprint(round(math.tau, 3))\n'
    expect(runOnce(source, FILENAME, 'script').out).toBe('6.283\n')
  })
})

describe('ending a run', () => {
  it('reports sys.exit() as an exit, with its code', () => {
    const result = runOnce('import sys\nsys.exit(2)\n', FILENAME, 'script')
    expect(result.status).toBe('exit')
    expect(result.err).toContain('SystemExit: 2')
  })

  it('says nothing extra for a clean sys.exit()', () => {
    const result = runOnce('import sys\nprint("bye")\nsys.exit(0)\n', FILENAME, 'script')
    expect(result.status).toBe('exit')
    expect(result.out).toBe('bye\n')
    expect(result.err).toBe('')
  })

  it('raises EOFError when input() runs out, as a short piped stdin would', () => {
    const result = runOnce('print(input("name? "))\n', FILENAME, 'script')

    expect(result.status).toBe('error')
    // The prompt reached stdout before stdin was read: that is what lets the
    // page show it next to the input field.
    expect(result.out).toBe('name? ')
    expect(result.err).toContain('EOFError')
  })
})
