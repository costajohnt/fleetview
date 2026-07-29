// Discovery: reading ~/.claude/projects/ so the roster can show claude sessions fleetview never
// started, the way it shows opencode's. Claude Code owns this directory; nothing here writes to it.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Only the fields the roster reads. The transcript records carry a great deal more (usage, parent
// uuids, attachments) and none of it survives this function.
export type ClaudeTranscript = {
  id: string
  directory: string
  title: string
  updatedAt: number
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
function scan(file: string): { cwd?: string; aiTitle?: string; lastPrompt?: string } {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return {} // deleted or unreadable between readdir and here; it simply isn't a session
  }
  const out: { cwd?: string; aiTitle?: string; lastPrompt?: string } = {}
  for (const line of raw.split('\n')) {
    // ai-title is rewritten as the session is re-titled, so the last one wins; cwd is the same on
    // every record, so the first is enough and the rest are skipped.
    const wantsCwd = out.cwd === undefined && line.includes('"cwd"')
    const wantsTitle = line.includes('"ai-title"')
    const wantsPrompt = line.includes('"last-prompt"')
    if (!wantsCwd && !wantsTitle && !wantsPrompt) continue
    let rec: any
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof rec?.cwd === 'string' && out.cwd === undefined) out.cwd = rec.cwd
    if (rec?.type === 'ai-title' && typeof rec.aiTitle === 'string') out.aiTitle = rec.aiTitle
    if (rec?.type === 'last-prompt' && typeof rec.lastPrompt === 'string') out.lastPrompt = rec.lastPrompt
  }
  return out
}

// What the last scan of a transcript found, keyed by project folder and then file name. events()
// calls listTranscripts every 500ms and scan() reads each transcript whole, so without this a
// directory with a few finished sessions re-read several megabytes twice a second forever. mtime
// *and* size, because a rewrite that happens to preserve one still moves the other; a transcript
// that moved neither cannot have changed what scan() would return.
type CacheEntry = { mtimeMs: number; size: number; scanned: ReturnType<typeof scan> }
const scanCache = new Map<string, Map<string, CacheEntry>>()

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
    try {
      const st = statSync(file)
      updatedAt = st.mtimeMs
      size = st.size
    } catch {
      continue
    }
    const cached = prev?.get(name)
    const scanned = cached?.mtimeMs === updatedAt && cached?.size === size ? cached.scanned : scan(file)
    fresh.set(name, { mtimeMs: updatedAt, size, scanned })
    const { cwd, aiTitle, lastPrompt } = scanned
    // The folder name is a lossy hash of the path, so a transcript whose own cwd disagrees belongs
    // to a different directory that happens to encode the same way, and showing it under this one
    // would put another repo's session in this repo's group.
    if (cwd !== directory) continue
    out.push({
      id: name.slice(0, -'.jsonl'.length),
      directory,
      title: aiTitle ?? lastPrompt ?? '',
      updatedAt,
    })
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}
