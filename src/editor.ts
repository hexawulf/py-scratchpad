/**
 * CodeMirror 6 setup for the single scratch buffer.
 *
 * Theme and font size are swapped through compartments, so a toggle is a
 * reconfigure rather than a rebuilt editor — the document, undo history and
 * selection all survive.
 */

import { basicSetup } from 'codemirror'
import { Compartment, EditorSelection, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { indentWithTab } from '@codemirror/commands'
import { indentUnit } from '@codemirror/language'
import { python } from '@codemirror/lang-python'
import { oneDark } from '@codemirror/theme-one-dark'

import { clampCursor, type CursorState, type ThemeName } from './storage.ts'

/** Four spaces, never a tab character: PEP 8, and the course's convention. */
const PYTHON_INDENT = '    '

const themeCompartment = new Compartment()
const fontSizeCompartment = new Compartment()

/** `basicSetup` already carries the default highlight style, so light is bare. */
function themeExtension(theme: ThemeName): Extension {
  return theme === 'dark' ? oneDark : []
}

function fontSizeExtension(px: number): Extension {
  return EditorView.theme({
    '&': { fontSize: `${String(px)}px` },
    // Keep the gutter readable at the same scale as the code.
    '.cm-gutters': { fontSize: `${String(px)}px` },
  })
}

/**
 * Everything that shapes the document: the basic editor bundle, the Python
 * language, the indent unit and the keymaps. Exported so tests can build an
 * `EditorState` with the real configuration and no DOM. Theme and font size
 * are deliberately not here — they are cosmetic and live in compartments.
 */
export function baseExtensions(): Extension[] {
  return [
    // Line numbers, bracket matching, undo history, Ctrl+F search panel and
    // the default keymap (which carries Ctrl+/ comment toggling).
    basicSetup,
    python(),
    indentUnit.of(PYTHON_INDENT),
    // Tab indents by one indent unit, i.e. four spaces. Shift-Tab outdents.
    keymap.of([indentWithTab]),
    EditorView.lineWrapping,
  ]
}

export interface EditorOptions {
  parent: HTMLElement
  content: string
  cursor: CursorState
  theme: ThemeName
  fontSize: number
  /** Fired on every document or selection change; debounce in the caller. */
  onChange: () => void
}

export interface EditorHandle {
  view: EditorView
  getContent: () => string
  getCursor: () => CursorState
  setTheme: (theme: ThemeName) => void
  setFontSize: (px: number) => void
  focus: () => void
}

export function createEditor(options: EditorOptions): EditorHandle {
  const cursor = clampCursor(options.cursor, options.content.length)

  const view = new EditorView({
    parent: options.parent,
    doc: options.content,
    selection: EditorSelection.single(cursor.anchor, cursor.head),
    extensions: [
      baseExtensions(),
      themeCompartment.of(themeExtension(options.theme)),
      fontSizeCompartment.of(fontSizeExtension(options.fontSize)),
      EditorView.updateListener.of((update) => {
        if (update.docChanged || update.selectionSet) options.onChange()
      }),
    ],
  })

  return {
    view,
    getContent: () => view.state.doc.toString(),
    getCursor: () => {
      const range = view.state.selection.main
      return { anchor: range.anchor, head: range.head }
    },
    setTheme: (theme) => {
      view.dispatch({ effects: themeCompartment.reconfigure(themeExtension(theme)) })
    },
    setFontSize: (px) => {
      view.dispatch({ effects: fontSizeCompartment.reconfigure(fontSizeExtension(px)) })
    },
    focus: () => {
      view.focus()
    },
  }
}
