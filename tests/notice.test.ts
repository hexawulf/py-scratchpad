import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  CONFLICT_NOTICE,
  hasBareActions,
  type NoticeState,
  RELOADED_NOTICE,
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

    // The bar and the action group start hidden; the message itself never is.
    const textTag = MAIN.slice(text, MAIN.indexOf('>', text))
    expect(textTag).not.toContain('hidden')
    expect(textTag).toContain('class="notice-text"')
  })
})

/*
 * These assert the stylesheet, not the DOM, and that is deliberate: neither
 * jsdom nor happy-dom resolves `display` from a stylesheet, so a DOM-env test
 * could not have caught the bug this guards. What shipped was a notice bar
 * that never hid, because an author rule setting `display` beats the
 * user-agent's `[hidden] { display: none }` whatever its specificity.
 */
describe('hidden actually hides', () => {
  it('declares a global [hidden] rule that a later class cannot defeat', () => {
    expect(STYLE).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/)
  })

  it('declares it before anything that sets display', () => {
    const guard = STYLE.indexOf('[hidden]')
    const firstDisplay = STYLE.search(/^\s*display:/m)
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(firstDisplay)
  })

  // If these two ever stop setting `display`, the guard above is no longer
  // load-bearing and this file should say so rather than passing silently.
  it('is still needed, because the notice sets display on a class', () => {
    expect(STYLE).toMatch(/\.notice\s*\{[^}]*display:\s*flex/)
    expect(STYLE).toMatch(/\.notice-actions\s*\{[^}]*display:\s*inline-flex/)
  })
})
