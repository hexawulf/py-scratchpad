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

export interface NoticeLink {
  label: string
  href: string
}

export interface NoticeState {
  /** What the bar says. Never empty; `hasBareActions` is the guard. */
  message: string
  tone: NoticeTone
  /** Whether the Reload / Keep mine buttons are shown alongside the message. */
  actions: boolean
  /** An optional link shown after the message. */
  link?: NoticeLink
  /** Whether a ✕ is offered that hides the bar for the rest of the session. */
  dismissible?: boolean
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

// ---------------------------------------------------------------------------
// The move notice
// ---------------------------------------------------------------------------

/**
 * The original hostname. It still serves the same container and deliberately
 * does **not** redirect: `localStorage` is scoped per origin, so a redirect
 * would hide every file saved here. The notice is the substitute for one.
 */
export const OLD_HOSTNAME = 'python.piapps.dev'

/** Where the public home lives now. */
export const NEW_HOME_URL = 'https://py-scratchpad.com'

/**
 * `sessionStorage`, not `localStorage`: the dismissal is per tab-session, so
 * it needs no schema version and no migration, and the notice comes back the
 * next time the old hostname is opened.
 */
export const MOVE_NOTICE_DISMISSED_KEY = 'py-scratchpad:move-notice-dismissed'

export const MOVE_NOTICE: NoticeState = {
  message:
    'py-scratchpad has moved to py-scratchpad.com — code saved here stays here; Download your files to take them along.',
  tone: 'info',
  actions: false,
  link: { label: 'py-scratchpad.com', href: NEW_HOME_URL },
  // Persistent until dismissed: an eight-second toast would be missed, and
  // the sentence is asking the user to do something.
  dismissible: true,
}

/**
 * Whether to put the move notice up, given `location.hostname` and whatever
 * `sessionStorage` holds under `MOVE_NOTICE_DISMISSED_KEY` (`null` when
 * nothing is stored, or when session storage could not be read at all).
 *
 * Only the old hostname gets it. `py-scratchpad.com`, `www`, `localhost` and
 * the LAN endpoint `192.168.50.120:5040` must not: there is nothing to move
 * away from there.
 */
export function shouldShowMoveNotice(hostname: string, dismissed: string | null): boolean {
  if (hostname.toLowerCase() !== OLD_HOSTNAME) return false
  return dismissed !== '1'
}

// ---------------------------------------------------------------------------

/**
 * True when a state would put buttons on screen with nothing to explain them.
 * That is the regression this module exists to make visible.
 */
export function hasBareActions(state: NoticeState): boolean {
  return state.actions && state.message.trim() === ''
}

/**
 * Whether the bar should hide itself after a few seconds. A notice that only
 * reports can go; one that is waiting for the user — a choice to make, or a ✕
 * to click — stays until they act on it.
 */
export function isTransient(state: NoticeState): boolean {
  return state.tone === 'info' && !state.actions && state.dismissible !== true
}
