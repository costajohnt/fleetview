import { describe, test, expect } from 'vitest'
import {
  atEnd,
  backspaceAt,
  deleteForwardAt,
  insertAt,
  motionOf,
  move,
  withCaret,
  wordLeft,
  wordRight,
} from '../src/text-cursor.ts'

// #134: Option+Arrow moves the caret a word at a time. A word is a run of non-whitespace, so
// punctuation travels with the word it touches — the simple rule, not a language-aware one.
describe('wordLeft', () => {
  test('moves to the start of the previous word', () => {
    expect(wordLeft('fix the parser', 14)).toBe(8)
    expect(wordLeft('fix the parser', 8)).toBe(4)
    expect(wordLeft('fix the parser', 4)).toBe(0)
  })
  test('from inside a word goes to that word\'s start', () => {
    expect(wordLeft('fix the parser', 11)).toBe(8)
  })
  test('skips a run of spaces before the word', () => {
    expect(wordLeft('fix   the', 6)).toBe(0)
    expect(wordLeft('fix   the', 9)).toBe(6)
  })
  test('stays put at the start', () => {
    expect(wordLeft('fix', 0)).toBe(0)
    expect(wordLeft('', 0)).toBe(0)
  })
  test('punctuation is part of the word it touches', () => {
    expect(wordLeft('foo, bar', 8)).toBe(5)
    expect(wordLeft('foo, bar', 5)).toBe(0)
  })
  test('a newline is whitespace, so the motion crosses lines', () => {
    expect(wordLeft('one\ntwo', 4)).toBe(0)
  })
})

describe('wordRight', () => {
  test('moves to the start of the next word', () => {
    expect(wordRight('fix the parser', 0)).toBe(4)
    expect(wordRight('fix the parser', 4)).toBe(8)
  })
  test('from inside a word goes to the start of the next one', () => {
    expect(wordRight('fix the parser', 1)).toBe(4)
  })
  test('skips the run of spaces after the word', () => {
    expect(wordRight('fix   the', 0)).toBe(6)
  })
  test('from the last word goes to the end and then stays put', () => {
    expect(wordRight('fix the parser', 8)).toBe(14)
    expect(wordRight('fix the parser', 14)).toBe(14)
    expect(wordRight('', 0)).toBe(0)
  })
  test('trailing spaces are consumed on the way to the end', () => {
    expect(wordRight('fix  ', 0)).toBe(5)
  })
  test('punctuation is part of the word it touches', () => {
    expect(wordRight('foo, bar', 0)).toBe(5)
  })
})

describe('move', () => {
  test('left and right step by grapheme, not by code unit', () => {
    const s = atEnd('a👨‍👩‍👧b')
    const left = move(s, 'left')
    expect(left.cursor).toBe(s.text.length - 1)
    const left2 = move(left, 'left')
    expect(s.text.slice(left2.cursor, left.cursor)).toBe('👨‍👩‍👧')
    expect(move(left2, 'right')).toEqual(left)
  })
  test('is clamped at both ends', () => {
    expect(move({ text: 'ab', cursor: 0 }, 'left').cursor).toBe(0)
    expect(move(atEnd('ab'), 'right').cursor).toBe(2)
  })
  test('word motions use the word rules', () => {
    expect(move(atEnd('fix the parser'), 'word-left').cursor).toBe(8)
    expect(move({ text: 'fix the parser', cursor: 0 }, 'word-right').cursor).toBe(4)
  })
})

describe('editing at the caret', () => {
  test('insertAt puts text at the caret and moves the caret past it', () => {
    expect(insertAt({ text: 'fix parser', cursor: 4 }, 'the ')).toEqual({ text: 'fix the parser', cursor: 8 })
  })
  test('backspaceAt removes the grapheme before the caret', () => {
    expect(backspaceAt({ text: 'a👍b', cursor: 3 })).toEqual({ text: 'ab', cursor: 1 })
    expect(backspaceAt({ text: 'ab', cursor: 0 })).toEqual({ text: 'ab', cursor: 0 })
  })
  test('deleteForwardAt removes the grapheme after the caret', () => {
    expect(deleteForwardAt({ text: 'a👍b', cursor: 1 })).toEqual({ text: 'ab', cursor: 1 })
    expect(deleteForwardAt(atEnd('ab'))).toEqual({ text: 'ab', cursor: 2 })
  })
  test('withCaret draws the caret where the cursor is', () => {
    expect(withCaret({ text: 'fix the parser', cursor: 8 })).toBe('fix the █parser')
    expect(withCaret(atEnd('fix'))).toBe('fix█')
  })
})

// The four shapes Ink hands a handler for Option+Arrow, per node_modules/ink parse-keypress:
// `\x1b[1;3D` (xterm modifier 3 = alt) and `\x1b\x1b[D` (Terminal.app "Option as Meta") both
// arrive as leftArrow+meta with empty input; `\x1bb` / `\x1bf` (Terminal.app and iTerm2's
// default Option handling, the readline convention) arrive as meta with input 'b' / 'f'.
describe('motionOf', () => {
  const key = (k: Partial<{ leftArrow: boolean; rightArrow: boolean; meta: boolean; ctrl: boolean }>) => ({
    leftArrow: false,
    rightArrow: false,
    meta: false,
    ctrl: false,
    ...k,
  })
  test('meta+arrow is a word motion', () => {
    expect(motionOf('', key({ leftArrow: true, meta: true }))).toBe('word-left')
    expect(motionOf('', key({ rightArrow: true, meta: true }))).toBe('word-right')
  })
  test('ctrl+arrow is the same word motion (the Linux terminal convention)', () => {
    expect(motionOf('', key({ leftArrow: true, ctrl: true }))).toBe('word-left')
    expect(motionOf('', key({ rightArrow: true, ctrl: true }))).toBe('word-right')
  })
  test('ESC b / ESC f are word motions', () => {
    expect(motionOf('b', key({ meta: true }))).toBe('word-left')
    expect(motionOf('f', key({ meta: true }))).toBe('word-right')
  })
  test('plain arrows step by character', () => {
    expect(motionOf('', key({ leftArrow: true }))).toBe('left')
    expect(motionOf('', key({ rightArrow: true }))).toBe('right')
  })
  test('anything else is not a motion', () => {
    expect(motionOf('b', key({}))).toBe(null)
    expect(motionOf('', key({ ctrl: true }))).toBe(null)
    expect(motionOf('x', key({ meta: true }))).toBe(null)
  })
})
