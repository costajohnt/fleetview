// NDJSON: one complete JSON object per line, no blank-line framing — so the split is by line rather
// than by SSE's frame, but with the same buffer-the-tail contract as parseSseChunk, because a tailed
// file is read mid-line just as often as a socket is. Both process-backed backends read their
// captured streams through this. A line that isn't JSON is skipped rather than fatal: the log is
// the child's stdout *and* stderr on one fd, so a spawn failure or a plain-text CLI error lands
// here, and keeping it in the file is worth more than refusing to parse the rest of the run.
export function parseNdjsonChunk<T = unknown>(buffer: string): { events: T[]; rest: string } {
  const events: T[] = []
  const lines = buffer.split('\n')
  const rest = lines.pop() ?? '' // partial line stays buffered
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      events.push(JSON.parse(trimmed))
    } catch {
      // not JSON; see above
    }
  }
  return { events, rest }
}
