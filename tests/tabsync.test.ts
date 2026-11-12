import { describe, expect, it } from 'vitest'

import { STORAGE_KEY } from '../src/storage.ts'
import {
  decideOnExternalWrite,
  sameDocument,
  shouldWarnBeforeUnload,
  type SyncInputs,
} from '../src/tabsync.ts'

const OURS = '{"version":2,"buffer":{"content":"ours"}}'
const THEIRS = '{"version":2,"buffer":{"content":"theirs"}}'

function decide(overrides: Partial<SyncInputs> = {}) {
  const inputs: SyncInputs = {
    event: { key: STORAGE_KEY, newValue: THEIRS },
    storageKey: STORAGE_KEY,
    lastWritten: OURS,
    paused: false,
    ...overrides,
  }
  return decideOnExternalWrite(inputs)
}

describe('decideOnExternalWrite', () => {
  it('pauses when another tab writes a different value to our key', () => {
    expect(decide()).toEqual({ kind: 'pause' })
  })

  it('pauses on the first write even if this tab has never saved', () => {
    expect(decide({ lastWritten: null })).toEqual({ kind: 'pause' })
  })

  it('ignores another key, such as the corrupt-payload backup', () => {
    expect(decide({ event: { key: `${STORAGE_KEY}:corrupt-2026-10-09`, newValue: THEIRS } })).toEqual({
      kind: 'ignore',
      reason: 'other-key',
    })
    expect(decide({ event: { key: 'unrelated-app', newValue: THEIRS } })).toEqual({
      kind: 'ignore',
      reason: 'other-key',
    })
  })

  it('ignores a whole-storage clear, which arrives with a null key', () => {
    expect(decide({ event: { key: null, newValue: null } })).toEqual({
      kind: 'ignore',
      reason: 'cleared',
    })
  })

  it('ignores removal of our key: the next autosave restores it', () => {
    expect(decide({ event: { key: STORAGE_KEY, newValue: null } })).toEqual({
      kind: 'ignore',
      reason: 'cleared',
    })
  })

  it('ignores a value byte-identical to what this tab wrote', () => {
    expect(decide({ event: { key: STORAGE_KEY, newValue: OURS } })).toEqual({
      kind: 'ignore',
      reason: 'our-own-write',
    })
  })

  it('does not treat a null lastWritten as matching a null-ish value', () => {
    expect(decide({ lastWritten: null, event: { key: STORAGE_KEY, newValue: '' } })).toEqual({
      kind: 'pause',
    })
  })

  it('does not re-prompt while already paused', () => {
    expect(decide({ paused: true })).toEqual({ kind: 'ignore', reason: 'already-paused' })
  })

  it('still ignores an unrelated key while paused', () => {
    expect(decide({ paused: true, event: { key: 'other', newValue: THEIRS } })).toEqual({
      kind: 'ignore',
      reason: 'other-key',
    })
  })

  it('pauses again after the user resumed and the other tab wrote once more', () => {
    // Keep mine: this tab saved its own value, so lastWritten is now ours.
    const resumed = decide({ paused: false, lastWritten: OURS })
    expect(resumed).toEqual({ kind: 'pause' })
  })
})

describe('shouldWarnBeforeUnload', () => {
  it('warns only while autosave is paused and the buffer is dirty', () => {
    expect(shouldWarnBeforeUnload({ paused: true, dirty: true })).toBe(true)
  })

  it('stays quiet while autosave is running, dirty or not', () => {
    // pagehide flushes in this state, so nothing is lost and a prompt is noise.
    expect(shouldWarnBeforeUnload({ paused: false, dirty: true })).toBe(false)
    expect(shouldWarnBeforeUnload({ paused: false, dirty: false })).toBe(false)
  })

  it('stays quiet while paused with nothing unsaved', () => {
    expect(shouldWarnBeforeUnload({ paused: true, dirty: false })).toBe(false)
  })

  it('follows the pause and the resume in order', () => {
    // Another tab writes while this one has an uncommitted keystroke...
    expect(shouldWarnBeforeUnload({ paused: true, dirty: true })).toBe(true)
    // ...the user picks Keep mine, which saves and clears both flags.
    expect(shouldWarnBeforeUnload({ paused: false, dirty: false })).toBe(false)
  })
})

/** A full payload as autosave writes it, with the parts under test variable. */
function payload(overrides: {
  content?: string
  name?: string
  lineEnding?: string
  bom?: boolean
  cursor?: { anchor: number; head: number }
  theme?: string
  fontSize?: number
  runMode?: string
}): string {
  return JSON.stringify({
    version: 3,
    buffer: {
      name: overrides.name ?? 'scratch.py',
      content: overrides.content ?? 'print("hi")\n',
      cursor: overrides.cursor ?? { anchor: 0, head: 0 },
      lineEnding: overrides.lineEnding ?? '\n',
      bom: overrides.bom ?? false,
    },
    settings: {
      theme: overrides.theme ?? 'dark',
      fontSize: overrides.fontSize ?? 14,
      runMode: overrides.runMode ?? 'repl',
    },
  })
}

describe('writes that do not change the code', () => {
  const mine = payload({})

  it.each([
    ['a caret move', payload({ cursor: { anchor: 5, head: 5 } })],
    ['a selection', payload({ cursor: { anchor: 0, head: 11 } })],
    ['a theme toggle', payload({ theme: 'light' })],
    ['a font size change', payload({ fontSize: 18 })],
    ['a run mode change', payload({ runMode: 'script' })],
  ])('does not pause for %s in the other tab', (_what, theirs) => {
    expect(decide({ lastWritten: mine, event: { key: STORAGE_KEY, newValue: theirs } })).toEqual({
      kind: 'ignore',
      reason: 'same-document',
    })
  })

  it.each([
    ['an edit', payload({ content: 'print("bye")\n' })],
    ['a rename', payload({ name: 'other.py' })],
    ['a different line ending', payload({ lineEnding: '\r\n' })],
    ['a byte-order mark', payload({ bom: true })],
  ])('still pauses for %s in the other tab', (_what, theirs) => {
    expect(decide({ lastWritten: mine, event: { key: STORAGE_KEY, newValue: theirs } })).toEqual({
      kind: 'pause',
    })
  })

  it('pauses when either side cannot be read as a document', () => {
    expect(sameDocument('not json', 'not json')).toBe(false)
    expect(sameDocument(mine, '{"version":4,"files":[]}')).toBe(false)
    expect(sameDocument('{"buffer":{"content":5}}', '{"buffer":{"content":5}}')).toBe(false)
    expect(decide({ lastWritten: mine, event: { key: STORAGE_KEY, newValue: 'not json' } })).toEqual({
      kind: 'pause',
    })
  })

  it('reports the same code as the same document whatever else differs', () => {
    expect(sameDocument(mine, payload({ theme: 'light', cursor: { anchor: 3, head: 9 } }))).toBe(true)
    expect(sameDocument(mine, payload({ content: '' }))).toBe(false)
  })
})
