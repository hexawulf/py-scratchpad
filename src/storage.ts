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
 *  - **v3** — adds `settings.runMode`, the Run button's REPL-echo / Script
 *    choice (v0.3). Older payloads load as v3 with the `repl` default, which
 *    is the mode a user who has never seen the toggle wants.
 *
 * v0.2's multiple files will become **v4** with `files: [...]` plus `active`;
 * `migrate()` below is where that upgrade goes, and v3's `buffer` maps onto
 * the first entry of `files`.
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
import { isRunMode, type RunMode } from './protocol.ts'

export const STORAGE_KEY = 'py-scratchpad:v1'
export const SCHEMA_VERSION = 3

/**
 * Schemas this build can read. A higher number is a newer build's data and is
 * left alone (see `load`); anything else is treated as corrupt.
 */
const READABLE_VERSIONS: readonly number[] = [1, 2, 3]

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

/** The Run button's default mode; `repl` echoes bare expressions (schema v3). */
export const DEFAULT_RUN_MODE: RunMode = 'repl'

export interface Settings {
  theme: ThemeName
  fontSize: number
  /** How Run compiles the buffer (schema v3). */
  runMode: RunMode
}

export interface ScratchpadState {
  version: number
  buffer: BufferState
  settings: Settings
}

/**
 * The slice of the Web Storage API this module needs. The last three are what
 * `localStorage` has and a minimal stand-in may not; without them old backup
 * copies are simply never looked for.
 */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  readonly length?: number
  key?(index: number): string | null
  removeItem?(key: string): void
}

/** How many `:corrupt-<time>` copies are kept; older ones are removed. */
export const MAX_BACKUPS = 5

/** Why a load could not return the user's stored state. */
export type LoadProblem =
  | { kind: 'unavailable'; message: string }
  | { kind: 'corrupt'; backupKey: string | null; message: string }
  /**
   * The stored data was written by a newer build (after a rollback, say). It
   * is still in place under the storage key, untouched, and the caller must
   * not save over it: this build would drop whatever it does not know about.
   */
  | { kind: 'newer'; version: number; message: string }

export interface LoadResult {
  state: ScratchpadState
  /**
   * The exact stored string this state came from, or null when nothing was
   * stored or it could not be read. The multi-tab guard compares `storage`
   * events against it to recognise the value this tab is already showing.
   * Also set for a `newer` problem, where it is what a backup would copy.
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
    settings: { theme, fontSize: DEFAULT_FONT_SIZE, runMode: DEFAULT_RUN_MODE },
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
    runMode: isRunMode(source.runMode) ? source.runMode : DEFAULT_RUN_MODE,
  }
}

/**
 * Turn a parsed v1, v2 or v3 payload into v3 state, repairing anything missing
 * or absurd. Returns null when the payload is not recognisable — the caller
 * then treats it as corrupt and backs the raw string up rather than clobbering
 * it.
 *
 * The older schemas are upgraded by omission: v1 has no `lineEnding` or `bom`
 * and v2 has no `runMode`, so the readers below hand back the defaults and
 * nothing else about the stored state changes.
 */
function migrate(parsed: unknown, defaultTheme: ThemeName): ScratchpadState | null {
  if (!isRecord(parsed)) return null
  if (typeof parsed.version !== 'number' || !READABLE_VERSIONS.includes(parsed.version)) return null
  return readState(parsed, defaultTheme)
}

/** The lenient reader behind `migrate`: every field is repaired or defaulted. */
function readState(parsed: Record<string, unknown>, defaultTheme: ThemeName): ScratchpadState {
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

const BACKUP_PREFIX = `${STORAGE_KEY}:corrupt-`

export function corruptBackupKey(now: Date): string {
  return `${BACKUP_PREFIX}${now.toISOString()}`
}

/** Existing backup keys, oldest first (the timestamp sorts as text). */
function backupKeys(storage: StorageLike): string[] {
  if (typeof storage.length !== 'number' || storage.key === undefined) return []
  const keys: string[] = []
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i)
    if (key?.startsWith(BACKUP_PREFIX) === true) keys.push(key)
  }
  return keys.sort()
}

/**
 * Copy `raw` to a timestamped backup key and return the key, or null when the
 * copy could not be made. Never throws.
 *
 * Two things keep the copies from piling up: a value that is already backed
 * up is not copied again (an unreadable payload is otherwise copied on every
 * page load until something is typed), and only the newest `MAX_BACKUPS` are
 * kept.
 */
export function backupRaw(storage: StorageLike, raw: string, now: Date): string | null {
  try {
    const existing = backupKeys(storage)
    for (const key of existing.toReversed()) {
      if (storage.getItem(key) === raw) return key
    }

    const backupKey = corruptBackupKey(now)
    storage.setItem(backupKey, raw)

    if (storage.removeItem !== undefined) {
      const all = [...existing.filter((key) => key !== backupKey), backupKey].sort()
      for (const key of all.slice(0, Math.max(0, all.length - MAX_BACKUPS))) {
        try {
          storage.removeItem(key)
        } catch {
          // The copy that matters was made; a stale one staying is harmless.
        }
      }
    }
    return backupKey
  } catch {
    return null
  }
}

/** Parse a stored string into state, or null if this build cannot read it. */
export function parseState(raw: string, defaultTheme: ThemeName = 'dark'): ScratchpadState | null {
  try {
    return migrate(JSON.parse(raw), defaultTheme)
  } catch {
    return null
  }
}

/** The schema version of a payload newer than this build, else null. */
function newerVersion(parsed: unknown): number | null {
  if (!isRecord(parsed) || typeof parsed.version !== 'number') return null
  return Number.isFinite(parsed.version) && parsed.version > SCHEMA_VERSION ? parsed.version : null
}

/**
 * Read the stored state. Never throws and never discards user data: an
 * unreadable payload is copied to a timestamped backup key first, and the
 * caller gets a fresh state plus a `problem` to surface.
 *
 * Data from a newer build is the exception to "copied": it is not damaged, so
 * it stays where it is and the problem tells the caller not to save. Whatever
 * of it this build understands (the single buffer, if it still has one) is
 * returned for display.
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

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = undefined
  }

  const migrated = migrate(parsed, defaultTheme)
  if (migrated !== null) return { state: migrated, raw }

  const newer = newerVersion(parsed)
  if (newer !== null && isRecord(parsed)) {
    return {
      state: readState(parsed, defaultTheme),
      raw,
      problem: {
        kind: 'newer',
        version: newer,
        message:
          `This browser holds code saved by a newer py-scratchpad (data version ${String(newer)}; ` +
          `this one reads up to ${String(SCHEMA_VERSION)}). It has been left untouched, and nothing ` +
          'typed here is being saved.',
      },
    }
  }

  // Unparseable, or not a shape this build knows. Preserve the bytes.
  const saved = backupRaw(storage, raw, now())

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
