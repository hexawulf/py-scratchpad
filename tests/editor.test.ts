import { describe, expect, it } from 'vitest'

import { EditorSelection, EditorState } from '@codemirror/state'

import { baseExtensions } from '../src/editor.ts'
import { load, save, SCHEMA_VERSION, type ScratchpadState, type StorageLike } from '../src/storage.ts'

/**
 * Pasted Python, indented with a real tab character. Nothing in the editor
 * configuration or the storage layer may rewrite that tab into spaces: the
 * four-space indent unit applies to the Tab *key*, not to text the user
 * already has. Step 3 round-trips files on disk, so this has to hold byte for
 * byte.
 */
const TAB_INDENTED = 'def f():\n\treturn 1\n'

function memoryStorage(): StorageLike & { items: Map<string, string> } {
  const items = new Map<string, string>()
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
  }
}

describe('editor configuration', () => {
  it('builds a state from the real extension list', () => {
    const state = EditorState.create({ doc: '', extensions: baseExtensions() })

    expect(state.doc.length).toBe(0)
  })

  it('keeps a pasted tab as a tab', () => {
    const state = EditorState.create({ doc: '', extensions: baseExtensions() })

    const next = state.update({
      changes: { from: 0, insert: TAB_INDENTED },
      selection: EditorSelection.cursor(TAB_INDENTED.length),
    }).state

    const text = next.doc.toString()
    expect(text).toContain('\treturn')
    expect(text).toBe(TAB_INDENTED)
    expect(text).not.toContain('    return')
    expect(next.doc.lines).toBe(3)
  })

  it('keeps a tab that is pasted into existing code', () => {
    const state = EditorState.create({ doc: 'def f():\n', extensions: baseExtensions() })

    const next = state.update({ changes: { from: 9, insert: '\treturn 1\n' } }).state

    expect(next.doc.toString()).toBe(TAB_INDENTED)
  })
})

describe('editor and storage together', () => {
  it('round-trips tab-indented code through localStorage unchanged', () => {
    const storage = memoryStorage()
    const state = EditorState.create({ doc: TAB_INDENTED, extensions: baseExtensions() })
    const range = state.selection.main

    const stored: ScratchpadState = {
      version: SCHEMA_VERSION,
      buffer: {
        name: 'scratch.py',
        content: state.doc.toString(),
        cursor: { anchor: range.anchor, head: range.head },
        lineEnding: '\n',
        bom: false,
      },
      settings: { theme: 'dark', fontSize: 14, runMode: 'repl' },
    }

    expect(save(storage, stored).ok).toBe(true)
    const restored = load(storage)

    expect(restored.problem).toBeUndefined()
    expect(restored.state.buffer.content).toBe(TAB_INDENTED)
    expect(restored.state.buffer.content).toContain('\treturn')

    // And the restored content reloads into an identical document.
    const reopened = EditorState.create({
      doc: restored.state.buffer.content,
      extensions: baseExtensions(),
    })
    expect(reopened.doc.toString()).toBe(TAB_INDENTED)
  })
})
