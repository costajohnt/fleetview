// SGR mouse reporting (\x1b[?1000h + \x1b[?1006h): the terminal sends `\x1b[<b;x;yM` on press
// and `...m` on release, with wheel ticks as buttons 64/65. 1006 (SGR encoding) matters because
// the legacy X10 encoding breaks past column 223 and isn't UTF-8 safe.
export const MOUSE_ON = '\x1b[?1000;1006h'
export const MOUSE_OFF = '\x1b[?1000;1006l'

// Pure: every SGR mouse event in a stdin chunk, in order. Ink hands useInput the chunk with the
// leading ESC stripped, so the pattern anchors on `[<` rather than the escape byte. A wheel tick
// can deliver several events in one chunk, which is why this returns all of them.
import type { MouseEvent } from '../types.ts'

export function parseMouseEvents(chunk: string): MouseEvent[] {
  if (!chunk || !chunk.includes('[<')) return []
  const events: MouseEvent[] = []
  const re = /\[<(\d+);(\d+);(\d+)([Mm])/g
  let match: RegExpExecArray | null
  while ((match = re.exec(chunk))) {
    const button = Number(match[1])
    const kind: MouseEvent['kind'] =
      button === 64 ? 'wheel-up' : button === 65 ? 'wheel-down' : match[4] === 'M' ? 'press' : 'release'
    events.push({ button, x: Number(match[2]), y: Number(match[3]), kind })
  }
  return events
}
