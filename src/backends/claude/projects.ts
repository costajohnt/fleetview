// Discovery: reading ~/.claude/projects/ so the roster can show claude sessions fleetview never
// started, the way it shows opencode's. Claude Code owns this directory; nothing here writes to it.
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SESSION_ID_RE } from '../session-id.ts'
import { newTailCursor, tailFile, type TailCursor } from '../tail.ts'

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
type Scanned = { cwd?: string; aiTitle?: string; lastPrompt?: string; firstPrompt?: string; createdAt?: number }

// #46: the last-resort name for a session claude has not titled. A transcript only grows an
// `ai-title` once claude names it and a `last-prompt` once one is recorded — 78 of the 857
// transcripts on this machine (9%) have neither, and every one of them rendered as its bare UUID.
// The text that started the session is right there in the first user record, and it is what peek
// already shows for the row, so the roster and peek stop disagreeing.
// The FIRST user text, not the last: this is the session's subject the way opencode names a session
// from its opening prompt, where `last-prompt` is whatever was typed most recently.
// Capped because a prompt is not a title — a pasted stack trace is a legitimate first prompt, and
// this string reaches `ls` on raw stdout where nothing else truncates it.
const FIRST_PROMPT_CAP = 200
function promptText(rec: any): string {
  // isMeta records are claude's own boilerplate (the `<local-command-caveat>` preamble), not
  // something a person typed — 4 of those 78 open with one.
  if (rec?.isMeta) return ''
  const content = rec?.message?.content
  const text =
    typeof content === 'string'
      ? content
      : // A user record can also carry tool results, which have no text block and leave this empty
        // so the scan keeps looking at the next user record rather than titling a row with a tool id.
        Array.isArray(content)
        ? content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join(' ')
        : ''
  return text.replace(/\s+/g, ' ').trim().slice(0, FIRST_PROMPT_CAP)
}

// What the last scan of a transcript found, plus where the read got to. Keyed by project folder and
// then file name.
//
// The cursor is the point of the whole entry. events() calls listTranscripts every 500ms, and the
// old shape re-read and re-split each transcript whole, gated on mtime+size — a gate that by
// construction can never hit for the one file that matters, because an append moves both. Measured
// at ~28ms of blocked event loop twice a second per directory with one active large session. Now
// each poll reads only the bytes appended since the last one, through the same tail cursor
// (tail.ts) both process-backed backends read their logs with.
type CacheEntry = Scanned & { cursor: TailCursor }
const scanCache = new Map<string, Map<string, CacheEntry>>()

const freshEntry = (): CacheEntry => ({ cursor: newTailCursor() })

// Folds the records in `text` onto `entry`. Each line is substring-tested before it is parsed — the
// interesting records are a handful out of thousands, and JSON.parse on every line of every session
// was the difference between a listing that is free and one that is felt.
function fold(entry: CacheEntry, text: string) {
  const lines = text.split('\n')
  entry.cursor.rest = lines.pop() ?? '' // partial trailing line: the next read completes it
  for (const line of lines) {
    // ai-title is rewritten as the session is re-titled, so the last one wins — including one that
    // arrives in a later chunk, which is why these merge over the cached values rather than
    // replacing them. cwd is the same on every record and createdAt is the first record's, so both
    // are immutable once found and the rest of the file is skipped for them.
    const wantsCwd = entry.cwd === undefined && line.includes('"cwd"')
    const wantsCreated = entry.createdAt === undefined && line.includes('"timestamp"')
    const wantsTitle = line.includes('"ai-title"')
    const wantsPrompt = line.includes('"last-prompt"')
    // Only until one is found: the substring test matches every user record in the file, so the
    // parse this opens is paid once per transcript (claude's first record is a user record), not
    // once per line — the whole point of the tests above.
    const wantsFirstPrompt = entry.firstPrompt === undefined && line.includes('"user"')
    if (!wantsCwd && !wantsCreated && !wantsTitle && !wantsPrompt && !wantsFirstPrompt) continue
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
    if (entry.firstPrompt === undefined && rec?.type === 'user') {
      const first = promptText(rec)
      if (first) entry.firstPrompt = first // empty (a tool-result record) leaves it unset, so the next user record still counts
    }
  }
}

// Reads whatever has been appended to `file` since `prev` last looked, and returns the merged
// entry. The shrink/inode-replace reset rule lives in tailFile now; on a reset the fields folded
// out of the old file go with it, because they describe a file that no longer exists. The caller
// already statted the file (it needed the mtime anyway), so the stat rides along.
function scan(file: string, prev: CacheEntry | undefined, size: number, ino: number): CacheEntry {
  let entry = prev ?? freshEntry()
  const r = tailFile(entry.cursor, file, { size, ino })
  if (r === null) return entry // deleted or unreadable between readdir and here; keep what was already folded
  if (r.reset) entry = { cursor: entry.cursor } // tailFile zeroed the cursor; the fold restarts with it
  if (!r.text) return entry // nothing appended; the cached fold is still the answer
  fold(entry, entry.cursor.rest + r.text)
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
    // The filename minus .jsonl becomes the session id, and the id later reaches child argv
    // (`claude --resume <id>`) and raw stdout in `ls`. Anything a dispatched session could have
    // planted here — a `--flag.jsonl`, a name carrying an ESC byte — is not a session and is not
    // read at all (see session-id.ts). Claude Code's own ids are UUIDs, so this skips nothing real.
    const id = name.slice(0, -'.jsonl'.length)
    if (!SESSION_ID_RE.test(id)) continue
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
    const { cwd, aiTitle, lastPrompt, firstPrompt, createdAt } = entry
    // The folder name is a lossy hash of the path, so a transcript whose own cwd disagrees belongs
    // to a different directory that happens to encode the same way, and showing it under this one
    // would put another repo's session in this repo's group.
    if (cwd !== directory) continue
    out.push({
      id,
      directory,
      // #46: '' when even the opening prompt is unreadable, and it must stay '' rather than becoming
      // the id — an empty title is what marks the session as unnamed all the way to the store, where
      // a dispatch's provisional prompt is kept only while the reported title is a placeholder.
      title: aiTitle ?? lastPrompt ?? firstPrompt ?? '',
      updatedAt,
      createdAt: createdAt ?? 0,
    })
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}
