import { test, expect, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, symlinkSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { makeEnsureServer, makePersistSeen, editPrompt, listSessions, looksLikeOpencodeServer, matchSessions, runBg, runServer, RESTORE_SCREEN, RESET_INPUT_MODES } from '../src/cli.ts'
import { MOUSE_OFF } from '../src/ui/mouse.ts'

// #57: the exit/signal path (restoreScreen, registered on `exit` and reached from SIGTERM/HUP/INT)
// used to put back only the screen, leaving bracketed paste, focus reporting, DECCKM, modifyOtherKeys
// and any kitty stack entry on in the shell fleetview hands back.
test('restoreScreen puts back the input modes as well as the mouse, cursor and alternate screen', () => {
  const written: string[] = []
  const restoreScreen = () => written.push(RESTORE_SCREEN) // exactly what runRoster writes to stdout
  restoreScreen()
  const out = written.join('')
  expect(out.startsWith(MOUSE_OFF)).toBe(true)
  expect(out).toContain(RESET_INPUT_MODES)
  expect(out).toContain('\x1b[?2004l') // bracketed paste
  expect(out).toContain('\x1b[?1004l') // focus reporting
  expect(out).toContain('\x1b[?1l') // DECCKM (application cursor keys)
  expect(out).toContain('\x1b[>4;0m') // modifyOtherKeys
  expect(out).toContain('\x1b[<u') // kitty keyboard stack pop
  expect(out.endsWith('\x1b[?25h\x1b[?1049l')).toBe(true)
})

const server = { host: '127.0.0.1', port: 4900, pid: null }

test('healthy server → {ok:true, same server}, no spawn', async () => {
  const deps = { isServerHealthy: () => Promise.resolve(true), spawnServer: () => { throw new Error('should not spawn') }, saveServer: () => { throw new Error('should not save') }, serverFile: '/tmp/s.json' }
  expect(await makeEnsureServer(deps as any)(server)).toEqual({ ok: true, server })
})

test('adopting a healthy server that does not enforce a set password warns once', async () => {
  const warn = vi.fn()
  const deps = {
    isServerHealthy: () => Promise.resolve(true),
    isAuthEnforced: () => Promise.resolve(false),
    spawnServer: () => { throw new Error('should not spawn') },
    saveServer: () => {},
    serverFile: '/tmp/s.json',
    warn,
  }
  expect(await makeEnsureServer(deps as any)(server)).toEqual({ ok: true, server })
  expect(warn).toHaveBeenCalledOnce()
  expect(warn.mock.calls[0][0]).toMatch(/OPENCODE_SERVER_PASSWORD/)
})

test('adopting a healthy server that enforces auth does not warn', async () => {
  const warn = vi.fn()
  const deps = {
    isServerHealthy: () => Promise.resolve(true),
    isAuthEnforced: () => Promise.resolve(true),
    spawnServer: () => { throw new Error('should not spawn') },
    saveServer: () => {},
    serverFile: '/tmp/s.json',
    warn,
  }
  await makeEnsureServer(deps as any)(server)
  expect(warn).not.toHaveBeenCalled()
})

test('dead server → spawn, save pid, poll until healthy → {ok:true, the ref that was spawned}', async () => {
  let calls = 0
  const saved: any[] = []
  const deps = {
    isServerHealthy: () => Promise.resolve(++calls > 2), // healthy on 3rd poll
    spawnServer: () => 777,
    saveServer: (file: any, s: any) => saved.push([file, s]),
    serverFile: '/tmp/s.json',
    pollMs: 1,
    env: { OPENCODE_SERVER_PASSWORD: 'set-by-user' },
  }
  // H2: the ref that comes back is the one that was spawned, pid and all — App re-invokes
  // ensureServer with it on recovery, and anything missing here is missing from server.json after.
  expect(await makeEnsureServer(deps as any)(server)).toEqual({ ok: true, server: { ...server, pid: 777 } })
  // Saved twice on purpose: once before the spawn (a crash in between must not strand the server),
  // once with the pid. User-set password is never copied to disk either time.
  expect(saved).toEqual([
    ['/tmp/s.json', { ...server, pid: null }],
    ['/tmp/s.json', { ...server, pid: 777 }],
  ])
})

// M11: the server fleetview spawns has an arbitrary-shell route and outlives fleetview, so it must
// not come up unauthenticated just because the user never opted in to OPENCODE_SERVER_PASSWORD.
test('spawning a server with no password set mints one, hands it to the child env, and persists it', async () => {
  const saved: any[] = []
  const spawned: any[] = []
  const env: NodeJS.ProcessEnv = {}
  const deps = {
    isServerHealthy: () => Promise.resolve(spawned.length > 0),
    spawnServer: (s: any) => (spawned.push(s), 777),
    saveServer: (file: any, s: any) => saved.push([file, s]),
    serverFile: '/tmp/s.json',
    pollMs: 1,
    env,
  }
  await makeEnsureServer(deps as any)(server)
  const password = env.OPENCODE_SERVER_PASSWORD
  expect(password).toMatch(/^[0-9a-f-]{36}$/) // the child inherits process.env, so setting it here is what arms the server
  // The password-bearing record lands before the spawn, then again with the pid: a crash in the gap
  // used to leave a detached armed server whose password existed only in a dead process's env.
  expect(saved).toEqual([
    ['/tmp/s.json', { ...server, password, pid: null }],
    ['/tmp/s.json', { ...server, password, pid: 777 }],
  ])
})

// H2: App re-invokes ensureServer with the ref it was handed when a poll tick fails. If that ref is
// the password-less original, the respawn rewrites server.json without the password while the child
// still enforces it — the next fresh run can never reach that server again.
test('a recovery re-entry with the returned ref keeps the minted password on disk', async () => {
  const env: NodeJS.ProcessEnv = {}
  const saved: any[] = []
  let alive = false
  const deps = {
    isServerHealthy: () => Promise.resolve(alive),
    spawnServer: () => ((alive = true), 777),
    saveServer: (_file: any, s: any) => saved.push(s),
    serverFile: '/tmp/s.json',
    pollMs: 1,
    env,
  }
  const ensureServer = makeEnsureServer(deps as any)
  const first = await ensureServer(server)
  const password = env.OPENCODE_SERVER_PASSWORD
  expect(first.server!.password).toBe(password)
  alive = false // the server dies mid-run; App re-enters with the ref it is holding
  const again = await ensureServer(first.server!)
  expect(again.ok).toBe(true)
  expect(saved.at(-1).password).toBe(password)
})

// M2: a foreign passwordless opencode that got the port first answers the authenticated probe 200
// all the same. Persisting a password for it would make the next run trust a credential that
// protects nothing — and it is exactly the server whose shell route is wide open.
test('a spawn onto a server that does not enforce the minted password is persisted without it, with a warning', async () => {
  const env: NodeJS.ProcessEnv = {}
  const saved: any[] = []
  const warn = vi.fn()
  let probes = 0
  const deps = {
    isServerHealthy: () => Promise.resolve(probes++ > 0), // dead at the gate, healthy on the first poll
    isAuthEnforced: () => Promise.resolve(false),
    spawnServer: () => 777,
    saveServer: (_file: any, s: any) => saved.push(s),
    serverFile: '/tmp/s.json',
    pollMs: 1,
    warn,
    env,
  }
  const result = await makeEnsureServer(deps as any)(server)
  expect(result).toEqual({ ok: true, server: { ...server, pid: 777 } })
  expect(saved.at(-1)).toEqual({ ...server, pid: 777 }) // no password field for a server enforcing none
  expect(warn.mock.calls[0][0]).toMatch(/does not require OPENCODE_SERVER_PASSWORD/)
})

// M4: the user set their own password over a server fleetview started with a generated one. The
// probe 401s under theirs, and respawning would fail to bind, walk the fallback ports and leave the
// running server orphaned on this one with its shell route alive under a password nobody holds.
test('a user-set password over a still-running fleetview server re-probes with the saved one instead of respawning', async () => {
  const env: NodeJS.ProcessEnv = { OPENCODE_SERVER_PASSWORD: 'set-by-user' }
  const warn = vi.fn()
  const deps = {
    isServerHealthy: () => Promise.resolve(env.OPENCODE_SERVER_PASSWORD === 'generated-earlier'),
    spawnServer: () => { throw new Error('should not spawn') },
    saveServer: () => { throw new Error('should not save') },
    serverFile: '/tmp/s.json',
    pollMs: 1,
    warn,
    env,
  }
  const stored = { ...server, password: 'generated-earlier' }
  expect(await makeEnsureServer(deps as any)(stored)).toEqual({ ok: true, server: stored })
  expect(warn.mock.calls[0][0]).toMatch(/different password/)
  expect(env.OPENCODE_SERVER_PASSWORD).toBe('generated-earlier') // every later request has to use the one it enforces
})

test('a genuinely dead server with a stale saved password still respawns, under the user password and without the stale one', async () => {
  const env: NodeJS.ProcessEnv = { OPENCODE_SERVER_PASSWORD: 'set-by-user' }
  const saved: any[] = []
  const spawned: any[] = []
  const deps = {
    isServerHealthy: () => Promise.resolve(spawned.length > 0),
    spawnServer: (s: any) => (spawned.push(s), 777),
    saveServer: (_file: any, s: any) => saved.push(s),
    serverFile: '/tmp/s.json',
    pollMs: 1,
    env,
  }
  const result = await makeEnsureServer(deps as any)({ ...server, password: 'generated-earlier' })
  expect(result).toEqual({ ok: true, server: { ...server, pid: 777 } })
  expect(saved.at(-1).password).toBeUndefined()
  expect(env.OPENCODE_SERVER_PASSWORD).toBe('set-by-user') // restored after the re-probe failed
})

// A 401 is an answer: something holds that port and enforces a password fleetview doesn't have, so
// a spawn there could never bind. Walking on is better than burning the poll window on a doomed child.
test('a port answering 401 is left alone rather than spawned onto', async () => {
  const spawned: any[] = []
  const warn = vi.fn()
  const deps = {
    isServerHealthy: (s: any) => Promise.resolve(s.port !== 4900 && spawned.length > 0),
    probeServer: (s: any) => Promise.resolve(s.port === 4900 ? 'unauthorized' : 'unreachable'),
    spawnServer: (s: any) => (spawned.push(s), 777),
    saveServer: () => {},
    serverFile: '/tmp/s.json',
    pollMs: 1,
    spawnSyncImpl: () => ({}),
    warn,
    env: { OPENCODE_SERVER_PASSWORD: 'set-by-user' } as NodeJS.ProcessEnv,
  }
  const result = await makeEnsureServer(deps as any)(server)
  expect(result).toEqual({ ok: true, server: { ...server, port: 4901, pid: 777 } })
  expect(spawned.map((s) => s.port)).toEqual([4901]) // never spawned onto the occupied port
  expect(warn.mock.calls[0][0]).toMatch(/rejecting fleetview's password/)
})

// SEC1: a saved password the port's occupant rejected has been shown to that occupant, and belongs
// to a server that is evidently gone. Carrying it onto the replacement would arm the new server with
// a credential the rejecting listener already holds.
test('a saved password rejected by whatever holds the port is not reused for the replacement', async () => {
  const spawned: any[] = []
  const saved: any[] = []
  const env: NodeJS.ProcessEnv = {}
  const deps = {
    isServerHealthy: (s: any) => Promise.resolve(s.port !== 4900 && spawned.length > 0),
    probeServer: (s: any) => Promise.resolve(s.port === 4900 ? 'unauthorized' : 'unreachable'),
    spawnServer: (s: any) => (spawned.push(s), 777),
    saveServer: (_file: any, s: any) => saved.push(s),
    serverFile: '/tmp/s.json',
    pollMs: 1,
    spawnSyncImpl: () => ({}),
    warn: vi.fn(),
    notice: vi.fn(),
    env,
  }
  const result = await makeEnsureServer(deps as any)({ ...server, password: 'from-server-json' })
  expect(result.ok).toBe(true)
  expect(env.OPENCODE_SERVER_PASSWORD).not.toBe('from-server-json')
  expect(env.OPENCODE_SERVER_PASSWORD).toMatch(/^[0-9a-f-]{36}$/)
  expect(spawned.every((s) => s.password === env.OPENCODE_SERVER_PASSWORD)).toBe(true)
  expect(saved.at(-1).password).toBe(env.OPENCODE_SERVER_PASSWORD)
})

// The counterpart: a password the USER set is theirs, not something fleetview adopted from disk, so a
// 401 under it is not evidence it was leaked — the existing M4 handling still applies.
test('a user-set password is not burned by a 401 on the configured port', async () => {
  const spawned: any[] = []
  const env: NodeJS.ProcessEnv = { OPENCODE_SERVER_PASSWORD: 'set-by-user' }
  const deps = {
    isServerHealthy: (s: any) => Promise.resolve(s.port !== 4900 && spawned.length > 0),
    probeServer: (s: any) => Promise.resolve(s.port === 4900 ? 'unauthorized' : 'unreachable'),
    spawnServer: (s: any) => (spawned.push(s), 777),
    saveServer: () => {},
    serverFile: '/tmp/s.json',
    pollMs: 1,
    spawnSyncImpl: () => ({}),
    warn: vi.fn(),
    notice: vi.fn(),
    env,
  }
  await makeEnsureServer(deps as any)(server)
  expect(env.OPENCODE_SERVER_PASSWORD).toBe('set-by-user')
})

// SEC2: adopting a server fleetview didn't spawn is supported, but it is also the only moment a
// squatted port is visible to the user — so it gets one informational line, once.
test('adopting a server fleetview did not spawn says so, once', async () => {
  const notice = vi.fn()
  const deps = {
    isServerHealthy: () => Promise.resolve(true),
    isAuthEnforced: () => Promise.resolve(true),
    spawnServer: () => { throw new Error('should not spawn') },
    saveServer: () => {},
    serverFile: '/tmp/s.json',
    identifyServer: () => ({ ok: false, reason: 'no such process' }),
    notice,
    env: { OPENCODE_SERVER_PASSWORD: 'set-by-user' } as NodeJS.ProcessEnv,
  }
  const ensure = makeEnsureServer(deps as any)
  await ensure(server)
  await ensure(server) // the roster loop re-runs this every iteration; the notice must not repeat
  expect(notice).toHaveBeenCalledOnce()
  expect(notice.mock.calls[0][0]).toMatch(/already running on 127\.0\.0\.1:4900/)
  expect(notice.mock.calls[0][0]).not.toMatch(/OPENCODE_SERVER_PASSWORD/) // a password IS set; nothing to say about it
})

// isAuthEnforced returns true when no password is set — nothing is being ignored — which left the
// configuration where adoption is most likely and least protected completely silent.
test('the adoption notice names the no-password case rather than staying silent', async () => {
  const notice = vi.fn()
  const deps = {
    isServerHealthy: () => Promise.resolve(true),
    isAuthEnforced: () => Promise.resolve(true),
    spawnServer: () => { throw new Error('should not spawn') },
    saveServer: () => {},
    serverFile: '/tmp/s.json',
    identifyServer: () => ({ ok: false, reason: 'no such process' }),
    notice,
    env: {} as NodeJS.ProcessEnv,
  }
  await makeEnsureServer(deps as any)(server)
  expect(notice.mock.calls[0][0]).toMatch(/No OPENCODE_SERVER_PASSWORD is set/)
})

test('reusing fleetview’s own still-running server is not announced as a foreign adoption', async () => {
  const notice = vi.fn()
  const deps = {
    isServerHealthy: () => Promise.resolve(true),
    isAuthEnforced: () => Promise.resolve(true),
    spawnServer: () => { throw new Error('should not spawn') },
    saveServer: () => {},
    serverFile: '/tmp/s.json',
    identifyServer: (pid: number) => ({ ok: pid === 777, command: 'opencode serve' }),
    notice,
    env: {} as NodeJS.ProcessEnv,
  }
  await makeEnsureServer(deps as any)({ ...server, pid: 777 })
  expect(notice).not.toHaveBeenCalled()
})

test('a password persisted for a still-running spawned server is adopted before the health probe', async () => {
  const env: NodeJS.ProcessEnv = {}
  const deps = {
    isServerHealthy: () => Promise.resolve(true),
    spawnServer: () => { throw new Error('should not spawn') },
    saveServer: () => { throw new Error('should not save') },
    serverFile: '/tmp/s.json',
    env,
  }
  const stored = { ...server, password: 'from-server-json' }
  expect(await makeEnsureServer(deps as any)(stored)).toEqual({ ok: true, server: stored })
  expect(env.OPENCODE_SERVER_PASSWORD).toBe('from-server-json')
})

// The password is minted once, before the configured port is tried, and the fallback walk carries it
// onto every candidate. A fallback that dropped it would persist a server.json with no password for
// a child that is nonetheless enforcing one, and the next run would read its own 401 as "dead".
test('a minted password survives onto the fallback-port save', async () => {
  const saved: any[] = []
  const env: NodeJS.ProcessEnv = {}
  const deps = {
    isServerHealthy: (s: any) => Promise.resolve(s.port === server.port + 1),
    spawnServer: () => 777,
    saveServer: (file: any, s: any) => saved.push(s),
    serverFile: '/tmp/s.json',
    pollMs: 1,
    spawnSyncImpl: () => ({}),
    env,
  }
  await makeEnsureServer(deps as any)(server)
  const password = env.OPENCODE_SERVER_PASSWORD
  expect(password).toMatch(/^[0-9a-f-]{36}$/)
  expect(saved.at(-1)).toMatchObject({ port: server.port + 1, password })
})

// The stored password is a fallback for a server fleetview spawned and forgot about, not an
// override: a user who exported OPENCODE_SERVER_PASSWORD is pointing fleetview at their own server,
// and quietly swapping in a stale generated one would send the wrong credential.
test('a stored password does not clobber a password the user set in the environment', async () => {
  const env: NodeJS.ProcessEnv = { OPENCODE_SERVER_PASSWORD: 'set-by-user' }
  const deps = {
    isServerHealthy: () => Promise.resolve(true),
    spawnServer: () => { throw new Error('should not spawn') },
    saveServer: () => { throw new Error('should not save') },
    serverFile: '/tmp/s.json',
    env,
  }
  await makeEnsureServer(deps as any)({ ...server, password: 'from-server-json' })
  expect(env.OPENCODE_SERVER_PASSWORD).toBe('set-by-user')
})

test('adopting an externally started passwordless server mints nothing', async () => {
  const env: NodeJS.ProcessEnv = {}
  const deps = {
    isServerHealthy: () => Promise.resolve(true),
    spawnServer: () => { throw new Error('should not spawn') },
    saveServer: () => { throw new Error('should not save') },
    serverFile: '/tmp/s.json',
    env,
  }
  expect(await makeEnsureServer(deps as any)(server)).toEqual({ ok: true, server })
  expect(env.OPENCODE_SERVER_PASSWORD).toBeUndefined()
})

test('spawn that never becomes healthy, no fallback candidate works → {ok:false, reason} after poll window exhausted', async () => {
  const deps = {
    isServerHealthy: () => Promise.resolve(false),
    spawnServer: () => 777,
    saveServer: () => {},
    serverFile: '/tmp/s.json',
    pollMs: 1,
    spawnSyncImpl: () => ({}), // opencode --version succeeds — not an install problem
  }
  expect(await makeEnsureServer(deps as any)(server)).toEqual({ ok: false, server, reason: 'server did not become healthy' })
})

test('reap: initial candidate poll timeout kills its pid before the fallback walk (Important 2)', async () => {
  const killed: any[] = []
  const deps = {
    isServerHealthy: () => Promise.resolve(false),
    spawnServer: () => 777,
    saveServer: () => {},
    serverFile: '/tmp/s.json',
    pollMs: 1,
    processKill: (pid: any, sig: any) => killed.push([pid, sig]),
    spawnSyncImpl: () => ({}),
  }
  await makeEnsureServer(deps as any)(server)
  expect(killed[0]).toEqual([777, 'SIGTERM'])
})

test('reap: a failed fallback candidate is killed before trying the next one (Important 2)', async () => {
  const killed: any[] = []
  let spawnCalls = 0
  const deps = {
    isServerHealthy: () => Promise.resolve(false),
    spawnServer: () => { spawnCalls += 1; return 700 + spawnCalls },
    saveServer: () => {},
    serverFile: '/tmp/s.json',
    pollMs: 1,
    processKill: (pid: any, sig: any) => killed.push([pid, sig]),
    spawnSyncImpl: () => ({}),
  }
  await makeEnsureServer(deps as any)(server)
  // initial pid (701) + 10 fallback candidates (702..711) all reaped
  expect(killed).toEqual([701, 702, 703, 704, 705, 706, 707, 708, 709, 710, 711].map((pid) => [pid, 'SIGTERM']))
})

test('reap: processKill throwing (already-dead pid) does not crash ensureServer', async () => {
  const deps = {
    isServerHealthy: () => Promise.resolve(false),
    spawnServer: () => 777,
    saveServer: () => {},
    serverFile: '/tmp/s.json',
    pollMs: 1,
    processKill: () => { throw new Error('ESRCH') },
    spawnSyncImpl: () => ({}),
  }
  await expect(makeEnsureServer(deps as any)(server)).resolves.toEqual({ ok: false, server, reason: 'server did not become healthy' })
})

test('ENOENT (opencode not installed) short-circuits the fallback walk (Minor 3)', async () => {
  let spawnCalls = 0
  const deps = {
    isServerHealthy: () => Promise.resolve(false),
    spawnServer: () => { spawnCalls += 1; return 777 },
    saveServer: () => {},
    serverFile: '/tmp/s.json',
    pollMs: 1,
    spawnSyncImpl: () => ({ error: { code: 'ENOENT' } }),
  }
  const result = await makeEnsureServer(deps as any)(server)
  expect(result.ok).toBe(false)
  expect(result.reason).toMatch(/not installed/)
  expect(spawnCalls).toBe(1) // only the initial spawn — no fallback candidates spawned
})

// --- `server stop`: the pid in server.json is a claim, not a fact ---

test('a pid whose command line is the opencode server is signalled', () => {
  const spawnSyncImpl = vi.fn(() => ({ status: 0, stdout: '/opt/homebrew/bin/opencode serve --port 4900 --hostname 127.0.0.1\n' }))
  expect(looksLikeOpencodeServer(4242, { spawnSyncImpl } as any)).toEqual({
    ok: true,
    command: '/opt/homebrew/bin/opencode serve --port 4900 --hostname 127.0.0.1',
  })
  expect(spawnSyncImpl).toHaveBeenCalledWith('ps', ['-o', 'command=', '-p', '4242'], { encoding: 'utf8' })
})

test('a recycled pid running something else is refused, and the refusal names what it found', () => {
  const spawnSyncImpl = () => ({ status: 0, stdout: 'vim src/app.js\n' })
  expect(looksLikeOpencodeServer(4242, { spawnSyncImpl } as any)).toEqual({ ok: false, reason: 'vim src/app.js' })
})

// An interactive opencode holding the recycled pid is still not the thing `server stop` is for.
test('an opencode that is not `serve` is refused', () => {
  const spawnSyncImpl = () => ({ status: 0, stdout: 'opencode attach http://127.0.0.1:4900 -s ses_1\n' })
  expect(looksLikeOpencodeServer(4242, { spawnSyncImpl } as any).ok).toBe(false)
})

test('a dead pid (ps exits non-zero) and a missing ps both refuse rather than signal', () => {
  expect(looksLikeOpencodeServer(4242, { spawnSyncImpl: () => ({ status: 1, stdout: '' }) } as any)).toEqual({ ok: false, reason: 'no such process' })
  expect(looksLikeOpencodeServer(4242, { spawnSyncImpl: () => ({ error: new Error('ENOENT') }) } as any)).toEqual({ ok: false, reason: 'no such process' })
})

// The refusal quotes another process's argv to the user's terminal, so it gets the same treatment
// as every other foreign string here: an OSC in a planted argv must not drive the terminal.
test('the refusal strips control bytes out of the command line it quotes', () => {
  const spawnSyncImpl = () => ({ status: 0, stdout: `evil\u001B]0;pwned\u0007 --flag\n` })
  const result = looksLikeOpencodeServer(4242, { spawnSyncImpl } as any)
  expect(result.ok).toBe(false)
  expect(result.reason).toBe('evil]0;pwned --flag')
})

// --- `fleetview bg`: dispatch without opening the roster ---

// Every call the dispatch makes lands in `calls` in order, because "renamed after the session
// exists" and "never created at all" are the two things most of these tests are about.
const bgHarness = ({ createSession, ...clientOverrides }: any = {}) => {
  const calls: any[] = []
  const record = (name: any, fn?: any) => (...a: any[]) => {
    calls.push([name, ...a])
    return fn ? fn(...a) : Promise.resolve()
  }
  const client = {
    createSession: record('createSession', createSession ?? (() => Promise.resolve({ id: 'ses_new' }))),
    renameSession: record('renameSession'),
    runShell: record('runShell'),
    promptAsync: record('promptAsync'),
    ...clientOverrides,
  }
  const saved: any[] = []
  const out: any[] = []
  const errs: any[] = []
  const codes: any[] = []
  const deps = {
    ensureServer: vi.fn(() => Promise.resolve({ ok: true, server: { host: '127.0.0.1', port: 4900 } })),
    serverFile: '/tmp/s.json',
    loadServerImpl: () => null,
    createClient: vi.fn(() => client),
    realpath: (p: any) => (p === '/link' ? '/real/repo' : p), // stands in for realpathSync: a symlinked cwd must resolve
    rosterFile: '/tmp/roster.json',
    loadRosterImpl: () => ({ groupBy: 'state', sessions: [], collapsed: [] }),
    saveRosterImpl: (file: any, roster: any) => saved.push([file, roster]),
    now: () => 1_700_000_000_000,
    log: (m: any) => out.push(m),
    error: (m: any) => errs.push(m),
    setExitCode: (c: any) => codes.push(c),
  }
  return { calls, saved, out, errs, codes, deps }
}

test('bg creates a session in the resolved cwd, prompts it, joins the roster and prints the id', async () => {
  const h = bgHarness()
  await runBg({ command: 'bg', prompt: 'ship it', cwd: '/link' }, h.deps)
  expect(h.deps.createClient).toHaveBeenCalledWith('http://127.0.0.1:4900')
  expect(h.calls).toEqual([
    ['createSession', { agent: undefined, model: undefined }, '/real/repo'],
    ['promptAsync', 'ses_new', 'ship it', '/real/repo'],
  ])
  expect(h.saved).toEqual([[
    '/tmp/roster.json',
    { groupBy: 'state', collapsed: [], sessions: [{ worktree: '/real/repo', id: 'ses_new', addedAt: 1_700_000_000_000, prompt: 'ship it' }] },
  ]])
  expect(h.out).toEqual(['ses_new  ship it'])
  expect(h.codes).toEqual([])
})

// The provider/model split is the only thing that can be checked here, and it has to be checked
// before createSession — a half-dispatched session left server-side is worse than a usage error.
test('--model with no provider/model split is refused before anything is created', async () => {
  const h = bgHarness()
  await runBg({ command: 'bg', prompt: 'ship it', model: 'opus' }, h.deps)
  expect(h.errs).toEqual(['--model wants <provider>/<model>'])
  expect(h.codes).toEqual([1])
  expect(h.calls).toEqual([])
  expect(h.saved).toEqual([])
})

test('--model splits on the first slash only, so a model id containing one survives', async () => {
  const h = bgHarness()
  await runBg({ command: 'bg', prompt: 'ship it', cwd: '/x', model: 'anthropic/claude-opus-4/1' }, h.deps)
  expect(h.calls[0]).toEqual(['createSession', { agent: undefined, model: { providerID: 'anthropic', id: 'claude-opus-4/1' } }, '/x'])
})

// `--exec` is the `!` job form: it goes to runShell, not promptAsync, and the roster member carries
// the shell flag the job auto-clean keys off.
test('--exec routes to runShell with build as the default agent and flags the roster member', async () => {
  const h = bgHarness()
  await runBg({ command: 'bg', prompt: 'npm test', cwd: '/x', exec: true }, h.deps)
  expect(h.calls).toEqual([
    ['createSession', { agent: undefined, model: undefined }, '/x'],
    ['runShell', 'ses_new', 'npm test', '/x', 'build'],
  ])
  expect(h.saved[0][1].sessions[0]).toEqual({ worktree: '/x', id: 'ses_new', addedAt: 1_700_000_000_000, shell: true, prompt: 'npm test' })
  expect(h.out).toEqual(['ses_new  !npm test'])
})

test('--exec with an explicit --agent runs the shell job as that agent, not build', async () => {
  const h = bgHarness()
  await runBg({ command: 'bg', prompt: 'npm test', cwd: '/x', exec: true, agent: 'plan' }, h.deps)
  expect(h.calls[1]).toEqual(['runShell', 'ses_new', 'npm test', '/x', 'plan'])
})

test('--name renames the session after it exists, and before the prompt is sent', async () => {
  const h = bgHarness()
  await runBg({ command: 'bg', prompt: 'ship it', cwd: '/x', name: 'the release' }, h.deps)
  expect(h.calls.map((c) => c[0])).toEqual(['createSession', 'renameSession', 'promptAsync'])
  expect(h.calls[1]).toEqual(['renameSession', 'ses_new', 'the release', '/x'])
})

// The roster is read by App on every render; an unbounded prompt would be pasted into a row.
test('the roster member caps the prompt at 2000 characters', async () => {
  const h = bgHarness()
  await runBg({ command: 'bg', prompt: 'x'.repeat(5000), cwd: '/x' }, h.deps)
  expect(h.saved[0][1].sessions[0].prompt).toHaveLength(2000)
  expect(h.out[0]).toBe(`ses_new  ${'x'.repeat(60)}`) // the printed line is a different, shorter cut
})

test('an unreachable server reports the reason, exits 1, and creates nothing', async () => {
  const h = bgHarness()
  h.deps.ensureServer = (() => Promise.resolve({ ok: false, server: {}, reason: 'opencode not installed — see https://opencode.ai' })) as any
  await runBg({ command: 'bg', prompt: 'ship it', cwd: '/x' }, h.deps)
  expect(h.errs).toEqual(['opencode not installed — see https://opencode.ai'])
  expect(h.codes).toEqual([1])
  expect(h.calls).toEqual([])
  expect(h.saved).toEqual([])
})

test('a failure with no reason still says something rather than exiting silently', async () => {
  const h = bgHarness()
  h.deps.ensureServer = (() => Promise.resolve({ ok: false, server: {} })) as any
  await runBg({ command: 'bg', prompt: 'ship it', cwd: '/x' }, h.deps)
  expect(h.errs).toEqual(['opencode server unreachable'])
})

// --- `fleetview server status` / `server stop` ---

const serverHarness = ({ healthy = true, pid = 4242, identity = { ok: true, command: 'opencode serve' }, kill }: any = {}) => {
  const out: any[] = []
  const errs: any[] = []
  const codes: any[] = []
  const killed: any[] = []
  // A list is how "healthy, then dead after the signal" is expressed; the last entry repeats.
  const health = Array.isArray(healthy) ? healthy : [healthy]
  let probe = 0
  const deps = {
    serverFile: '/tmp/s.json',
    loadServerImpl: () => ({ host: '127.0.0.1', port: 4900, pid }),
    isServerHealthyImpl: () => Promise.resolve(health[Math.min(probe++, health.length - 1)]),
    identifyServer: vi.fn(() => identity),
    processKill: (p: any, sig: any) => {
      killed.push([p, sig])
      if (kill) kill()
    },
    pollMs: 1,
    log: (m: any) => out.push(m),
    error: (m: any) => errs.push(m),
    setExitCode: (c: any) => codes.push(c),
  }
  return { out, errs, codes, killed, deps }
}

test('server status prints host/port/pid/health and exits 0 while the server answers', async () => {
  const h = serverHarness({ healthy: true, pid: 4242 })
  await runServer({ command: 'server', serverAction: 'status' }, h.deps)
  expect(h.out).toEqual(['host     127.0.0.1', 'port     4900', 'pid      4242', 'healthy  yes'])
  expect(h.codes).toEqual([0])
})

// Non-zero on a dead server is what makes `fleetview server status` usable from a shell script.
test('server status exits 1 when the server is not answering, and says so about an unknown pid', async () => {
  const h = serverHarness({ healthy: false, pid: null })
  await runServer({ command: 'server', serverAction: 'status' }, h.deps)
  expect(h.out).toEqual(['host     127.0.0.1', 'port     4900', 'pid      unknown', 'healthy  no'])
  expect(h.codes).toEqual([1])
})

test('server stop on a server that is not running says so and leaves the exit code alone', async () => {
  const h = serverHarness({ healthy: false })
  await runServer({ command: 'server', serverAction: 'stop' }, h.deps)
  expect(h.out).toEqual(['server is not running — nothing to stop'])
  expect(h.codes).toEqual([])
  expect(h.killed).toEqual([])
})

test('server stop refuses a healthy server fleetview did not spawn, because there is no pid to signal', async () => {
  const h = serverHarness({ healthy: true, pid: null })
  await runServer({ command: 'server', serverAction: 'stop' }, h.deps)
  expect(h.errs[0]).toMatch(/pid is unknown/)
  expect(h.codes).toEqual([1])
  expect(h.killed).toEqual([])
})

// #73: the pid in server.json is a claim about the past. Signalling a recycled pid would kill an
// unrelated process, so anything that doesn't read as `opencode serve` is refused, not signalled.
test('server stop refuses a pid whose command line is not an opencode server, and names what it found', async () => {
  const h = serverHarness({ identity: { ok: false, reason: 'vim src/app.js' } })
  await runServer({ command: 'server', serverAction: 'stop' }, h.deps)
  expect(h.deps.identifyServer).toHaveBeenCalledWith(4242)
  expect(h.errs[0]).toContain('pid 4242 is not an opencode server (vim src/app.js)')
  expect(h.errs[0]).toContain('answering on :4900')
  expect(h.codes).toEqual([1])
  expect(h.killed).toEqual([])
})

test('server stop signals, waits for it to stop answering, and reports the port it stopped', async () => {
  const h = serverHarness({ healthy: [true, true, false] }) // healthy at the gate, once more in the poll, then gone
  await runServer({ command: 'server', serverAction: 'stop' }, h.deps)
  expect(h.killed).toEqual([[4242, 'SIGTERM']])
  expect(h.out).toEqual(['stopped opencode server on :4900'])
  expect(h.codes).toEqual([0])
})

// Reporting the signal as the deed would be a lie: SIGTERM is a request, and a server that ignores
// it is something the user has to deal with by hand.
test('a server still answering after the poll window is reported honestly and exits 1', async () => {
  const h = serverHarness({ healthy: true })
  await runServer({ command: 'server', serverAction: 'stop' }, h.deps)
  expect(h.out).toEqual(['signalled, but the server is still answering — check it manually'])
  expect(h.codes).toEqual([1])
})

test('a kill that throws (pid gone between the check and the signal) is reported, not thrown', async () => {
  const h = serverHarness({ kill: () => { throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' }) } })
  await runServer({ command: 'server', serverAction: 'stop' }, h.deps)
  expect(h.errs).toEqual(["couldn't signal pid 4242: ESRCH"])
  expect(h.codes).toEqual([1])
})

// H1: the probe authenticates through authHeader(), which reads the env var and nothing else. A
// password fleetview generated lives in server.json and never in a fresh shell's env, so without the
// adoption `server status` calls fleetview's own server dead and `server stop` no-ops.
const passwordedHarness = () => {
  const out: any[] = []
  const errs: any[] = []
  const killed: any[] = []
  const env: NodeJS.ProcessEnv = {}
  let running = true
  const deps = {
    serverFile: '/tmp/s.json',
    loadServerImpl: () => ({ host: '127.0.0.1', port: 4900, pid: 4242, password: 'from-server-json' }),
    // Stands in for the real probe: 401 (read as unhealthy) unless the request carries the password.
    isServerHealthyImpl: () => Promise.resolve(running && env.OPENCODE_SERVER_PASSWORD === 'from-server-json'),
    identifyServer: () => ({ ok: true, command: 'opencode serve' }),
    processKill: (p: any, sig: any) => {
      killed.push([p, sig])
      running = false
    },
    pollMs: 1,
    log: (m: any) => out.push(m),
    error: (m: any) => errs.push(m),
    setExitCode: () => {},
    env,
  }
  return { out, errs, killed, deps }
}

test('server status adopts the password out of server.json, so fleetview\'s own server reads as healthy', async () => {
  const h = passwordedHarness()
  await runServer({ command: 'server', serverAction: 'status' }, h.deps)
  expect(h.out).toContain('healthy  yes')
})

test('server stop reaches the kill on a password-protected server fleetview spawned', async () => {
  const h = passwordedHarness()
  await runServer({ command: 'server', serverAction: 'stop' }, h.deps)
  expect(h.killed).toEqual([[4242, 'SIGTERM']])
  expect(h.out).toEqual(['stopped opencode server on :4900'])
})

// `server` is the one command that must never spawn: `status` answers about the world as it is.
// Driven through the real binary because the thing being asserted is main()'s wiring — runServer
// takes no ensureServer, so no unit-level fake could prove main() doesn't hand it one.
test('server status never spawns an opencode server, even when nothing is running', async () => {
  const port = await new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port: p } = probe.address() as any
      probe.close(() => resolve(p))
    })
  })
  const configDir = mkdtempSync(join(tmpdir(), 'fleetview-config-'))
  writeFileSync(join(configDir, 'server.json'), JSON.stringify({ host: '127.0.0.1', port, pid: null }))
  // A fake `opencode` earlier on PATH than the real one, which records the fact it was run at all.
  const binDir = mkdtempSync(join(tmpdir(), 'fleetview-bin-'))
  const marker = join(binDir, 'spawned')
  writeFileSync(join(binDir, 'opencode'), `#!/bin/sh\necho "$@" >> "${marker}"\n`, { mode: 0o755 })
  let status = 0
  let stdout = ''
  try {
    stdout = execFileSync('node', [resolvePath(import.meta.dirname, '../src/cli.ts'), 'server', 'status'], {
      env: { ...process.env, ROOST_CONFIG_DIR: configDir, PATH: `${binDir}:${process.env.PATH}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString()
  } catch (e: any) {
    status = e.status
    stdout = e.stdout.toString()
  }
  expect(status).toBe(1) // nothing listening on that port
  expect(stdout).toContain(`port     ${port}`)
  expect(stdout).toContain('healthy  no')
  expect(existsSync(marker)).toBe(false)
})

// --- id resolution across projects ---

const projectsFor = (...worktrees: any[]) => worktrees.map((worktree) => ({ worktree }))

test('an id prefix matching sessions in two projects returns both, so the caller can refuse', async () => {
  const client = {
    listSessions: vi.fn((dir) =>
      Promise.resolve(dir === '/x/alpha' ? [{ id: 'ses_abc1' }] : [{ id: 'ses_abc2' }, { id: 'ses_zzz' }]),
    ),
  }
  const matches = await matchSessions(client, projectsFor('/x/alpha', '/x/beta'), 'ses_abc')
  expect(matches).toEqual([
    { session: { id: 'ses_abc1' }, worktree: '/x/alpha' },
    { session: { id: 'ses_abc2' }, worktree: '/x/beta' },
  ])
})

// The projects are independent HTTP calls against one server, and `ls`/`attach` are things people
// wait on — serially this cost the sum of every project's round trip.
test('projects are listed concurrently, and one that fails does not sink the others', async () => {
  let inFlight = 0
  let peak = 0
  const client = {
    listSessions: vi.fn((dir) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      return new Promise((resolve, reject) =>
        setTimeout(() => {
          inFlight -= 1
          dir === '/x/beta' ? reject(new Error('offline')) : resolve([{ id: 'ses_abc1' }])
        }, 5),
      )
    }),
  }
  const matches = await matchSessions(client, projectsFor('/x/alpha', '/x/beta'), 'ses_')
  expect(peak).toBe(2)
  expect(matches).toEqual([{ session: { id: 'ses_abc1' }, worktree: '/x/alpha' }])
})

// A whole id is never ambiguous, even when it happens to also prefix a longer one.
test('an exact id wins over the longer id it prefixes', async () => {
  const client = { listSessions: vi.fn(() => Promise.resolve([{ id: 'ses_abc' }, { id: 'ses_abcdef' }])) }
  expect(await matchSessions(client, projectsFor('/x/alpha'), 'ses_abc')).toEqual([
    { session: { id: 'ses_abc' }, worktree: '/x/alpha' },
  ])
})

// #33: prefix matching is what makes a degenerate id match everything — '' is a prefix of every
// session, and every id starts 'ses_', so a one-character typo listed the whole server back.
test('#33: an empty or whitespace id matches nothing rather than every session', async () => {
  const client = { listSessions: vi.fn(() => Promise.resolve([{ id: 'ses_abc1' }, { id: 'ses_zzz2' }])) }
  expect(await matchSessions(client, projectsFor('/x/alpha'), '')).toEqual([])
  expect(await matchSessions(client, projectsFor('/x/alpha'), '   ')).toEqual([])
  expect(client.listSessions).not.toHaveBeenCalled() // rejected before the server is asked anything
})

test('#33: an id too short to resolve matches nothing', async () => {
  const client = { listSessions: vi.fn(() => Promise.resolve([{ id: 'ses_abc1' }, { id: 'ses_zzz2' }])) }
  expect(await matchSessions(client, projectsFor('/x/alpha'), 's')).toEqual([])
  expect(await matchSessions(client, projectsFor('/x/alpha'), 'ses')).toEqual([])
})

test('#33: a usable prefix still matches, and a whole id still resolves exactly', async () => {
  const client = { listSessions: vi.fn(() => Promise.resolve([{ id: 'ses_abc1' }, { id: 'ses_zzz2' }])) }
  expect(await matchSessions(client, projectsFor('/x/alpha'), 'ses_abc')).toEqual([
    { session: { id: 'ses_abc1' }, worktree: '/x/alpha' },
  ])
  expect(await matchSessions(client, projectsFor('/x/alpha'), 'ses_abc1')).toEqual([
    { session: { id: 'ses_abc1' }, worktree: '/x/alpha' },
  ])
})

test('persistSeen merges onto the loop-iteration seen read, never overwrites wholesale', () => {
  // projectB's session is absent from this snapshot (e.g. its listSessions failed this run,
  // so the store never learned about it) — the persisted file must still keep it.
  const seen = { '/repo/b:sX': { updated: 5, hasRun: true } }
  const saved: any[] = []
  const saveSeen = (file: any, map: any) => saved.push([file, map])
  const persistSeen = makePersistSeen({ seen, saveSeen, seenFile: '/tmp/seen.json' })
  persistSeen({ '/repo/a:s1': { updated: 10, hasRun: false } })
  expect(saved).toEqual([[
    '/tmp/seen.json',
    { '/repo/b:sX': { updated: 5, hasRun: true }, '/repo/a:s1': { updated: 10, hasRun: false } },
  ]])
})

test('persistSeen prunes keys for projects that listed this run but no longer have the key', () => {
  const seen = { '/repo/a:sOld': { updated: 1, hasRun: true }, '/repo/b:sB': { updated: 2, hasRun: true } }
  const saved: any[] = []
  const saveSeen = (file: any, map: any) => saved.push([file, map])
  const persistSeen = makePersistSeen({ seen, saveSeen, seenFile: '/tmp/seen.json' })
  persistSeen({ '/repo/a:sNew': { updated: 10, hasRun: false } }, ['/repo/a'])
  expect(saved).toEqual([[
    '/tmp/seen.json',
    { '/repo/a:sNew': { updated: 10, hasRun: false }, '/repo/b:sB': { updated: 2, hasRun: true } },
  ]])
})

test('port bind-fails on the configured port → falls back to the next free port, saves it, returns it as ok:true (F3, Important 1)', async () => {
  const spawnCalls: any[] = []
  const saved: any[] = []
  const deps = {
    isServerHealthy: (s: any) => Promise.resolve(s.port !== 4900), // 4900 never comes up; anything else does
    spawnServer: (s: any) => { spawnCalls.push(s.port); return 555 },
    saveServer: (file: any, s: any) => saved.push([file, s]),
    serverFile: '/tmp/s.json',
    pollMs: 1,
    spawnSyncImpl: () => ({}),
  }
  const result = await makeEnsureServer(deps as any)(server)
  expect(result).toEqual({ ok: true, server: { host: '127.0.0.1', port: 4901, pid: 555 } })
  expect(spawnCalls).toEqual([4900, 4901])
  expect(saved.at(-1)).toEqual(['/tmp/s.json', { host: '127.0.0.1', port: 4901, pid: 555 }])
})

test('port fallback exhausted (all 10 candidates unhealthy) → {ok:false, reason}', async () => {
  const deps = {
    isServerHealthy: () => Promise.resolve(false),
    spawnServer: () => 555,
    saveServer: () => {},
    serverFile: '/tmp/s.json',
    pollMs: 1,
    spawnSyncImpl: () => ({}),
  }
  expect(await makeEnsureServer(deps as any)(server)).toEqual({ ok: false, server, reason: 'server did not become healthy' })
})

test('persistSeen drops v1 repoId keys (never start with "/") unconditionally (F8)', () => {
  const seen = {
    'sandbox-28e7e3:s1': { updated: 1, hasRun: true }, // v1 key — never seeded in v2, prune outright
    '/x:s2': { updated: 2, hasRun: true }, // v2 key — abs worktree path, keep per normal rules
  }
  const saved: any[] = []
  const saveSeen = (file: any, map: any) => saved.push([file, map])
  const persistSeen = makePersistSeen({ seen, saveSeen, seenFile: '/tmp/seen.json' })
  persistSeen({})
  expect(saved).toEqual([['/tmp/seen.json', { '/x:s2': { updated: 2, hasRun: true } }]])
})

test('persistSeen extracts projectKey via lastIndexOf, so a colon-bearing worktree still prunes correctly (Minor 4)', () => {
  // worktree itself contains ':' — session ids never do, so the split must use the LAST colon.
  const seen = { '/repo:staging:sOld': { updated: 1, hasRun: true } }
  const saved: any[] = []
  const saveSeen = (file: any, map: any) => saved.push([file, map])
  const persistSeen = makePersistSeen({ seen, saveSeen, seenFile: '/tmp/seen.json' })
  persistSeen({}, ['/repo:staging']) // project listed fresh this run, key vanished → prune
  expect(saved).toEqual([['/tmp/seen.json', {}]])
})

test('--version prints the package.json version, not a hardcoded literal', () => {
  const pkg = JSON.parse(readFileSync(resolvePath(import.meta.dirname, '../package.json'), 'utf8'))
  const configDir = mkdtempSync(join(tmpdir(), 'fleetview-config-'))
  const out = execFileSync('node', [resolvePath(import.meta.dirname, '../src/cli.ts'), '--version'], {
    env: { ...process.env, ROOST_CONFIG_DIR: configDir },
  })
  expect(out.toString().trim()).toBe(pkg.version)
})

test('--help prints the usage and exits 0, without touching the roster', () => {
  const configDir = mkdtempSync(join(tmpdir(), 'fleetview-config-'))
  const out = execFileSync('node', [resolvePath(import.meta.dirname, '../src/cli.ts'), '--help'], {
    env: { ...process.env, ROOST_CONFIG_DIR: configDir },
  })
  expect(out.toString()).toContain('fleetview --cwd <path>')
  expect(out.toString()).toContain('fleetview attach <id>')
})

// An unknown command has to fail loudly: it used to print a friendly line and exit 0, which meant a
// typo in a script looked like success.
test('an unrecognised command explains itself and exits non-zero', () => {
  const configDir = mkdtempSync(join(tmpdir(), 'fleetview-config-'))
  let status = 0
  let stderr = ''
  try {
    execFileSync('node', [resolvePath(import.meta.dirname, '../src/cli.ts'), 'frobnicate'], {
      env: { ...process.env, ROOST_CONFIG_DIR: configDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e: any) {
    status = e.status
    stderr = e.stderr.toString()
  }
  expect(status).toBe(1)
  expect(stderr).toContain('unknown command: frobnicate')
})

test('runs through a symlink to the binary (npm link scenario)', () => {
  // node realpaths the ESM main module for import.meta.url but leaves argv[1] as the
  // symlink path — the main-guard must still fire here, or `fleetview` never runs under `npm link`.
  const configDir = mkdtempSync(join(tmpdir(), 'fleetview-config-'))
  const linkDir = mkdtempSync(join(tmpdir(), 'fleetview-link-'))
  const link = join(linkDir, 'fleetview-link.ts')
  symlinkSync(resolvePath(import.meta.dirname, '../src/cli.ts'), link)
  const out = execFileSync('node', [link, '--help'], {
    env: { ...process.env, ROOST_CONFIG_DIR: configDir },
  })
  expect(out.toString()).toContain('fleetview — a roster for opencode sessions')
})

// --- ^g: the $EDITOR handover (drives a real editor subprocess) ---

const withEditor = async (script: any, fn: any) => {
  const file = join(tmpdir(), `fleetview-fake-editor-${process.pid}.sh`)
  writeFileSync(file, script, { mode: 0o755 })
  const saved = { EDITOR: process.env.EDITOR, VISUAL: process.env.VISUAL }
  delete process.env.VISUAL
  process.env.EDITOR = file
  try {
    return await fn()
  } finally {
    process.env.EDITOR = saved.EDITOR
    process.env.VISUAL = saved.VISUAL
    if (saved.EDITOR === undefined) delete process.env.EDITOR
    if (saved.VISUAL === undefined) delete process.env.VISUAL
    rmSync(file, { force: true })
  }
}

const fakeGate = () => ({ closed: 0, opened: 0, writes: [] as string[], close() { this.closed++ }, open() { this.opened++ }, write(chunk: string) { this.writes.push(chunk) } })

test('editPrompt returns what the editor wrote, and hands the terminal back', async () => {
  const gate = fakeGate()
  const cleared = vi.fn()
  const result = await withEditor('#!/bin/sh\nprintf "edited by the editor" > "$1"\n', () =>
    editPrompt('rough draft', gate, { clear: cleared }),
  )
  expect(result).toBe('edited by the editor')
  // the render gate must close for the editor and reopen after, or the two draw over each other
  expect([gate.closed, gate.opened]).toEqual([1, 1])
  expect(cleared).toHaveBeenCalled() // drops the frame Ink thinks is still on screen
  // …and the screen is wiped through the gate, or Ink's next frame paints relative to wherever the
  // editor left the cursor and the editor's leftovers stay up around it (#5).
  // The input-mode resets ride along for the same reason: a child that owned the terminal may have
  // left focus reporting or bracketed paste on (#20).
  expect(gate.writes).toEqual(['\x1b[?2004l\x1b[?1004l\x1b[?1l\x1b[>4;0m\x1b[<u', '\x1b[2J\x1b[3J\x1b[H'])
})

test('editPrompt passes the current prompt in, and strips the trailing newline editors add', async () => {
  const result = await withEditor('#!/bin/sh\nsed "s/$/ extended/" "$1" > "$1.tmp" && mv "$1.tmp" "$1"\n', () =>
    editPrompt('draft', fakeGate(), null),
  )
  expect(result).toBe('draft extended')
})

// Losing a half-written prompt because $EDITOR is unset or broken would be a poor trade, so both
// resolve to undefined and App leaves the input alone.
test('no editor configured leaves the prompt alone', async () => {
  const saved = { EDITOR: process.env.EDITOR, VISUAL: process.env.VISUAL }
  delete process.env.EDITOR
  delete process.env.VISUAL
  try {
    expect(await editPrompt('draft', fakeGate(), null)).toBe(undefined)
  } finally {
    if (saved.EDITOR !== undefined) process.env.EDITOR = saved.EDITOR
    if (saved.VISUAL !== undefined) process.env.VISUAL = saved.VISUAL
  }
})

test('an editor that fails leaves the prompt alone, and still hands the terminal back', async () => {
  const gate = fakeGate()
  const result = await withEditor('#!/bin/sh\nexit 1\n', () => editPrompt('draft', gate, null))
  expect(result).toBe(undefined)
  expect([gate.closed, gate.opened]).toEqual([1, 1])
})

test('editPrompt uses a private mkdtemp dir, not a predictable /tmp path, and removes it', async () => {
  // Records the path the editor is handed so we can prove it is not the old guessable
  // /tmp/fleetview-prompt-<pid>.txt (pre-createable as a symlink) and that the dir is cleaned up.
  const record = join(tmpdir(), `fleetview-editor-path-${process.pid}.txt`)
  await withEditor(`#!/bin/sh\nprintf "%s" "$1" > "${record}"\n`, () => editPrompt('x', fakeGate(), null))
  const seen = readFileSync(record, 'utf8')
  rmSync(record, { force: true })
  expect(seen).not.toBe(join(tmpdir(), `fleetview-prompt-${process.pid}.txt`))
  expect(seen).toMatch(/fleetview-[^/\\]+[/\\]prompt\.txt$/)
  expect(existsSync(seen)).toBe(false) // temp dir removed after editing
})

// --- #54: `ls`/`--json` and a blocked session ---

// The listing built the store from sessions + statuses only, so both of derive's `waiting` paths
// were unreachable by construction: a session blocked on a permission printed `working` with no
// `waitingFor`, contradicting the parity with `claude agents --json` the README documents.
function lsDeps(clientOverrides: any = {}) {
  const client = {
    listProjects: vi.fn(() => Promise.resolve([{ id: 'a-1', worktree: '/x/alpha', vcs: 'git', time: { created: 1, updated: 1 } }])),
    listSessions: vi.fn(() => Promise.resolve([{ id: 's1', title: 'fix tests', directory: '/x/alpha', time: { created: 1, updated: 2000 } }])),
    sessionStatus: vi.fn(() => Promise.resolve({ s1: { type: 'busy' } })),
    listPermissions: vi.fn(() => Promise.resolve([{ id: 'p1', sessionID: 's1', permission: 'bash' }])),
    listQuestions: vi.fn(() => Promise.resolve([])),
    ...clientOverrides,
  }
  const printed: string[] = []
  const opts = {
    createClient: () => client,
    loadSeenImpl: () => ({}),
    seenFile: () => '/tmp/does-not-exist-seen.json',
    loadRosterImpl: () => ({ sessions: [] }),
    rosterFile: () => '/tmp/does-not-exist-roster.json',
    log: (line: string) => printed.push(line),
    error: (line: string) => printed.push(line),
    setExitCode: vi.fn(),
  }
  const ensureServer = vi.fn(() => Promise.resolve({ ok: true, server }))
  return { client, printed, opts, ensureServer }
}

test('ls seeds pending permissions, so a blocked session reports blocked with waitingFor', async () => {
  const { client, printed, opts, ensureServer } = lsDeps()
  await listSessions({ command: 'ls', json: true } as any, ensureServer, '/tmp/s.json', opts)
  expect(client.listPermissions).toHaveBeenCalledWith('/x/alpha')
  expect(client.listQuestions).toHaveBeenCalledWith('/x/alpha')
  const rows = JSON.parse(printed.join('\n'))
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ id: 's1', state: 'blocked', waitingFor: 'permission prompt' })
  expect(rows[0].waitingSince).toBeGreaterThan(0)
})

// A pending question is the other `waiting` path, and it reports a different reason.
test('ls seeds pending questions too, and reports input needed', async () => {
  const { printed, opts, ensureServer } = lsDeps({
    listPermissions: vi.fn(() => Promise.resolve([])),
    listQuestions: vi.fn(() =>
      Promise.resolve([{ id: 'q1', sessionID: 's1', questions: [{ question: 'merge?', header: 'merge', options: [] }] }]),
    ),
  })
  await listSessions({ command: 'ls', json: true } as any, ensureServer, '/tmp/s.json', opts)
  expect(JSON.parse(printed.join('\n'))[0]).toMatchObject({ id: 's1', state: 'blocked', waitingFor: 'input needed' })
})

// Each seed GET fails independently: a project whose pending reads fail degrades to the previous
// behaviour rather than sinking the listing.
// #45: `ls` builds a fresh store per invocation, so a failed session — whose error only ever lived
// in the process that saw the live frame — printed as `done` while the running TUI showed it red
// with the APIError snippet. The persisted error is now read off the same seen.json watermark file
// `hasRun` and the stop flag come from, so the two agree.
test('#45: ls reports a previously-errored session as failed, not done', async () => {
  const { printed, opts, ensureServer } = lsDeps({
    sessionStatus: vi.fn(() => Promise.resolve({})),
    listPermissions: vi.fn(() => Promise.resolve([])),
  })
  opts.loadSeenImpl = () => ({
    '/x/alpha:s1': { updated: 2000, hasRun: true, stopped: false, error: 'APIError: No endpoints found that support tool use' },
  })
  await listSessions({ command: 'ls', json: true, all: true } as any, ensureServer, '/tmp/s.json', opts)
  const rows = JSON.parse(printed.join('\n'))
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ id: 's1', state: 'failed' })
})

test('a failing pending read leaves the rest of the listing intact', async () => {
  const { printed, opts, ensureServer } = lsDeps({
    listPermissions: vi.fn(() => Promise.reject(new Error('down'))),
    listQuestions: vi.fn(() => Promise.reject(new Error('down'))),
  })
  await listSessions({ command: 'ls', json: true } as any, ensureServer, '/tmp/s.json', opts)
  const rows = JSON.parse(printed.join('\n'))
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ id: 's1', state: 'working' })
  expect(rows[0].waitingFor).toBe(undefined)
})
