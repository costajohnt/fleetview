// The palette, in one place. Every component asks for a meaning (accent, warn, danger) rather than
// an ink color name, so restyling — or a future user-facing theme setting — is an edit here, not a
// hunt through every view. Values are ink `color` strings; anything ink accepts works.
export const theme = {
  accent: 'green', // selection markers, dispatch, the healthy/finished color
  info: 'cyan', // working state, agent names, questions
  warn: 'yellow', // needs-input state, notices, permissions
  danger: 'red', // failures
  muted: 'gray', // idle/stopped, secondary text that still needs a color (dimColor covers the rest)
  // The selected row's background bar, matching agent view's rgb(55,55,55) — selection is a
  // full-width highlight, not a marker glyph. Truecolor because no ANSI-16 name is that grey.
  selectionBg: '#373737',
  selectionFg: 'white', // the selected row's title/header text on top of the bar
  // Group headers are bold in the secondary grey, uniformly — agent view gives them no per-state
  // color (the state lives in the row glyphs), and a header's job is structure, not urgency.
  header: 'gray',
  pr: {
    // A pull request's color by state (the row's #N label and the peek PR list): yellow = act
    // (failing, pending, review required), green = healthy, magenta = merged, gray = inert (draft, closed).
    merged: 'magenta',
    closed: 'gray',
    draft: 'gray',
    failing: 'yellow',
    pending: 'yellow',
    passing: 'green',
  },
}
