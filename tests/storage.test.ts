import { describe, expect, it } from 'vitest'

import {
  clampCursor,
  clampFontSize,
  DEFAULT_FONT_SIZE,
  DEFAULT_NAME,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  load,
  save,
  SCHEMA_VERSION,
  STORAGE_KEY,
  type ScratchpadState,
  type StorageLike,
} from '../src/storage.ts'

/** A `StorageLike` backed by a Map, with optional failure injection. */
class MemoryStorage implements StorageLike {
  readonly items = new Map<string, string>()
  getThrows: Error | null = null
  setThrows: Error | null = null

  getItem(key: string): string | null {
    if (this.getThrows !== null) throw this.getThrows
    return this.items.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    if (this.setThrows !== null) throw this.setThrows
    this.items.set(key, value)
  }
}

const FIXED_NOW = (): Date => new Date('2026-10-09T12:34:56.000Z')
const EXPECTED_BACKUP_KEY = `${STORAGE_KEY}:corrupt-2026-10-09T12:34:56.000Z`

function stateWith(content: string, anchor = 0, head = anchor): ScratchpadState {
  return {
    version: SCHEMA_VERSION,
    buffer: { name: DEFAULT_NAME, content, cursor: { anchor, head } },
    settings: { theme: 'dark', fontSize: DEFAULT_FONT_SIZE },
  }
}

describe('load defaults', () => {
  it('returns a usable empty state when nothing is stored', () => {
    const storage = new MemoryStorage()

    const { state, problem } = load(storage)

    expect(problem).toBeUndefined()
    expect(state).toEqual({
      version: SCHEMA_VERSION,
      buffer: { name: DEFAULT_NAME, content: '', cursor: { anchor: 0, head: 0 } },
      settings: { theme: 'dark', fontSize: DEFAULT_FONT_SIZE },
    })
  })

  it('uses the caller default theme only on a first visit', () => {
    const storage = new MemoryStorage()
    expect(load(storage, { defaultTheme: 'light' }).state.settings.theme).toBe('light')

    save(storage, { ...stateWith(''), settings: { theme: 'dark', fontSize: 18 } })
    expect(load(storage, { defaultTheme: 'light' }).state.settings.theme).toBe('dark')
  })

  it('does not write anything while loading an empty store', () => {
    const storage = new MemoryStorage()

    load(storage)

    expect(storage.items.size).toBe(0)
  })

  it('reports a getItem failure instead of throwing', () => {
    const storage = new MemoryStorage()
    storage.getThrows = new Error('access denied')

    const { state, problem } = load(storage)

    expect(problem).toEqual({ kind: 'unavailable', message: 'access denied' })
    expect(state.buffer.content).toBe('')
  })
})

describe('save and load round-trip', () => {
  it('preserves tabs, trailing newlines and unicode exactly', () => {
    const storage = new MemoryStorage()
    const content = 'def f():\n\treturn "héllo — 日本語 🐍"\n\n# tail\n'
    const original = stateWith(content, 12, 30)
    original.settings = { theme: 'light', fontSize: 22 }
    original.buffer.name = 'notes.py'

    expect(save(storage, original)).toEqual({ ok: true })
    const { state, problem } = load(storage)

    expect(problem).toBeUndefined()
    expect(state).toEqual(original)
    expect(state.buffer.content).toBe(content)
  })

  it('restores the selection, not just the caret', () => {
    const storage = new MemoryStorage()
    save(storage, stateWith('abcdefghij', 2, 7))

    expect(load(storage).state.buffer.cursor).toEqual({ anchor: 2, head: 7 })
  })

  it('falls back to defaults for missing fields without discarding the content', () => {
    const storage = new MemoryStorage()
    storage.items.set(
      STORAGE_KEY,
      JSON.stringify({ version: SCHEMA_VERSION, buffer: { content: 'x = 1\n' } }),
    )

    const { state, problem } = load(storage)

    expect(problem).toBeUndefined()
    expect(state.buffer).toEqual({
      name: DEFAULT_NAME,
      content: 'x = 1\n',
      cursor: { anchor: 0, head: 0 },
    })
    expect(state.settings).toEqual({ theme: 'dark', fontSize: DEFAULT_FONT_SIZE })
  })
})

describe('cursor clamping', () => {
  it('pulls a stored cursor back inside a shorter document', () => {
    const storage = new MemoryStorage()
    storage.items.set(
      STORAGE_KEY,
      JSON.stringify({
        version: SCHEMA_VERSION,
        buffer: { name: DEFAULT_NAME, content: 'abc', cursor: { anchor: 999, head: 1000 } },
        settings: { theme: 'dark', fontSize: DEFAULT_FONT_SIZE },
      }),
    )

    expect(load(storage).state.buffer.cursor).toEqual({ anchor: 3, head: 3 })
  })

  it('clamps negative and non-finite offsets to zero', () => {
    expect(clampCursor({ anchor: -5, head: -1 }, 10)).toEqual({ anchor: 0, head: 0 })
    expect(clampCursor({ anchor: Number.NaN, head: Number.POSITIVE_INFINITY }, 10)).toEqual({
      anchor: 0,
      head: 10,
    })
  })

  it('clamps the font size into range', () => {
    expect(clampFontSize(2)).toBe(FONT_SIZE_MIN)
    expect(clampFontSize(999)).toBe(FONT_SIZE_MAX)
    expect(clampFontSize(Number.NaN)).toBe(DEFAULT_FONT_SIZE)
    expect(clampFontSize(15.4)).toBe(15)
  })
})

describe('corrupt or unknown payloads', () => {
  it('backs up unparseable JSON and leaves the original key untouched', () => {
    const storage = new MemoryStorage()
    const raw = '{"version":1,"buffer":{"content":"precious'
    storage.items.set(STORAGE_KEY, raw)

    const { state, problem } = load(storage, { now: FIXED_NOW })

    expect(problem).toEqual({
      kind: 'corrupt',
      backupKey: EXPECTED_BACKUP_KEY,
      message: `Saved data could not be read. The old value was kept as ${EXPECTED_BACKUP_KEY}.`,
    })
    expect(storage.items.get(EXPECTED_BACKUP_KEY)).toBe(raw)
    expect(storage.items.get(STORAGE_KEY)).toBe(raw)
    expect(state.buffer.content).toBe('')
  })

  it('treats an unknown schema version as corrupt rather than guessing', () => {
    const storage = new MemoryStorage()
    const raw = JSON.stringify({ version: 2, files: [{ name: 'a.py', content: 'later' }] })
    storage.items.set(STORAGE_KEY, raw)

    const { problem } = load(storage, { now: FIXED_NOW })

    expect(problem?.kind).toBe('corrupt')
    expect(storage.items.get(EXPECTED_BACKUP_KEY)).toBe(raw)
  })

  it('treats valid JSON of the wrong shape as corrupt', () => {
    const storage = new MemoryStorage()
    storage.items.set(STORAGE_KEY, '"just a string"')

    expect(load(storage, { now: FIXED_NOW }).problem?.kind).toBe('corrupt')
  })

  it('still starts fresh when even the backup write fails', () => {
    const storage = new MemoryStorage()
    storage.items.set(STORAGE_KEY, 'not json')
    storage.setThrows = new DOMException('quota', 'QuotaExceededError')

    const { state, problem } = load(storage, { now: FIXED_NOW })

    expect(problem).toEqual({
      kind: 'corrupt',
      backupKey: null,
      message: 'Saved data could not be read, and the backup copy failed. Starting fresh.',
    })
    expect(state.buffer.content).toBe('')
  })
})

describe('save failures', () => {
  it('reports a throwing setItem instead of propagating it', () => {
    const storage = new MemoryStorage()
    storage.setThrows = new DOMException('The quota has been exceeded.', 'QuotaExceededError')

    const result = save(storage, stateWith('x = 1\n'))

    expect(result).toEqual({ ok: false, message: 'The quota has been exceeded.' })
    expect(storage.items.size).toBe(0)
  })

  it('describes a thrown non-Error value', () => {
    const storage = new MemoryStorage()
    storage.setThrows = 'nope' as unknown as Error

    expect(save(storage, stateWith(''))).toEqual({ ok: false, message: 'nope' })
  })
})
