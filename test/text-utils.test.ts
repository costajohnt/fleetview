import { describe, test, expect } from 'vitest'
import { stripControl, truncateGraphemes, graphemes, stripEscapeResidue } from '../src/text-utils.ts'

const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)

describe('stripControl', () => {
  test('drops an OSC clipboard-write escape a session title could carry', () => {
    const title = `deploy${ESC}]52;c;cHduCg==${BEL}done`
    const clean = stripControl(title)
    expect(clean).not.toContain(ESC)
    expect(clean).not.toContain(BEL)
    expect(clean).toBe('deploy]52;c;cHduCg==done')
  })

  test('keeps tab and newline so a logs transcript stays readable', () => {
    expect(stripControl('a\tb\nc')).toBe('a\tb\nc')
  })

  test('drops DEL and the C1 range (8-bit OSC introducer)', () => {
    expect(stripControl(`x${String.fromCharCode(0x7f)}${String.fromCharCode(0x9d)}y`)).toBe('xy')
  })

  test('passes non-strings through untouched', () => {
    expect(stripControl(undefined as any)).toBe(undefined)
    expect(stripControl(null as any)).toBe(null)
  })
})

describe('truncateGraphemes', () => {
  test('does not split a ZWJ emoji at the truncation boundary', () => {
    // Family emoji is one grapheme built from four code points joined by ZWJ. Cutting at 1 grapheme
    // must yield the whole cluster, never a half-formed sequence with replacement chars.
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}'
    const out = truncateGraphemes(`${family}tail`, 1)
    expect(out).toBe(family)
    expect(out).not.toContain('�')
    expect(graphemes(out)).toHaveLength(1)
  })

  test('does not chop a surrogate pair', () => {
    const out = truncateGraphemes('\u{1F600}\u{1F601}', 1)
    expect(out).toBe('\u{1F600}')
    expect(out).not.toContain('�')
  })
})

describe('stripEscapeResidue', () => {
  test('drops the printable tails of the sequences a terminal sends on its own', () => {
    expect(stripEscapeResidue('[I')).toBe('') // focus in
    expect(stripEscapeResidue('[O')).toBe('') // focus out
    expect(stripEscapeResidue('[200~pasted')).toBe('pasted')
    expect(stripEscapeResidue('[201~')).toBe('')
    expect(stripEscapeResidue('[45;1R')).toBe('') // cursor position report
    expect(stripEscapeResidue('[?65;4c')).toBe('') // device attributes
    expect(stripEscapeResidue(']11;rgb:1c1c/1c1c/1c1c')).toBe('') // OSC colour answer
  })

  test('strips a run of them, so a focus report followed by a paste marker leaves nothing', () => {
    expect(stripEscapeResidue('[200~[201~')).toBe('')
  })

  // The filter guards a prompt the user is typing, so a false positive costs more than a miss.
  test('leaves text that merely starts with a bracket alone', () => {
    expect(stripEscapeResidue('[ok]')).toBe('[ok]')
    expect(stripEscapeResidue('[1] thing')).toBe('[1] thing')
    expect(stripEscapeResidue('[Inbox] triage')).toBe('[Inbox] triage')
    expect(stripEscapeResidue('fix the [200~ parser')).toBe('fix the [200~ parser')
    expect(stripEscapeResidue('deploy the api')).toBe('deploy the api')
    expect(stripEscapeResidue('')).toBe('')
  })
})
