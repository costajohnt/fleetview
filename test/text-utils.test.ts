import { describe, test, expect } from 'vitest'
import { stripControl, truncateGraphemes, graphemes } from '../src/text-utils.ts'

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
