import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  CONFLICT_NOTICE,
  hasBareActions,
  isTransient,
  MOVE_NOTICE,
  MOVE_NOTICE_DISMISSED_KEY,
  NEW_HOME_URL,
  type NoticeState,
  OLD_HOSTNAME,
  RELOADED_NOTICE,
  shouldShowMoveNotice,
} from '../src/notice.ts'

const STYLE = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8')
const MAIN = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')

describe('the notice bar renders its message alongside both actions', () => {
  it('pairs the multi-tab prompt with the sentence that asks the question', () => {
    expect(CONFLICT_NOTICE.actions).toBe(true)
    expect(CONFLICT_NOTICE.message.trim()).not.toBe('')
    expect(hasBareActions(CONFLICT_NOTICE)).toBe(false)
  })

  it('does not offer a choice on a notice that only reports', () => {
    expect(RELOADED_NOTICE.actions).toBe(false)
    expect(RELOADED_NOTICE.message.trim()).not.toBe('')
  })

  it('catches a state that would show the buttons on their own', () => {
    const bare: NoticeState = { message: '   ', tone: 'error', actions: true }
    expect(hasBareActions(bare)).toBe(true)
  })

  // Answers "is the text missing from the DOM?" for the shipped markup: the
  // message element is in the template, is not itself hidden, and comes before
  // the two buttons.
  it('has a visible message element before both buttons in the template', () => {
    const text = MAIN.indexOf('id="notice-text"')
    const actions = MAIN.indexOf('id="notice-actions"')
    const reload = MAIN.indexOf('id="notice-reload"')
    const keep = MAIN.indexOf('id="notice-keep"')

    expect(text).toBeGreaterThan(-1)
    expect(text).toBeLessThan(actions)
    expect(actions).toBeLessThan(reload)
    expect(reload).toBeLessThan(keep)
  })

  it('keeps the rule that makes [hidden] win over a class that sets display', () => {
    expect(STYLE).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important/)
  })
})

describe('a notice only hides itself when it is just reporting', () => {
  it('lets a plain info notice time out', () => {
    expect(isTransient(RELOADED_NOTICE)).toBe(true)
  })

  it('keeps an error up', () => {
    expect(isTransient({ message: 'boom', tone: 'error', actions: false })).toBe(false)
  })

  it('keeps a prompt up until the user chooses', () => {
    expect(isTransient(CONFLICT_NOTICE)).toBe(false)
  })

  it('keeps a dismissible notice up until the ✕ is clicked', () => {
    expect(isTransient(MOVE_NOTICE)).toBe(false)
  })
})

describe('the move notice', () => {
  it('says what moved, that the code stays, and what to do about it', () => {
    expect(MOVE_NOTICE.message).toBe(
      'py-scratchpad has moved to py-scratchpad.com — code saved here stays here; Download your files to take them along.',
    )
    expect(MOVE_NOTICE.link).toEqual({ label: 'py-scratchpad.com', href: NEW_HOME_URL })
    expect(MOVE_NOTICE.dismissible).toBe(true)
    expect(hasBareActions(MOVE_NOTICE)).toBe(false)
  })

  it('shows on the old hostname when nothing was dismissed', () => {
    expect(shouldShowMoveNotice(OLD_HOSTNAME, null)).toBe(true)
  })

  it('is case-insensitive about the hostname, as DNS is', () => {
    expect(shouldShowMoveNotice('Python.PiApps.Dev', null)).toBe(true)
  })

  it('stays away once dismissed for this session', () => {
    expect(shouldShowMoveNotice(OLD_HOSTNAME, '1')).toBe(false)
  })

  it('shows again when the stored flag is not the dismissal value', () => {
    // Only the exact '1' counts as dismissed, so a stale or foreign value in
    // that session key reads as "not dismissed" rather than hiding the notice.
    expect(shouldShowMoveNotice(OLD_HOSTNAME, '0')).toBe(true)
    expect(shouldShowMoveNotice(OLD_HOSTNAME, 'nonsense')).toBe(true)
  })

  it('never shows on the new home, its www, localhost or the LAN endpoint', () => {
    for (const host of [
      'py-scratchpad.com',
      'www.py-scratchpad.com',
      'localhost',
      '127.0.0.1',
      '192.168.50.120',
    ]) {
      expect(shouldShowMoveNotice(host, null)).toBe(false)
    }
  })

  it('does not move the old hostname off its own origin', () => {
    // A redirect would hide everything saved at the old origin, which is the
    // whole reason this notice exists instead of one.
    expect(MAIN).not.toMatch(/location\.(replace|assign|href\s*=)/)
  })

  it('opens the link in a new tab with no reference back to this one', () => {
    expect(MAIN).toMatch(/id="notice-link"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/)
  })

  it('remembers the dismissal in sessionStorage, not in the saved schema', () => {
    expect(MOVE_NOTICE_DISMISSED_KEY).toBe('py-scratchpad:move-notice-dismissed')
    expect(MAIN).toMatch(/sessionStorage\.setItem/)
    expect(MAIN).not.toMatch(/localStorage\.setItem\(MOVE_NOTICE_DISMISSED_KEY/)
  })

  it('sizes its ✕ with two classes, so .icon-button cannot win on source order', () => {
    const dismiss = STYLE.indexOf('.notice .notice-dismiss {')
    const iconButton = STYLE.indexOf('.icon-button {')
    expect(dismiss).toBeGreaterThan(-1)
    expect(iconButton).toBeGreaterThan(-1)
    // The weaker selector would need to come after; this one does not have to.
    expect(dismiss).toBeLessThan(iconButton)
  })
})
