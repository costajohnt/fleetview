// Discovery: reading ~/.claude/projects/ so the roster can show claude sessions fleetview never
// started, the way it shows opencode's. Claude Code owns this directory; nothing here writes to it.
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Only the fields the roster reads. The transcript records carry a great deal more (usage, parent
// uuids, attachments) and none of it survives this function.
export type ClaudeTranscript = {
  id: string
  directory: string
  title: string
  updatedAt: number
  // When the session began, off the first record's ISO `timestamp` — 0 when no record carried a
  // parseable one. Distinct from updatedAt (the file's mtime) on purpose: the roster's age column
  // means "how old is this session" everywhere else, and rendering time-since-last-activity for
  // claude rows alone made a nine-day-old session that just replied read as `now`.
  createdAt: number
}

export const projectsDir = (home = homedir()) => join(home, '.claude', 'projects')

// Claude Code's folder name for a directory: every non-alphanumeric character becomes '-'. Verified
// against both '/' and '.' (docs/specs/2026-07-25-claude-backend-wire.md). Lossy — ~/dev/a.b and
// ~/dev/a-b collide — so this is only ever used to *find* a folder quickly, never to prove a session
// belongs to a directory. That proof is the `cwd` re-read below.
export const encodeProjectDir = (directory: string) => directory.replace(/[^a-zA-Z0-9]/g, '-')

// Scanning a transcript for the four things the roster wants. A finished session's transcript can
// reach several MB, so each line is substring-tested before it is parsed — the interesting records
// are a handful out of thousands, and JSON.parse on every line of every session was the difference
// between a listing that is free and one that is felt.
type Scanned = { cwd?: string; aiTitle?: string; lastPrompt?: string; createdAt?: number }

// What the last scan of a transcript found, plus where the read got to. Keyed by project folder and
// then file name.
//
// The offset is the point of the whole entry. events() calls listTranscripts every 500ms, and the
// old shape re-read and re-split each transcript whole, gated on mtime+size — a gate that by
// construction can never hit for the one file that matters, because an append moves both. Measured
// at ~28ms of blocked event loop twice a second per directory with one active large session. Now
// each poll reads only the bytes appended since the last one, exactly as events()'s own tail cursor
// and copilot's readFrom do.
//
// The decoder is per file and kept across polls for the same reason those two keep one: a
// positional read ends wherever the file did, which is happily mid-character, and decoding each
// chunk on its own turns every multi-byte character straddling a poll boundary into U+FFFD.
type CacheEntry = Scanned & { offset: number; rest: string; ino: number; decoder: InstanceType<typeof TextDecoder> }
const scanCache = new Map<string, Map<string, CacheEntry>>()

const freshEntry = (): CacheEntry => ({ offset: 0, rest: '', ino: 0, decoder: new TextDecoder() })

// Folds the records in `text` onto `entry`. Each line is substring-tested before it is parsed — the
// interesting records are a handful out of thousands, and JSON.parse on every line of every session
// was the difference between a listing that is free and one that is felt.
function fold(entry: CacheEntry, text: string) {
  const lines = text.split('\n')
  entry.rest = lines.pop() ?? '' // partial trailing line: the next read completes it
  for (const line of lines) {
    // ai-title is rewritten as the session is re-titled, so the last one wins — including one that
    // arrives in a later chunk, which is why these merge over the cached values rather than
    // replacing them. cwd is the same on every record and createdAt is the first record's, so both
    // are immutable once found and the rest of the file is skipped for them.
    const wantsCwd = entry.cwd === undefined && line.includes('"cwd"')
    const wantsCreated = entry.createdAt === undefined && line.includes('"timestamp"')
    const wantsTitle = line.includes('"ai-title"')
    const wantsPrompt = line.includes('"last-prompt"')
    if (!wantsCwd && !wantsCreated && !wantsTitle && !wantsPrompt) continue
    let rec: any
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof rec?.cwd === 'string' && entry.cwd === undefined) entry.cwd = rec.cwd
    // Every transcript on this machine (33/33) carries an ISO timestamp on its first record. A
    // record that lacks one, or whose value doesn't parse, leaves createdAt unset and the caller
    // falls back to the mtime it always used.
    if (entry.createdAt === undefined && typeof rec?.timestamp === 'string') {
      const parsed = Date.parse(rec.timestamp)
      if (Number.isFinite(parsed)) entry.createdAt = parsed
    }
    if (rec?.type === 'ai-title' && typeof rec.aiTitle === 'string') entry.aiTitle = rec.aiTitle
    if (rec?.type === 'last-prompt' && typeof rec.lastPrompt === 'string') entry.lastPrompt = rec.lastPrompt
  }
}

// Reads whatever has been appended to `file` since `prev` last looked, and returns the merged entry.
// A different inode is a different file: compaction that renames a rewritten transcript over the old
// path lands at whatever size it likes, so size alone misses every rewrite that happens to be
// equal-or-larger and the scan then folds mid-line garbage from a stale offset. ino 0 (some Windows
// filesystems report it) is no signal at all, so it never triggers a reset. Same rule, same reasons,
// as the copilot backend's readFrom.
function scan(file: string, prev: CacheEntry | undefined, size: number, ino: number): CacheEntry {
  let entry = prev ?? freshEntry()
  const replaced = entry.ino !== 0 && ino !== 0 && entry.ino !== ino
  if (size < entry.offset || replaced) entry = freshEntry()
  entry.ino = ino
  if (size <= entry.offset) return entry // nothing appended; the cached fold is still the answer
  let chunk: string
  try {
    const fd = openSync(file, 'r')
    try {
      const buf = Buffer.allocUnsafe(size - entry.offset)
      const read = readSync(fd, buf, 0, buf.length, entry.offset)
      chunk = entry.decoder.decode(buf.subarray(0, read), { stream: true })
      entry.offset += read
    } finally {
      closeSync(fd)
    }
  } catch {
    return entry // deleted or unreadable between readdir and here; keep what was already folded
  }
  fold(entry, entry.rest + chunk)
  return entry
}

// Sessions Claude Code has recorded for `directory`, newest first. The mtime is the only freshness
// signal there is: a transcript carries no marker saying its session is still running, so a
// discovered session's liveness is an inference and the caller has to treat it as one.
export function listTranscripts(directory: string, { home = homedir() }: { home?: string } = {}): ClaudeTranscript[] {
  const dir = join(projectsDir(home), encodeProjectDir(directory))
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    scanCache.delete(dir)
    return [] // no folder means claude has never run here, which is an empty list, not an error
  }
  const out: ClaudeTranscript[] = []
  // Rebuilt from the names readdir just returned rather than mutated in place, so a deleted
  // transcript's entry is dropped instead of held forever.
  const prev = scanCache.get(dir)
  const fresh = new Map<string, CacheEntry>()
  scanCache.set(dir, fresh)
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    const file = join(dir, name)
    let updatedAt: number
    let size: number
    let ino: number
    try {
      const st = statSync(file)
      updatedAt = st.mtimeMs
      size = st.size
      ino = Number(st.ino)
    } catch {
      continue
    }
    const entry = scan(file, prev?.get(name), size, ino)
    fresh.set(name, entry)
    const { cwd, aiTitle, lastPrompt, createdAt } = entry
    // The folder name is a lossy hash of the path, so a transcript whose own cwd disagrees belongs
    // to a different directory that happens to encode the same way, and showing it under this one
    // would put another repo's session in this repo's group.
    if (cwd !== directory) continue
    out.push({
      id: name.slice(0, -'.jsonl'.length),
      directory,
      title: aiTitle ?? lastPrompt ?? '',
      updatedAt,
      createdAt: createdAt ?? 0,
    })
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}
