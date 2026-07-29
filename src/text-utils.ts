// M5: shared grapheme-safe string helpers. A code-unit slice/truncate can chop a surrogate pair
// or emoji+modifier/ZWJ sequence in half, corrupting it into replacement-char garbage at the cut
// boundary. Intl.Segmenter splits by user-perceived character instead, so truncation always lands
// between whole graphemes.
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export const graphemes = (text: string): string[] => [...segmenter.segment(text)].map((s) => s.segment)

// I1: iterate the segmenter's iterator lazily and stop as soon as `max` graphemes are collected —
// V8's Intl.Segmenter iterator only does the grapheme-boundary work segment-by-segment on each
// .next(), so breaking early is O(max), not O(text.length). The old `[...segment(text)]` spread
// materialized every segment up front even when max was tiny, which is what burned 16-60ms/render
// on long streamed replies.
export const truncateGraphemes = (text: string, max: number): string => {
  if (!text) return ''
  let result = ''
  let count = 0
  for (const { segment } of segmenter.segment(text)) {
    if (count >= max) break
    result += segment
    count++
  }
  return result
}

// Strip terminal control bytes from server- or model-derived text before it reaches a terminal.
// The CLI (`ls`/`logs`) writes titles/snippets/replies straight to stdout with no Ink backstop, so
// an escape in a session title or reply (OSC 52 clipboard write, OSC 0/2 title spoof) would drive
// the user's terminal; Ink neutralizes most escapes in the TUI but keeps OSC 8, and fleetview's
// input-side stripping doesn't cover the C1 range. Keeps tab and newline; drops the rest of C0,
// DEL, and C1 (0x80-0x9F).
export const stripControl = (text: string): string => {
  if (typeof text !== 'string') return text
  let out = ''
  for (const ch of text) {
    const c = ch.codePointAt(0)! // iterating a string yields whole code points, never empty
    if (c === 0x09 || c === 0x0a || (c > 0x1f && c !== 0x7f && !(c >= 0x80 && c <= 0x9f))) out += ch
  }
  return out
}

// OSC 8 hyperlink: terminals that support links make `text` clickable; the rest render it unchanged.
// Zero visible width, so callers wrap AFTER truncation — the escape inside a truncated string would
// cut the terminator and swallow the rest of the frame into the link. OSC 8 is the one escape Ink
// passes through, so the URL half must be trusted: a control byte would terminate the sequence early
// and let the rest drive the terminal, and a non-http(s) scheme isn't worth linking. Anything else
// returns the plain text. Shared by the peek PR list and the roster row's #N label.
export const osc8 = (url: string, text: string): string =>
  /^https?:\/\//.test(url) && !/[\u0000-\u001F\u007F-\u009F]/.test(url)
    ? `\u001B]8;;${url}\u0007${text}\u001B]8;;\u0007`
    : text
