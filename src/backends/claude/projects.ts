// Discovery: reading ~/.claude/projects/ so the roster can show claude sessions fleetview never
// started, the way it shows opencode's. Claude Code owns this directory; nothing here writes to it.
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SESSION_ID_RE, assertSessionId } from '../session-id.ts'
import { newTailCursor, type TailCursor } from '../tail.ts'
import { isRecord, type OpencodeMessage, type Part } from '../../types.ts'

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
function promptText(rec: Record<string, unknown>): string {
  // isMeta records are claude's own boilerplate (the `<local-command-caveat>` preamble), not
  // something a person typed — 4 of those 78 open with one.
  if (rec.isMeta) return ''
  const content = isRecord(rec.message) ? rec.message.content : undefined
  const text =
    typeof content === 'string'
      ? content
      : // A user record can also carry tool results, which have no text block and leave this empty
        // so the scan keeps looking at the next user record rather than titling a row with a tool id.
        Array.isArray(content)
        ? content
            .flatMap((b) => (isRecord(b) && b.type === 'text' && typeof b.text === 'string' ? [b.text] : []))
            .join(' ')
        : ''
  return text.replace(/\s+/g, ' ').trim().slice(0, FIRST_PROMPT_CAP)
}

// What the last scan of a transcript found, plus how far it got. Keyed by project folder and then
// file name.
//
// #235: a scan reads only what a row needs, not the whole file. A long session's transcript runs to
// tens of MB (3.5GB across 264 transcripts in one folder here), and reading every one whole made
// `ls` and `logs` take 35s and 12s. The title records (ai-title, last-prompt) are the *last* ones,
// so they are searched for backwards from the end, and on every real transcript sat within 35KB of
// it; cwd, createdAt and the opening prompt are the *first* ones, so they are folded forwards from
// the start and the forward read stops once they are found. events() calls listTranscripts every
// 500ms, so both halves are incremental: an unchanged file is not read at all, and a grown one is
// searched only over the bytes appended since the last scan.
type CacheEntry = Scanned & {
  ino: number
  size: number // the file's size when last scanned: an unchanged size is a cache hit
  end: number // [0, end) has been searched for title records; always just past a '\n'
  head: TailCursor // the forward fold for the first-record fields
}
const scanCache = new Map<string, Map<string, CacheEntry>>()

const freshEntry = (ino: number): CacheEntry => ({ ino, size: 0, end: 0, head: newTailCursor() })

// Folds the records in `text` onto `entry`. Each line is substring-tested before it is parsed — the
// interesting records are a handful out of thousands, and JSON.parse on every line of every session
// was the difference between a listing that is free and one that is felt.
function fold(entry: Scanned, cursor: TailCursor, text: string) {
  const lines = text.split('\n')
  cursor.rest = lines.pop() ?? '' // partial trailing line: the next read completes it
  for (const line of lines) {
    // cwd is the same on every record and createdAt is the first record's, so both are immutable
    // once found and the rest of the file is skipped for them.
    const wantsCwd = entry.cwd === undefined && line.includes('"cwd"')
    const wantsCreated = entry.createdAt === undefined && line.includes('"timestamp"')
    // Only until one is found: the substring test matches every user record in the file, so the
    // parse this opens is paid once per transcript (claude's first record is a user record), not
    // once per line — the whole point of the tests above.
    const wantsFirstPrompt = entry.firstPrompt === undefined && line.includes('"user"')
    if (!wantsCwd && !wantsCreated && !wantsFirstPrompt) continue
    // A transcript line is whatever claude wrote; parsed, it is read through the same narrowing
    // every other dynamic payload gets rather than being trusted to have the fields below.
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    const rec: Record<string, unknown> = isRecord(record) ? record : {}
    if (typeof rec.cwd === 'string' && entry.cwd === undefined) entry.cwd = rec.cwd
    // Every transcript on this machine (33/33) carries an ISO timestamp on its first record. A
    // record that lacks one, or whose value doesn't parse, leaves createdAt unset and the caller
    // falls back to the mtime it always used.
    if (entry.createdAt === undefined && typeof rec.timestamp === 'string') {
      const parsed = Date.parse(rec.timestamp)
      if (Number.isFinite(parsed)) entry.createdAt = parsed
    }
    if (entry.firstPrompt === undefined && rec.type === 'user') {
      const first = promptText(rec)
      if (first) entry.firstPrompt = first // empty (a tool-result record) leaves it unset, so the next user record still counts
    }
  }
}

const NEWLINE = 0x0a
const AI_TITLE = Buffer.from('"ai-title"')
const LAST_PROMPT = Buffer.from('"last-prompt"')

// The `field` of the last complete line in buf[lo, hi) whose record is of `type`. Lines are found by
// a byte search for the quoted type, so nothing is decoded but the candidate lines themselves.
// ai-title is rewritten as the session is re-titled, so the last one wins.
function lastRecord(buf: Buffer, lo: number, hi: number, needle: Buffer, type: string, field: string): string | undefined {
  for (let at = hi - needle.length; at >= lo; at--) {
    at = buf.lastIndexOf(needle, at)
    if (at < lo) return undefined
    const start = buf.lastIndexOf(NEWLINE, at) + 1
    if (start < lo) return undefined // the match is in the cut-off line the window starts inside
    let rec: unknown
    try {
      rec = JSON.parse(buf.toString('utf8', start, buf.indexOf(NEWLINE, at)))
    } catch {
      continue
    }
    if (isRecord(rec) && rec.type === type && typeof rec[field] === 'string') return rec[field]
  }
  return undefined
}

const readAt = (fd: number, pos: number, len: number) => {
  const buf = Buffer.allocUnsafe(len)
  return buf.subarray(0, readSync(fd, buf, 0, len, pos))
}

// Starting window for both directions; the backward search grows it 4x until it finds an ai-title
// or reaches `from`, so a transcript that never got one is read once (plus a third) in all.
const SCAN_WINDOW = 64 << 10

// Searches [from, size) backwards for the last ai-title and last-prompt. `end` is just past the last
// complete line, which is where the next scan starts: a trailing partial line is left for the
// append that completes it, as the forward fold always did.
function scanTitles(fd: number, from: number, size: number): { end: number; aiTitle?: string; lastPrompt?: string } {
  for (let span = SCAN_WINDOW; ; span *= 4) {
    const start = Math.max(from, size - span)
    const buf = readAt(fd, start, size - start)
    const nl = buf.lastIndexOf(NEWLINE)
    if (nl >= 0) {
      // From mid-file, the window opens inside a line; `from` is always a line start.
      const lo = start === from ? 0 : buf.indexOf(NEWLINE) + 1
      const aiTitle = lastRecord(buf, lo, nl, AI_TITLE, 'ai-title', 'aiTitle')
      // Only the fallback while there is no ai-title, so the search stops at the first ai-title
      // even when no last-prompt has been seen yet.
      if (aiTitle !== undefined || start === from) {
        return { end: start + nl + 1, aiTitle, lastPrompt: lastRecord(buf, lo, nl, LAST_PROMPT, 'last-prompt', 'lastPrompt') }
      }
    } else if (start === from) return { end: from }
  }
}

// Brings `prev` up to date with `file`. A shrink or an inode change means the file was rewritten or
// replaced, and the fields found in the old one go with it. The caller already statted the file
// (it needed the mtime anyway), so the stat rides along.
function scan(file: string, prev: CacheEntry | undefined, size: number, ino: number): CacheEntry {
  const replaced = prev !== undefined && prev.ino !== 0 && ino !== 0 && prev.ino !== ino
  const entry = prev === undefined || replaced || size < prev.size ? freshEntry(ino) : prev
  if (size === entry.size) return entry // nothing appended; the cached scan is still the answer
  let fd: number
  try {
    fd = openSync(file, 'r')
  } catch {
    return entry // deleted or unreadable between readdir and here; keep what was already found
  }
  try {
    if (size > entry.end) {
      const t = scanTitles(fd, entry.end, size)
      // Found in the new bytes, it is later than anything found before; not found, the old answer stands.
      if (t.aiTitle !== undefined) entry.aiTitle = t.aiTitle
      if (t.lastPrompt !== undefined) entry.lastPrompt = t.lastPrompt
      entry.end = t.end
    }
    // The opening prompt is only the title when there is neither record, so it is only looked for then.
    const wants = () => entry.cwd === undefined || entry.createdAt === undefined || (entry.firstPrompt === undefined && entry.aiTitle === undefined && entry.lastPrompt === undefined)
    while (wants() && entry.head.offset < entry.end) {
      const chunk = readAt(fd, entry.head.offset, Math.min(SCAN_WINDOW, entry.end - entry.head.offset))
      if (chunk.length === 0) break
      entry.head.offset += chunk.length
      fold(entry, entry.head, entry.head.rest + entry.head.decoder.decode(chunk, { stream: true }))
    }
    entry.size = size
  } catch {
    // unreadable between open and here; size is left behind so the next poll tries again
  } finally {
    try {
      closeSync(fd)
    } catch {
      // a listing never throws over one file (tailFile's rule); the fd is gone either way
    }
  }
  return entry
}

// Sessions Claude Code has recorded for `directory`, newest first. The mtime is the only freshness
// signal there is: a transcript carries no marker saying its session is still running, so a
// discovered session's liveness is an inference and the caller has to treat it as one.
//
// `idPrefix` narrows the listing to sessions whose id starts with it (#235: resolving an id for
// `logs`/`attach`/`stop` reads that transcript, not the folder's every other one). The cache keeps
// the entries a narrowed listing didn't look at.
export function listTranscripts(directory: string, { home = homedir(), idPrefix }: { home?: string; idPrefix?: string } = {}): ClaudeTranscript[] {
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
  const fresh = idPrefix === undefined ? new Map<string, CacheEntry>() : new Map(prev)
  scanCache.set(dir, fresh)
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    // The filename minus .jsonl becomes the session id, and the id later reaches child argv
    // (`claude --resume <id>`) and raw stdout in `ls`. Anything a dispatched session could have
    // planted here — a `--flag.jsonl`, a name carrying an ESC byte — is not a session and is not
    // read at all (see session-id.ts). Claude Code's own ids are UUIDs, so this skips nothing real.
    const id = name.slice(0, -'.jsonl'.length)
    if (!SESSION_ID_RE.test(id)) continue
    if (idPrefix !== undefined && !id.startsWith(idPrefix)) continue
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

// #233: a transcript as the {info, parts} messages peek and `fleetview logs` render, so a claude row
// reads like an opencode one. The format is not a published API (verified against claude 2.1.x on
// real transcripts), so this keeps only what it recognises: user text, assistant text, and each
// tool call summarised as a one-line tool part. Every other record type (attachments, titles, api
// request blobs, system notes, queue bookkeeping) and anything unparseable is skipped, never thrown.
//
// Claude writes one content block per assistant record, so the records of one API response share a
// message.id and are folded back into one message — the unit opencode lists. A tool's result arrives
// in the next user record and is attached to the tool part that asked for it.

// What opencode 2.x's listMessages asks its server for (client-v2.ts `?limit=200`), so the two
// backends hand peek and logs the same depth of history.
export const TRANSCRIPT_MESSAGES = 200
// One tool line's cap: a summary, not the output. A full `cat` of a file is not a log line.
const TOOL_SUMMARY_CAP = 200
// Claude Code's own injections that arrive as user records with no flag on them: captured command
// output, background-task notifications, and messages from a team lead agent. None of it was typed.
const INJECTED_RE = /^<(local-command-|task-notification|system-reminder|teammate-message|bash-stdout|bash-stderr)/
// A slash command the user typed is recorded as tags, not as the text they typed; it is rebuilt.
const COMMAND_RE = /<command-name>([^<]*)<\/command-name>/
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/
// What claude writes as a user record when the user stops a turn. Mapped to the abort shape
// (session-store isAbortError) so peek and logs say `stopped`, as they do for opencode.
const INTERRUPT_RE = /^\[Request interrupted by user/

function userLine(text: string): string {
  const t = text.trimStart()
  const command = COMMAND_RE.exec(t)
  if (command) return `${command[1]} ${COMMAND_ARGS_RE.exec(t)?.[1] ?? ''}`.trim()
  return t.trim() && !INJECTED_RE.test(t) ? text : ''
}

const blocks = (content: unknown): Record<string, unknown>[] =>
  typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content.filter(isRecord) : []

const textOf = (b: Record<string, unknown>) => (b.type === 'text' && typeof b.text === 'string' ? b.text : '')

function toolSummary(name: string, result: Record<string, unknown>): string {
  const first = blocks(result.content).map(textOf).join('\n').split('\n').find((l) => l.trim()) ?? ''
  const line = first.trim().slice(0, TOOL_SUMMARY_CAP)
  const head = result.is_error === true ? `${name} failed` : name
  return line ? `${head}: ${line}` : head
}

// Maps already-split transcript lines to messages, oldest first. Pure, for tests.
export function transcriptMessages(lines: string[]): OpencodeMessage[] {
  const out: OpencodeMessage[] = []
  const tools = new Map<string, Part>() // tool_use id → its part, for the result that follows
  for (const line of lines) {
    // Substring-tested before parsing, as in fold(): most lines of a long transcript are records
    // this never renders, and some (api-request-blob) are large.
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue
    let rec: unknown
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(rec) || !isRecord(rec.message)) continue
    // Sidechains are subagent turns, meta records are claude's own boilerplate, and a compact
    // summary is claude restating the session to itself.
    if (rec.isSidechain === true || rec.isMeta === true || rec.isCompactSummary === true || rec.isVisibleInTranscriptOnly === true) continue
    const content = blocks(rec.message.content)
    if (rec.type === 'assistant') {
      const id = typeof rec.message.id === 'string' ? rec.message.id : undefined
      const last = out.at(-1)
      const msg: OpencodeMessage =
        last?.info?.role === 'assistant' && id !== undefined && last.info.id === id ? last : { info: { id, role: 'assistant' }, parts: [] }
      const parts = msg.parts ?? []
      // A synthetic error turn (rate limit, server error) carries its reason as text; it is the
      // turn's error, which peek and logs already render as one.
      if (rec.isApiErrorMessage === true) {
        msg.info = { ...msg.info, error: content.map(textOf).join(' ') || 'API error' }
      } else {
        for (const b of content) {
          if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) parts.push({ type: 'text', text: b.text })
          else if (b.type === 'tool_use' && typeof b.id === 'string') {
            const name = typeof b.name === 'string' ? b.name : 'tool'
            const part: Part = { type: 'tool', tool: name, state: { status: 'running', output: name } }
            tools.set(b.id, part)
            parts.push(part)
          }
          // thinking, and any block type this doesn't know: skipped
        }
      }
      msg.parts = parts
      if (msg !== last && (parts.length || msg.info?.error)) out.push(msg)
    } else if (rec.type === 'user') {
      // An origin that isn't a person (a peer agent's message, a task notification) is not the user.
      if (isRecord(rec.origin) && rec.origin.kind !== undefined && rec.origin.kind !== 'human') continue
      for (const b of content) {
        if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue
        const part = tools.get(b.tool_use_id)
        // A result whose call fell outside the window read has nothing to attach to.
        if (!part) continue
        const name = typeof part.tool === 'string' ? part.tool : 'tool'
        part.state = { status: b.is_error === true ? 'error' : 'completed', output: toolSummary(name, b) }
      }
      // After the results above: an interrupt record can carry the result of the call it stopped.
      const texts = content.map(textOf)
      if (texts.some((t) => INTERRUPT_RE.test(t))) {
        out.push({ info: { role: 'assistant', error: { name: 'aborted' } }, parts: [] })
        continue
      }
      const text = texts.map(userLine).filter(Boolean).join('\n')
      if (text) out.push({ info: { role: 'user' }, parts: [{ type: 'text', text }] })
    }
  }
  return out
}

// Starting window for reading a transcript from its end; grown 4x until enough messages are found,
// the whole file has been read, or MAX_WINDOW is reached. Tool results make a long session's
// messages large (real 10MB transcripts hold under 200), so without the ceiling most peeks would
// parse the whole file on the event loop.
// ponytail: past 16MB the oldest messages are left out even for `logs --all`; a backwards
// incremental reader lifts that if anyone needs the full history of a huge session.
export const TAIL_WINDOW = 1 << 20
const MAX_WINDOW = 16 << 20

// The last `limit` messages of session `id`'s transcript in `directory`. A transcript that doesn't
// exist yet (a dispatch claude hasn't written to) is an empty session, not a failure; any other read
// error rejects, so peek and logs report it rather than showing an empty session.
export async function readTranscriptMessages(
  id: string,
  directory: string,
  { home = homedir(), limit = TRANSCRIPT_MESSAGES, window = TAIL_WINDOW }: { home?: string; limit?: number; window?: number } = {},
): Promise<OpencodeMessage[]> {
  // The id becomes a path: a malformed one is refused before it can name another file.
  assertSessionId(id)
  const file = join(projectsDir(home), encodeProjectDir(directory), `${id}.jsonl`)
  let fd
  try {
    fd = await open(file, 'r')
  } catch (e) {
    if (isRecord(e) && e.code === 'ENOENT') return []
    throw e
  }
  try {
    const { size } = await fd.stat()
    for (let span = window; ; span *= 4) {
      const start = Math.max(0, size - span)
      const buf = Buffer.alloc(size - start)
      const { bytesRead } = await fd.read(buf, 0, buf.length, start)
      const lines = buf.subarray(0, bytesRead).toString('utf8').split('\n')
      // Read from mid-file, the first line is the tail of a record cut in half.
      if (start > 0) lines.shift()
      const messages = transcriptMessages(lines)
      if (messages.length >= limit || start === 0 || span >= MAX_WINDOW) return messages.slice(-limit)
    }
  } finally {
    await fd.close()
  }
}
