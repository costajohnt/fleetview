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

  // #58: the shapes that still leaked after the first pass. The paste terminator is the frequent
  // one — it is never leading, so a loop that only slices from position 0 could never remove it.
  test.each([
    ['SS3 up arrow', 'OA', ''],
    ['SS3 F1', 'OP', ''],
    ['kitty CSI-u ctrl+a', '[97;5u', ''],
    ['modifyOtherKeys ctrl+c', '[27;5;99~', ''],
    ['DSR device status', '[0n', ''],
    ['DSR with no parameter', '[n', ''],
    ['bracketed paste, whole', '[200~hello[201~', 'hello'],
    ['paste terminator alone in a later chunk', 'world[201~', 'world'],
    ['two paste terminators in one chunk', 'a[201~b[201~', 'ab'],
    ['a run of remnants', '[200~[201~', ''],
    ['OSC colour answer', ']11;rgb:1c1c/1c1c/1c1c', ''],
  ])('strips %s', (_label, input, expected) => {
    expect(stripEscapeResidue(input)).toBe(expected)
  })

  // The filter guards a prompt the user is typing, so a false positive costs more than a miss.
  // `]0;`/`]8;` prose used to be eaten whole: the OSC pattern ran to end-of-chunk unanchored (#58).
  test.each([
    ['[ok]'],
    ['[ok] ship it'],
    ['[1] thing'],
    ['[1] retry the build'],
    ['[Inbox] triage'],
    ['[2fix that'], // the shape a generic `^\[[0-9;]+[a-z]` would have eaten
    ['fix the [200~ parser'],
    ['OK done'], // the SS3 shape is whole-remnant only
    ['note: ]8; is an OSC hyperlink'],
    [']8; and then some prose'],
    [']0;title of the window'],
    ['deploy the api'],
    [''],
  ])('leaves %j alone', (input) => {
    expect(stripEscapeResidue(input)).toBe(input)
  })
})
