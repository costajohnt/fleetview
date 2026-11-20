// Discovery: reading ~/.claude/projects/ so the roster can show claude sessions fleetview never
// started, the way it shows opencode's. Claude Code owns this directory; nothing here writes to it.
import { readdirSync, statSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SESSION_ID_RE, assertSessionId } from '../session-id.ts'
import { newTailCursor, tailFile, type TailCursor } from '../tail.ts'
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
    if (rec.type === 'ai-title' && typeof rec.aiTitle === 'string') entry.aiTitle = rec.aiTitle
    if (rec.type === 'last-prompt' && typeof rec.lastPrompt === 'string') entry.lastPrompt = rec.lastPrompt
    if (entry.firstPrompt === undefined && rec.type === 'user') {
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
const TAIL_WINDOW = 1 << 20
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
