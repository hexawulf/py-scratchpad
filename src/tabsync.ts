/**
 * Multi-tab guard.
 *
 * Two tabs of the scratchpad share one localStorage key, so without a guard
 * the last autosave wins and the other tab's code is simply gone. There is no
 * backend to arbitrate; the only signal available is the `storage` event, which
 * the browser fires in every tab *except* the one that wrote.
 *
 * This module holds the decision and nothing else — given such an event, does
 * this tab carry on autosaving, or pause and ask the user? Keeping it pure (no
 * DOM, no storage, no timers) makes the table above testable, and leaves
 * `main.ts` with only the wiring.
 */

/** The fields of a `StorageEvent` the decision depends on. */
export interface StorageEventLike {
  key: string | null
  newValue: string | null
}

export type IgnoreReason = 'other-key' | 'cleared' | 'our-own-write' | 'already-paused'

export type SyncDecision = { kind: 'pause' } | { kind: 'ignore'; reason: IgnoreReason }

export interface SyncInputs {
  event: StorageEventLike
  storageKey: string
  /** Exactly the string this tab last wrote or read, or null if neither yet. */
  lastWritten: string | null
  /** True when this tab has already paused and is showing the notice. */
  paused: boolean
}

/** The state the unload warning depends on. */
export interface UnloadInputs {
  /** True while autosave is paused waiting on Reload or Keep mine. */
  paused: boolean
  /** True when the buffer holds edits that have not reached storage. */
  dirty: boolean
}

/**
 * Whether leaving the page would lose work.
 *
 * Only the paused-and-dirty combination qualifies. While autosave is running,
 * `pagehide` commits the buffer and nothing is lost, so a browser prompt would
 * be pure noise; and a paused tab with no edits has nothing to lose either.
 */
export function shouldWarnBeforeUnload(inputs: UnloadInputs): boolean {
  return inputs.paused && inputs.dirty
}

export function decideOnExternalWrite(inputs: SyncInputs): SyncDecision {
  const { event, storageKey, lastWritten, paused } = inputs

  if (event.key !== storageKey) {
    // `localStorage.clear()` fires a single event with a null key.
    return { kind: 'ignore', reason: event.key === null ? 'cleared' : 'other-key' }
  }

  // Our key was removed. There is nothing to reload, and this tab's next
  // autosave puts the buffer back, so the user needs no decision.
  if (event.newValue === null) return { kind: 'ignore', reason: 'cleared' }

  // Some browsers have historically fired `storage` in the writing tab as well.
  // Either way, a value byte-identical to ours means nothing has diverged.
  if (lastWritten !== null && event.newValue === lastWritten) {
    return { kind: 'ignore', reason: 'our-own-write' }
  }

  // Already paused: the notice is up and the user still has to choose. A second
  // write from the other tab must not reset or duplicate that prompt.
  if (paused) return { kind: 'ignore', reason: 'already-paused' }

  return { kind: 'pause' }
}
