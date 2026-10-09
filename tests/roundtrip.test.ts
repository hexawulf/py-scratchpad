/**
 * The §9 step-3 check, automated: opened bytes and downloaded bytes must be
 * identical.
 *
 * The important part is that each fixture travels the *whole* path, including
 * CodeMirror. Testing `decodeFile` against `encodeFile` alone would pass while
 * the app still mangled files, because the normalisation that breaks a round
 * trip (CRLF to LF) happens inside the editor's document, not in files.ts.
 *
 * So each case runs: bytes → decodeFile → EditorState with baseExtensions() →
 * doc.toString() → encodeFile → bytes, and compares with the file on disk.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { EditorSelection, EditorState } from '@codemirror/state'

import { baseExtensions } from '../src/editor.ts'
import { decodeFile, encodeFile, type FileMeta } from '../src/files.ts'
import { load, save, SCHEMA_VERSION, type StorageLike } from '../src/storage.ts'

/** Every fixture, with the metadata the importer is expected to detect. */
const FIXTURES: { name: string; lineEnding: FileMeta['lineEnding']; bom: boolean }[] = [
  { name: 'tabs.py', lineEnding: '\n', bom: false },
  { name: 'spaces.py', lineEnding: '\n', bom: false },
  { name: 'crlf.py', lineEnding: '\r\n', bom: false },
  { name: 'bom.py', lineEnding: '\n', bom: true },
  { name: 'no-trailing-newline.py', lineEnding: '\n', bom: false },
  { name: 'unicode.py', lineEnding: '\n', bom: false },
]

function fixtureBytes(name: string): Uint8Array {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
  return new Uint8Array(readFileSync(path))
}

function memoryStorage(): StorageLike {
  const items = new Map<string, string>()
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
  }
}

/**
 * Import `bytes` the way the app does, hand the text to a real CodeMirror
 * document built from the production extension list, then export it again.
 */
function throughEditor(bytes: Uint8Array): { out: Uint8Array; doc: string; meta: FileMeta } {
  const decoded = decodeFile(bytes)
  if (!decoded.ok) throw new Error(`decode failed: ${decoded.message}`)

  const state = EditorState.create({
    doc: decoded.file.content,
    extensions: baseExtensions(),
  })

  const doc = state.doc.toString()
  const meta: FileMeta = { lineEnding: decoded.file.lineEnding, bom: decoded.file.bom }
  return { out: encodeFile(doc, meta), doc, meta }
}

describe.each(FIXTURES)('round-trip $name', ({ name, lineEnding, bom }) => {
  it('detects the line ending and the BOM', () => {
    const { meta } = throughEditor(fixtureBytes(name))

    expect(meta).toEqual({ lineEnding, bom })
  })

  it('exports byte-for-byte what was imported', () => {
    const original = fixtureBytes(name)

    const { out } = throughEditor(original)

    expect(out).toEqual(original)
  })

  it('still exports byte-for-byte after a trip through localStorage', () => {
    const original = fixtureBytes(name)
    const decoded = decodeFile(original)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return

    const state = EditorState.create({ doc: decoded.file.content, extensions: baseExtensions() })
    const storage = memoryStorage()
    const range = state.selection.main

    expect(
      save(storage, {
        version: SCHEMA_VERSION,
        buffer: {
          name,
          content: state.doc.toString(),
          cursor: { anchor: range.anchor, head: range.head },
          lineEnding: decoded.file.lineEnding,
          bom: decoded.file.bom,
        },
        settings: { theme: 'dark', fontSize: 14, runMode: 'repl' },
      }).ok,
    ).toBe(true)

    const restored = load(storage).state.buffer
    const reopened = EditorState.create({ doc: restored.content, extensions: baseExtensions() })

    expect(encodeFile(reopened.doc.toString(), restored)).toEqual(original)
  })
})

describe('round-trip details the fixtures pin down', () => {
  it('keeps tabs as tabs and never expands them to spaces', () => {
    const { doc } = throughEditor(fixtureBytes('tabs.py'))

    expect(doc).toContain('\n\t\treturn "negative"')
    expect(doc).not.toContain('    return "negative"')
  })

  it('normalises CRLF inside the document but not in the exported file', () => {
    const original = fixtureBytes('crlf.py')
    const { doc, out } = throughEditor(original)

    expect(doc).not.toContain('\r')
    expect(new TextDecoder().decode(out)).toContain('\r\n')
    expect(out).toEqual(original)
  })

  it('keeps the BOM out of the document and back into the file', () => {
    const original = fixtureBytes('bom.py')
    const { doc, out } = throughEditor(original)

    expect(doc.startsWith('\ufeff')).toBe(false)
    expect(Array.from(out.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf])
    expect(out).toEqual(original)
  })

  it('does not add a trailing newline to a file that lacks one', () => {
    const original = fixtureBytes('no-trailing-newline.py')
    const { doc, out } = throughEditor(original)

    expect(doc.endsWith('\n')).toBe(false)
    expect(out).toEqual(original)
  })

  it('preserves astral-plane and combining characters', () => {
    const original = fixtureBytes('unicode.py')
    const { doc, out } = throughEditor(original)

    expect(doc).toContain('🐍')
    expect(doc).toContain('e\u0301')
    expect(out).toEqual(original)
  })

  it('round-trips a file that is BOM, CRLF and unterminated at once', () => {
    const original = new TextEncoder().encode('\ufeff# win\r\nx = 1\r\nprint(x)')

    const { out, meta } = throughEditor(original)

    expect(meta).toEqual({ lineEnding: '\r\n', bom: true })
    expect(out).toEqual(original)
  })

  it('round-trips an edit, keeping the original ending and BOM', () => {
    const original = new TextEncoder().encode('\ufeffa = 1\r\n')
    const decoded = decodeFile(original)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return

    const state = EditorState.create({ doc: decoded.file.content, extensions: baseExtensions() })
    const edited = state.update({
      changes: { from: state.doc.length, insert: 'b = 2\n' },
      selection: EditorSelection.cursor(state.doc.length),
    }).state

    const out = encodeFile(edited.doc.toString(), decoded.file)

    // ignoreBOM, or the decoder swallows the very byte under test.
    expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(out)).toBe(
      '\ufeffa = 1\r\nb = 2\r\n',
    )
  })
})
