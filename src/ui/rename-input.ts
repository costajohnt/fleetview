import React, { useState } from 'react'
import { Text, useInput } from 'ink'
import { stripEscapeResidue } from '../text-utils.ts'
import { atEnd, backspaceAt, deleteForwardAt, insertAt, motionOf, move, withCaret, type TextCursor } from '../text-cursor.ts'
import { parseMouseEvents } from './mouse.ts'

// The ^r rename prompt. App owns what a submitted title does; this only edits it.
export function RenameInput({ initial, onSubmit, onCancel }: { initial: string; onSubmit: (title: string) => void; onCancel: () => void }): React.ReactElement {
  const [edit, setEdit] = useState<TextCursor>(() => atEnd(initial))
  const text = edit.text
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) return onCancel()
    if (key.return) return text.trim() && onSubmit(text.trim())
    if (parseMouseEvents(input).length) return // mouse sequences are not text
    const motion = motionOf(input, key) // #134: same caret and word motion as the prompt
    if (motion) return setEdit((s) => move(s, motion))
    if (key.backspace) setEdit(backspaceAt)
    else if (key.delete) setEdit(deleteForwardAt)
    else if (input && !key.ctrl && !key.meta) {
      // #112.3: strip control bytes / escape residue the same way the dispatch input does, so a
      // paste can't land C0 bytes verbatim in the title sent to the server.
      const text = stripEscapeResidue(input.replace(/[\r\n]+/g, ' ').replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, ''))
      if (text) setEdit((s) => insertAt(s, text))
    }
  })
  return React.createElement(Text, null, `Rename: ${withCaret(edit)} (⏎ save · esc cancel)`)
}
