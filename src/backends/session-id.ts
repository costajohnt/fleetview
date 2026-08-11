// Session ids cross two trust boundaries: they become child-process argv (`claude --resume <id>`,
// `copilot --resume=<id>`, `opencode attach … -s <id>`) and they reach raw stdout in `ls`/`--json`.
// The claude ids are literally filenames another process wrote under ~/.claude/projects, so a
// dispatched session can mint one — `--someflag.jsonl` would make a later attach spawn
// `claude --resume --someflag` (argument injection), and an ESC byte in a filename would drive the
// terminal from a listing. One shape says no to both: no path separators, no control bytes, and —
// because the charset alone would still pass `--fork-session` — no leading dash, which is what
// makes a value flag syntax in the first place. Every real id across the three backends is a UUID
// or a `ses_…` token and starts alphanumeric, so nothing well-formed is rejected.
export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

// For the attach()/argv edge: discovery filters quietly (a hostile file is not a session), but an id
// that got this far anyway is a bug or an attack, and a thrown name beats a spawned flag.
export function assertSessionId(id: string): string {
  if (!SESSION_ID_RE.test(id)) throw new Error(`malformed session id refused: ${JSON.stringify(id.slice(0, 80))}`)
  return id
}
