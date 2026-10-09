import { describe, expect, it } from 'vitest'

import {
  decodeFile,
  DEFAULT_NAME,
  detectLineEnding,
  encodeFile,
  hasUtf8Bom,
  isLineEnding,
  needsOpenConfirm,
  sanitizeFilename,
  toLf,
} from '../src/files.ts'

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)

describe('sanitizeFilename', () => {
  it('keeps an ordinary name untouched', () => {
    expect(sanitizeFilename('lesson_03.py')).toBe('lesson_03.py')
    expect(sanitizeFilename('notes.txt')).toBe('notes.txt')
    expect(sanitizeFilename('no extension')).toBe('no extension')
  })

  it('strips path separators so the name cannot escape the download folder', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('....etcpasswd')
    expect(sanitizeFilename('C:\\Windows\\evil.py')).toBe('C:Windowsevil.py')
    expect(sanitizeFilename('/absolute.py')).toBe('absolute.py')
  })

  it('strips control characters, including a newline or a NUL', () => {
    expect(sanitizeFilename('a\u0000b\nc.py')).toBe('abc.py')
    expect(sanitizeFilename('tab\there.py')).toBe('tabhere.py')
    expect(sanitizeFilename('del\u007f.py')).toBe('del.py')
  })

  it('falls back to the default for anything unusable', () => {
    expect(sanitizeFilename('')).toBe(DEFAULT_NAME)
    expect(sanitizeFilename('   ')).toBe(DEFAULT_NAME)
    expect(sanitizeFilename('///')).toBe(DEFAULT_NAME)
    expect(sanitizeFilename('.')).toBe(DEFAULT_NAME)
    expect(sanitizeFilename('..')).toBe(DEFAULT_NAME)
    expect(sanitizeFilename('\u0001\u0002')).toBe(DEFAULT_NAME)
  })

  it('trims surrounding whitespace and caps absurd lengths', () => {
    expect(sanitizeFilename('  spaced.py  ')).toBe('spaced.py')
    expect(sanitizeFilename(`${'x'.repeat(400)}.py`)).toHaveLength(120)
  })
})

describe('detectLineEnding', () => {
  it('reports LF for a Unix file and for a file with no break at all', () => {
    expect(detectLineEnding('a\nb\n')).toBe('\n')
    expect(detectLineEnding('single line')).toBe('\n')
    expect(detectLineEnding('')).toBe('\n')
  })

  it('reports CRLF for a Windows file', () => {
    expect(detectLineEnding('a\r\nb\r\n')).toBe('\r\n')
  })

  it('reports a lone CR for a classic Mac file', () => {
    expect(detectLineEnding('a\rb\r')).toBe('\r')
  })

  it('picks the majority ending in a mixed file', () => {
    expect(detectLineEnding('a\nb\nc\nd\r\n')).toBe('\n')
    expect(detectLineEnding('a\r\nb\r\nc\r\nd\n')).toBe('\r\n')
  })

  it('accepts only the three real endings as a LineEnding', () => {
    expect(isLineEnding('\n')).toBe(true)
    expect(isLineEnding('\r\n')).toBe(true)
    expect(isLineEnding('\r')).toBe(true)
    expect(isLineEnding('\n\n')).toBe(false)
    expect(isLineEnding(undefined)).toBe(false)
    expect(isLineEnding(1)).toBe(false)
  })
})

describe('toLf', () => {
  it('collapses CRLF and lone CR, and leaves LF alone', () => {
    expect(toLf('a\r\nb\rc\nd')).toBe('a\nb\nc\nd')
  })
})

describe('hasUtf8Bom', () => {
  it('matches only the three BOM bytes at the very start', () => {
    expect(hasUtf8Bom(utf8('\ufeffx'))).toBe(true)
    expect(hasUtf8Bom(utf8('x\ufeff'))).toBe(false)
    expect(hasUtf8Bom(utf8('x'))).toBe(false)
    expect(hasUtf8Bom(new Uint8Array([0xef, 0xbb]))).toBe(false)
    expect(hasUtf8Bom(new Uint8Array())).toBe(false)
  })
})

describe('decodeFile', () => {
  it('returns LF content plus the detected metadata', () => {
    const result = decodeFile(utf8('a\r\nb\r\n'))

    expect(result).toEqual({
      ok: true,
      file: { content: 'a\nb\n', lineEnding: '\r\n', bom: false },
    })
  })

  it('strips the BOM from the content and records it instead', () => {
    const result = decodeFile(utf8('\ufeffx = 1\n'))

    expect(result).toEqual({
      ok: true,
      file: { content: 'x = 1\n', lineEnding: '\n', bom: true },
    })
  })

  it('does not strip a U+FEFF that is not the first character', () => {
    const result = decodeFile(utf8('x = "\ufeff"\n'))

    expect(result.ok && result.file.content).toBe('x = "\ufeff"\n')
    expect(result.ok && result.file.bom).toBe(false)
  })

  it('decodes an empty file as an empty buffer', () => {
    expect(decodeFile(new Uint8Array())).toEqual({
      ok: true,
      file: { content: '', lineEnding: '\n', bom: false },
    })
  })

  it('rejects bytes that are not UTF-8 rather than mangling them', () => {
    // 0xE9 alone is "é" in latin-1 and invalid in UTF-8.
    const latin1 = new Uint8Array([0x78, 0x20, 0x3d, 0x20, 0xe9, 0x0a])

    const result = decodeFile(latin1)

    expect(result.ok).toBe(false)
    expect(!result.ok && result.message).toContain('not valid UTF-8')
  })

  it('rejects UTF-16, which a Windows editor can produce', () => {
    const utf16 = new Uint8Array([0xff, 0xfe, 0x78, 0x00, 0x0a, 0x00])

    expect(decodeFile(utf16).ok).toBe(false)
  })
})

describe('encodeFile', () => {
  it('writes LF content back with the stored ending', () => {
    expect(encodeFile('a\nb\n', { lineEnding: '\r\n', bom: false })).toEqual(utf8('a\r\nb\r\n'))
    expect(encodeFile('a\nb\n', { lineEnding: '\r', bom: false })).toEqual(utf8('a\rb\r'))
    expect(encodeFile('a\nb\n', { lineEnding: '\n', bom: false })).toEqual(utf8('a\nb\n'))
  })

  it('re-adds the BOM only when the flag is set', () => {
    expect(encodeFile('x\n', { lineEnding: '\n', bom: true })).toEqual(utf8('\ufeffx\n'))
    expect(encodeFile('x\n', { lineEnding: '\n', bom: false })).toEqual(utf8('x\n'))
  })

  it('never invents or removes a trailing newline', () => {
    expect(encodeFile('x', { lineEnding: '\n', bom: false })).toEqual(utf8('x'))
    expect(encodeFile('x\n', { lineEnding: '\r\n', bom: false })).toEqual(utf8('x\r\n'))
    expect(encodeFile('', { lineEnding: '\n', bom: false })).toEqual(new Uint8Array())
  })

  it('leaves tabs as tabs', () => {
    expect(encodeFile('def f():\n\treturn 1\n', { lineEnding: '\n', bom: false })).toEqual(
      utf8('def f():\n\treturn 1\n'),
    )
  })

  it('is the inverse of decodeFile for every metadata combination', () => {
    for (const bom of [false, true]) {
      for (const lineEnding of ['\n', '\r\n', '\r'] as const) {
        const original = `${bom ? '\ufeff' : ''}x = 1${lineEnding}\ty = 2`
        const bytes = utf8(original)

        const decoded = decodeFile(bytes)
        expect(decoded.ok).toBe(true)
        if (!decoded.ok) continue

        expect(encodeFile(decoded.file.content, decoded.file)).toEqual(bytes)
      }
    }
  })
})

describe('needsOpenConfirm', () => {
  it('does not ask when there is nothing to lose', () => {
    expect(needsOpenConfirm('', 'x = 1\n')).toBe(false)
    expect(needsOpenConfirm('   \n\t\n', 'x = 1\n')).toBe(false)
  })

  it('does not ask when the incoming file is identical', () => {
    expect(needsOpenConfirm('x = 1\n', 'x = 1\n')).toBe(false)
  })

  it('asks when real content would be replaced', () => {
    expect(needsOpenConfirm('x = 1\n', 'y = 2\n')).toBe(true)
    // Even a whitespace-only difference is a difference worth confirming.
    expect(needsOpenConfirm('x = 1\n', 'x = 1')).toBe(true)
  })
})
