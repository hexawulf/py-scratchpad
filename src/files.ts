/**
 * Import and export for the single buffer.
 *
 * The contract is byte-exactness: the bytes written by `encodeFile` for a
 * document that came out of `decodeFile` must equal the bytes that went in.
 * Two things stand in the way, and both are handled here rather than in the UI:
 *
 *  - **Line endings.** CodeMirror stores one line per entry and joins with
 *    `\n`, so a CRLF file is already LF by the time it reaches the document.
 *    The original ending is therefore detected on the raw text, carried beside
 *    the buffer, and written back on export.
 *  - **The UTF-8 BOM.** `TextDecoder` drops a leading BOM unless asked not to,
 *    and it is not part of the text either way. It is detected from the bytes,
 *    carried as a flag, and re-emitted on export.
 *
 * Tabs, spaces and a missing trailing newline need no special handling — but
 * they are easy to break, so `tests/roundtrip.test.ts` pins them down.
 *
 * Everything here is pure: bytes and strings in, bytes and strings out, no DOM
 * and no storage.
 */

/** The line endings worth preserving. Lone `\r` is Mac OS 9 and still exists. */
export type LineEnding = '\n' | '\r\n' | '\r'

export const DEFAULT_LINE_ENDING: LineEnding = '\n'

/** The name a fresh buffer gets, and the fallback for an unusable one. */
export const DEFAULT_NAME = 'scratch.py'

/** U+FEFF as UTF-8. */
const UTF8_BOM_BYTES = [0xef, 0xbb, 0xbf] as const
const BOM_CHAR = '\ufeff'

/** Long enough for any real filename, short of the 255-byte limit on ext4. */
const MAX_NAME_LENGTH = 120

/** What has to travel with the text to reproduce the original file. */
export interface FileMeta {
  lineEnding: LineEnding
  bom: boolean
}

export interface DecodedFile extends FileMeta {
  /** Normalised to `\n`, BOM removed: exactly what the document should hold. */
  content: string
}

export type DecodeResult = { ok: true; file: DecodedFile } | { ok: false; message: string }

export function isLineEnding(value: unknown): value is LineEnding {
  return value === '\n' || value === '\r\n' || value === '\r'
}

/**
 * Make a user-supplied or file-supplied name safe to put in `<a download>`.
 * Path separators and control characters go; the rest is the user's business,
 * including the extension — a buffer may legitimately be `notes.txt`.
 */
export function sanitizeFilename(raw: string): string {
  const cleaned = raw
    // eslint-disable-next-line no-control-regex -- stripping control chars is the point
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\]/g, '')
    .trim()
    .slice(0, MAX_NAME_LENGTH)
    .trim()

  // `.` and `..` survive the filter above but are not filenames.
  if (cleaned.length === 0 || cleaned === '.' || cleaned === '..') return DEFAULT_NAME
  return cleaned
}

export function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && UTF8_BOM_BYTES.every((byte, index) => bytes[index] === byte)
}

function countMatches(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length
}

/**
 * The dominant line ending of `text`, which is still in its original form.
 * A file with no line break at all counts as `\n`, and a genuinely mixed file
 * cannot round-trip whatever we pick — the majority ending loses the least.
 */
export function detectLineEnding(text: string): LineEnding {
  const crlf = countMatches(text, /\r\n/g)
  const cr = countMatches(text, /\r(?!\n)/g)
  if (crlf === 0 && cr === 0) return '\n'

  const lf = countMatches(text, /(?<!\r)\n/g)
  if (crlf >= cr && crlf >= lf) return '\r\n'
  if (cr >= lf) return '\r'
  return '\n'
}

/** Collapse every flavour of line ending to `\n`, as CodeMirror would. */
export function toLf(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/**
 * Decode file bytes as UTF-8. `fatal: true` means a latin-1 or UTF-16 file is
 * rejected outright instead of arriving as replacement characters that would
 * then be written back as different bytes.
 */
export function decodeFile(bytes: Uint8Array): DecodeResult {
  const bom = hasUtf8Bom(bytes)

  let text: string
  try {
    // ignoreBOM keeps the U+FEFF in the string so the stripping stays explicit.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return {
      ok: false,
      message: 'That file is not valid UTF-8 text, so it was not opened.',
    }
  }

  const body = bom ? text.slice(BOM_CHAR.length) : text
  return { ok: true, file: { content: toLf(body), lineEnding: detectLineEnding(body), bom } }
}

/**
 * Turn a document back into the bytes of a file, undoing `decodeFile`.
 *
 * The `ArrayBuffer` type argument is not decoration: `BlobPart` rejects a view
 * that might sit on a `SharedArrayBuffer`, so without it the download path
 * does not typecheck.
 */
export function encodeFile(content: string, meta: FileMeta): Uint8Array<ArrayBuffer> {
  const lf = toLf(content)
  const body = meta.lineEnding === '\n' ? lf : lf.replace(/\n/g, meta.lineEnding)
  return new TextEncoder().encode(meta.bom ? BOM_CHAR + body : body)
}

/**
 * Opening a file replaces the buffer, so it needs a confirm — unless there is
 * nothing to lose. Whitespace-only counts as nothing; identical content means
 * the user would not notice the difference anyway.
 */
export function needsOpenConfirm(current: string, incoming: string): boolean {
  if (current.trim().length === 0) return false
  return current !== incoming
}
