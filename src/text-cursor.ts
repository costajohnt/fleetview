// #134: one caret model for every text input (dispatch prompt, peek reply, rename). Each input
// holds a TextCursor and edits it only through these functions, so insertion, deletion and
// cursor motion — including Option+Arrow word motion — have exactly one definition.
//
// `cursor` is a code-unit offset into `text` that always sits on a grapheme boundary: motion
// steps by grapheme (an emoji ZWJ sequence is one step), and word motion lands only next to
// whitespace, which is itself a grapheme boundary.
import type { Key } from 'ink'
import { graphemes, truncateGraphemes } from './text-utils.ts'

export type TextCursor = { readonly text: string; readonly cursor: number }

export type Motion = 'left' | 'right' | 'word-left' | 'word-right'

export const EMPTY: TextCursor = { text: '', cursor: 0 }

export const atEnd = (text: string): TextCursor => ({ text, cursor: text.length })

const clamp = (text: string, cursor: number) => Math.max(0, Math.min(text.length, cursor))

// Length in code units of the grapheme ending at `cursor` (0 at the start of the text).
const graphemeBefore = (text: string, cursor: number) => {
  const g = graphemes(text.slice(0, cursor))
  return g.length ? g[g.length - 1].length : 0
}

// Length in code units of the grapheme starting at `cursor` (0 at the end of the text).
const graphemeAfter = (text: string, cursor: number) => truncateGraphemes(text.slice(cursor), 1).length

const isSpace = (ch: string | undefined) => ch !== undefined && /\s/.test(ch)

// A word is a run of non-whitespace, so `foo,` is one word and punctuation travels with it. The
// simple rule is the predictable one; a language-aware boundary would move differently on every
// prompt that mentions a path or a flag.
export const wordLeft = (text: string, cursor: number): number => {
  let i = clamp(text, cursor)
  while (i > 0 && isSpace(text[i - 1])) i--
  while (i > 0 && !isSpace(text[i - 1])) i--
  return i
}

// To the start of the next word — vim's `w`, and what the issue asked for — which from the last
// word means the end of the text.
export const wordRight = (text: string, cursor: number): number => {
  let i = clamp(text, cursor)
  while (i < text.length && !isSpace(text[i])) i++
  while (i < text.length && isSpace(text[i])) i++
  return i
}

export const move = (s: TextCursor, motion: Motion): TextCursor => {
  const cursor = clamp(s.text, s.cursor)
  switch (motion) {
    case 'left':
      return { text: s.text, cursor: cursor - graphemeBefore(s.text, cursor) }
    case 'right':
      return { text: s.text, cursor: cursor + graphemeAfter(s.text, cursor) }
    case 'word-left':
      return { text: s.text, cursor: wordLeft(s.text, cursor) }
    case 'word-right':
      return { text: s.text, cursor: wordRight(s.text, cursor) }
  }
}

export const insertAt = (s: TextCursor, chunk: string): TextCursor => {
  const cursor = clamp(s.text, s.cursor)
  return { text: s.text.slice(0, cursor) + chunk + s.text.slice(cursor), cursor: cursor + chunk.length }
}

export const backspaceAt = (s: TextCursor): TextCursor => {
  const cursor = clamp(s.text, s.cursor)
  const n = graphemeBefore(s.text, cursor)
  return { text: s.text.slice(0, cursor - n) + s.text.slice(cursor), cursor: cursor - n }
}

export const deleteForwardAt = (s: TextCursor): TextCursor => {
  const cursor = clamp(s.text, s.cursor)
  const n = graphemeAfter(s.text, cursor)
  return { text: s.text.slice(0, cursor) + s.text.slice(cursor + n), cursor }
}

// A solid block caret, no blink (John's polish pass — the animation earned nothing).
export const CARET = '█'

export const withCaret = (s: TextCursor, caret = CARET): string => {
  const cursor = clamp(s.text, s.cursor)
  return s.text.slice(0, cursor) + caret + s.text.slice(cursor)
}

// What a keypress means for the caret, decoded from the shapes Ink's parse-keypress hands a
// handler. Option+Arrow on macOS is not one sequence:
//   `\x1b[1;3D` / `\x1b[1;3C`   xterm modifier form (iTerm2, Ghostty, kitty, WezTerm, VS Code)
//   `\x1b\x1b[D` / `\x1b\x1b[C` Terminal.app with "Use Option as Meta key"
//   `\x1bb` / `\x1bf`           Terminal.app and iTerm2 defaults: the readline word keys
// Ink reports the first two as leftArrow/rightArrow with `meta`, the third as `meta` with the
// letter as input. Ctrl+Arrow (`\x1b[1;5D`) is the same motion on Linux terminals.
export const motionOf = (
  input: string,
  key: Pick<Key, 'leftArrow' | 'rightArrow' | 'meta' | 'ctrl'>,
): Motion | null => {
  const word = key.meta || key.ctrl
  if (key.leftArrow) return word ? 'word-left' : 'left'
  if (key.rightArrow) return word ? 'word-right' : 'right'
  if (key.meta && input === 'b') return 'word-left'
  if (key.meta && input === 'f') return 'word-right'
  return null
}
