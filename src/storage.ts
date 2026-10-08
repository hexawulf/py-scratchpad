/**
 * Persistence for py-scratchpad.
 *
 * Everything the user owns lives in one localStorage key as a versioned JSON
 * object. This module never touches the DOM: it takes a `StorageLike` so the
 * tests can hand it a plain object, and it never throws — a caller that cannot
 * persist gets a result it can show in the UI.
 *
 * Schema v1 holds a single buffer. v0.2 adds multiple files, which becomes
 * schema v2 with `files: [...]` plus `active`; `migrate()` below is where that
 * upgrade goes, and v1's `buffer` maps onto the first entry of `files`.
 */

export const STORAGE_KEY = 'py-scratchpad:v1'
export const SCHEMA_VERSION = 1

export const DEFAULT_NAME = 'scratch.py'
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
  /** Absent on a clean load (including a first visit with nothing stored). */
  problem?: LoadProblem
}

export type SaveResult = { ok: true } | { ok: false; message: string }

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
    buffer: { name: DEFAULT_NAME, content: '', cursor: { anchor: 0, head: 0 } },
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
 * Turn a parsed v1 payload into state, repairing anything missing or absurd.
 * Returns null when the payload is not recognisably v1 — the caller then
 * treats it as corrupt and backs the raw string up rather than clobbering it.
 */
function migrate(parsed: unknown, defaultTheme: ThemeName): ScratchpadState | null {
  if (!isRecord(parsed)) return null
  if (parsed.version !== SCHEMA_VERSION) return null

  const buffer = isRecord(parsed.buffer) ? parsed.buffer : {}
  const content = typeof buffer.content === 'string' ? buffer.content : ''
  const name = typeof buffer.name === 'string' && buffer.name.length > 0 ? buffer.name : DEFAULT_NAME

  return {
    version: SCHEMA_VERSION,
    buffer: { name, content, cursor: readCursor(buffer.cursor, content.length) },
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
      problem: { kind: 'unavailable', message: describe(error) },
    }
  }

  if (raw === null) return { state: defaultState(defaultTheme) }

  let migrated: ScratchpadState | null
  try {
    migrated = migrate(JSON.parse(raw), defaultTheme)
  } catch {
    migrated = null
  }
  if (migrated !== null) return { state: migrated }

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
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state))
    return { ok: true }
  } catch (error) {
    return { ok: false, message: describe(error) }
  }
}

function describe(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  return String(error)
}
