/**
 * Persistence for py-scratchpad.
 *
 * Everything the user owns lives in one localStorage key as a versioned JSON
 * object. This module never touches the DOM: it takes a `StorageLike` so the
 * tests can hand it a plain object, and it never throws — a caller that cannot
 * persist gets a result it can show in the UI.
 *
 * Schema history:
 *  - **v1** — one buffer: `{name, content, cursor}`.
 *  - **v2** — adds `lineEnding` and `bom` to the buffer, so an imported file
 *    can be exported byte for byte (see `files.ts`). v1 payloads load as v2
 *    with the defaults for both, which is what a buffer typed into the editor
 *    would have had anyway.
 *
 * v0.2 brings multiple files, which becomes **v3** with `files: [...]` plus
 * `active`; `migrate()` below is where that upgrade goes, and v2's `buffer`
 * maps onto the first entry of `files`.
 *
 * The storage *key* is a namespace, not the schema version: it stays
 * `py-scratchpad:v1` so an upgrade finds the user's existing data in place.
 */

import {
  DEFAULT_LINE_ENDING,
  DEFAULT_NAME,
  isLineEnding,
  type LineEnding,
} from './files.ts'

export const STORAGE_KEY = 'py-scratchpad:v1'
export const SCHEMA_VERSION = 2

/** Schemas this build can read. Anything else is treated as corrupt. */
const READABLE_VERSIONS: readonly number[] = [1, 2]

export const DEFAULT_FONT_SIZE = 14
export const FONT_SIZE_MIN = 10
export const FONT_SIZE_MAX = 28

export type ThemeName = 'dark' | 'light'

/** A CodeMirror selection range, flattened to two document offsets. */
export interface CursorState {
  anchor: number
  head: number
}

export interface BufferState {
  name: string
  content: string
  cursor: CursorState
  /** The line ending of the file this buffer came from (schema v2). */
  lineEnding: LineEnding
  /** Whether that file started with a UTF-8 BOM (schema v2). */
  bom: boolean
}

export interface Settings {
  theme: ThemeName
  fontSize: number
}

export interface ScratchpadState {
  version: number
  buffer: BufferState
  settings: Settings
}

/** The slice of the Web Storage API this module needs. */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** Why a load could not return the user's stored state. */
export type LoadProblem =
  | { kind: 'unavailable'; message: string }
  | { kind: 'corrupt'; backupKey: string | null; message: string }

export interface LoadResult {
  state: ScratchpadState
  /**
   * The exact stored string this state came from, or null when nothing was
   * stored or it could not be read. The multi-tab guard compares `storage`
   * events against it to recognise the value this tab is already showing.
   */
  raw: string | null
  /** Absent on a clean load (including a first visit with nothing stored). */
  problem?: LoadProblem
}

export type SaveResult =
  /** `raw` is exactly what was written, for the multi-tab guard to compare. */
  { ok: true; raw: string } | { ok: false; message: string }

export interface LoadOptions {
  /** Theme for a first visit; callers pass `prefers-color-scheme`. */
  defaultTheme?: ThemeName
  /** Injectable for tests; defaults to the current time. */
  now?: () => Date
}

export function clampFontSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_FONT_SIZE
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(size)))
}

/** Pull a cursor back inside a document of `length` characters. */
export function clampCursor(cursor: CursorState, length: number): CursorState {
  const clamp = (n: number): number => {
    if (Number.isNaN(n)) return 0
    // Infinity means "past the end", so it lands at the end, not at zero.
    if (!Number.isFinite(n)) return n > 0 ? length : 0
    return Math.min(length, Math.max(0, Math.floor(n)))
  }
  return { anchor: clamp(cursor.anchor), head: clamp(cursor.head) }
}

export function defaultState(theme: ThemeName = 'dark'): ScratchpadState {
  return {
    version: SCHEMA_VERSION,
    buffer: {
      name: DEFAULT_NAME,
      content: '',
      cursor: { anchor: 0, head: 0 },
      lineEnding: DEFAULT_LINE_ENDING,
      bom: false,
    },
    settings: { theme, fontSize: DEFAULT_FONT_SIZE },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readCursor(raw: unknown, length: number): CursorState {
  if (!isRecord(raw)) return { anchor: 0, head: 0 }
  const anchor = typeof raw.anchor === 'number' ? raw.anchor : 0
  const head = typeof raw.head === 'number' ? raw.head : anchor
  return clampCursor({ anchor, head }, length)
}

function readSettings(raw: unknown, defaultTheme: ThemeName): Settings {
  const source = isRecord(raw) ? raw : {}
  return {
    theme: source.theme === 'light' || source.theme === 'dark' ? source.theme : defaultTheme,
    fontSize: typeof source.fontSize === 'number' ? clampFontSize(source.fontSize) : DEFAULT_FONT_SIZE,
  }
}

/**
 * Turn a parsed v1 or v2 payload into v2 state, repairing anything missing or
 * absurd. Returns null when the payload is not recognisable — the caller then
 * treats it as corrupt and backs the raw string up rather than clobbering it.
 *
 * v1 is upgraded by omission: it has no `lineEnding` or `bom`, so the readers
 * below hand back the defaults and nothing else about the buffer changes.
 */
function migrate(parsed: unknown, defaultTheme: ThemeName): ScratchpadState | null {
  if (!isRecord(parsed)) return null
  if (typeof parsed.version !== 'number' || !READABLE_VERSIONS.includes(parsed.version)) return null

  const buffer = isRecord(parsed.buffer) ? parsed.buffer : {}
  const content = typeof buffer.content === 'string' ? buffer.content : ''
  const name = typeof buffer.name === 'string' && buffer.name.length > 0 ? buffer.name : DEFAULT_NAME

  return {
    version: SCHEMA_VERSION,
    buffer: {
      name,
      content,
      cursor: readCursor(buffer.cursor, content.length),
      lineEnding: isLineEnding(buffer.lineEnding) ? buffer.lineEnding : DEFAULT_LINE_ENDING,
      bom: buffer.bom === true,
    },
    settings: readSettings(parsed.settings, defaultTheme),
  }
}

export function corruptBackupKey(now: Date): string {
  return `${STORAGE_KEY}:corrupt-${now.toISOString()}`
}

/**
 * Read the stored state. Never throws and never discards user data: an
 * unreadable payload is copied to a timestamped backup key first, and the
 * caller gets a fresh state plus a `problem` to surface.
 */
export function load(storage: StorageLike, options: LoadOptions = {}): LoadResult {
  const defaultTheme = options.defaultTheme ?? 'dark'
  const now = options.now ?? ((): Date => new Date())

  let raw: string | null
  try {
    raw = storage.getItem(STORAGE_KEY)
  } catch (error) {
    return {
      state: defaultState(defaultTheme),
      raw: null,
      problem: { kind: 'unavailable', message: describe(error) },
    }
  }

  if (raw === null) return { state: defaultState(defaultTheme), raw: null }

  let migrated: ScratchpadState | null
  try {
    migrated = migrate(JSON.parse(raw), defaultTheme)
  } catch {
    migrated = null
  }
  if (migrated !== null) return { state: migrated, raw }

  // Unparseable, or a schema this build does not know. Preserve the bytes.
  const backupKey = corruptBackupKey(now())
  let saved: string | null = backupKey
  try {
    storage.setItem(backupKey, raw)
  } catch {
    saved = null
  }

  return {
    state: defaultState(defaultTheme),
    raw: null,
    problem: {
      kind: 'corrupt',
      backupKey: saved,
      message:
        saved === null
          ? 'Saved data could not be read, and the backup copy failed. Starting fresh.'
          : `Saved data could not be read. The old value was kept as ${saved}.`,
    },
  }
}

/** Write state. Reports quota/private-mode failures instead of throwing. */
export function save(storage: StorageLike, state: ScratchpadState): SaveResult {
  const raw = JSON.stringify(state)
  try {
    storage.setItem(STORAGE_KEY, raw)
    return { ok: true, raw }
  } catch (error) {
    return { ok: false, message: describe(error) }
  }
}

function describe(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  return String(error)
}
