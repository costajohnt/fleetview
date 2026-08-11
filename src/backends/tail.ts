// Tail-a-growing-file, shared by both process-backed backends and the transcript scan. The same
// dance was written three times (claude events(), copilot readFrom, projects.ts scan) with comments
// citing each other; the ino-0-Windows rule and the mid-character-decode fix had to be applied three
// times. Now the cursor lifecycle lives here once.
import { closeSync, openSync, readSync, statSync } from 'node:fs'

// Byte offset and partial-line tail per file, so each call reads only what was appended. The decoder
// is per file and kept across reads for the same reason event-mux.ts keeps one: a positional read
// ends wherever the file did, which is happily mid-character, and decoding each chunk on its own
// turns every multi-byte character straddling a read boundary into U+FFFD.
// `rest` is the caller's partial-line buffer — tailFile clears it on reset (a held-over partial line
// belongs to a file that no longer exists) but never appends to it; line-splitting is the parser's
// job, not the reader's.
export type TailCursor = { offset: number; rest: string; ino: number; decoder: InstanceType<typeof TextDecoder> }

export const newTailCursor = (): TailCursor => ({ offset: 0, rest: '', ino: 0, decoder: new TextDecoder() })

// Reads whatever has been appended to `file` since the cursor last looked, advancing the cursor.
//
// Returns null when the file cannot be statted (meta written, log not yet — or deleted between
// readdir and here): the cursor is untouched and the next poll tries again. A read failure after a
// successful stat returns `{ text: '', reset }` instead, so a reset detected on that pass still
// reaches the caller rather than being retried with the caller's folded state left stale.
//
// `reset` is true when the file shrank or changed inode — rotated, rewritten or renamed over.
// Re-reading from zero is the only way back: keeping the old offset means the tail never sees
// another byte of that file, and a rewrite delivered by rename-over lands at whatever size it
// likes, so size alone misses every rewrite that happens to be equal-or-larger and the tail then
// reads mid-line garbage from a stale offset. The cursor is zeroed (offset, rest, fresh decoder —
// the old one may be holding the head of a character from the file that no longer exists) and the
// caller must drop whatever state it folded from the old file. ino 0 (some Windows filesystems
// report it) is no signal at all, so it never triggers a reset and those hosts keep the size
// heuristic they had.
//
// `stat` lets a caller that already statted the file (it needed the mtime anyway) skip a second
// stat; `text` is what the fresh bytes decoded to, empty when nothing was appended.
export function tailFile(cursor: TailCursor, file: string, stat?: { size: number; ino: number }): { text: string; reset: boolean } | null {
  let size: number
  let ino: number
  if (stat) {
    size = stat.size
    ino = stat.ino
  } else {
    try {
      const st = statSync(file)
      size = st.size
      ino = Number(st.ino)
    } catch {
      return null
    }
  }
  const replaced = cursor.ino !== 0 && ino !== 0 && cursor.ino !== ino
  const reset = size < cursor.offset || replaced
  cursor.ino = ino
  if (reset) {
    cursor.offset = 0
    cursor.rest = ''
    cursor.decoder = new TextDecoder()
  }
  if (size <= cursor.offset) return { text: '', reset }
  try {
    const fd = openSync(file, 'r')
    try {
      const buf = Buffer.allocUnsafe(size - cursor.offset)
      const read = readSync(fd, buf, 0, buf.length, cursor.offset)
      cursor.offset += read
      return { text: cursor.decoder.decode(buf.subarray(0, read), { stream: true }), reset }
    } finally {
      closeSync(fd)
    }
  } catch {
    return { text: '', reset } // unreadable between stat and here; whatever reset said still stands
  }
}
