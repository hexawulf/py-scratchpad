/**
 * The notice bar's content, kept away from the DOM so it can be checked.
 *
 * The bar can offer the user a choice (Reload / Keep mine), and the buttons
 * only make sense next to the sentence that asks the question. It shipped once
 * showing the two buttons and nothing else — see the `[hidden]` note in
 * style.css for why — so the message and the actions now travel together in
 * one value instead of as two arguments that can drift apart.
 */

export type NoticeTone = 'info' | 'error'

export interface NoticeState {
  /** What the bar says. Never empty; `hasBareActions` is the guard. */
  message: string
  tone: NoticeTone
  /** Whether the Reload / Keep mine buttons are shown alongside the message. */
  actions: boolean
}

/** Another tab wrote the storage key, so autosave here is paused. */
export const CONFLICT_NOTICE: NoticeState = {
  message: 'Changed in another tab — autosave is paused here.',
  tone: 'error',
  actions: true,
}

/** The user chose Reload, and the other tab's version is now loaded. */
export const RELOADED_NOTICE: NoticeState = {
  message: 'Reloaded the version from the other tab.',
  tone: 'info',
  actions: false,
}

/**
 * True when a state would put buttons on screen with nothing to explain them.
 * That is the regression this module exists to make visible.
 */
export function hasBareActions(state: NoticeState): boolean {
  return state.actions && state.message.trim() === ''
}
