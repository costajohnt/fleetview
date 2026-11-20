import { test, expect, vi } from 'vitest'
import { opencodeRequest } from '../src/backends/opencode/request.ts'

const reply = (status: number, text: string) => Promise.resolve({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(text) })

// The one request helper both API versions go through (#186).
test('sends the query, credential and extra headers, and parses the JSON reply', async () => {
  const fetchImpl = vi.fn(() => reply(200, '{"a":1}'))
  const out = await opencodeRequest(fetchImpl as any, 'http://h', 'POST', '/p', { body: { x: 1 }, auth: 'Basic z', query: '?directory=%2Fd', headers: { 'x-extra': 'v' } })
  expect(out).toEqual({ a: 1 })
  expect(fetchImpl).toHaveBeenCalledWith('http://h/p?directory=%2Fd', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Basic z', 'x-extra': 'v' },
    body: '{"x":1}',
    signal: expect.any(AbortSignal),
  })
})

test('no body and no credential send neither header; an empty 2xx is null', async () => {
  const fetchImpl = vi.fn(() => reply(204, ''))
  expect(await opencodeRequest(fetchImpl as any, 'http://h', 'GET', '/p')).toBeNull()
  expect(fetchImpl).toHaveBeenCalledWith('http://h/p', expect.objectContaining({ headers: {}, body: undefined }))
})

test('a refusal throws with its status, the path without the query, and a cleaned body', async () => {
  const fetchImpl = vi.fn(() => reply(403, `no${String.fromCharCode(27)}[2J`))
  const err = await opencodeRequest(fetchImpl as any, 'http://h', 'GET', '/p', { query: '?directory=secret' }).catch((e) => e)
  expect(err.status).toBe(403)
  expect(err.message).toMatch(/^GET \/p → 403: no/)
  expect(err.message).not.toContain('secret')
  expect(err.message).not.toContain(String.fromCharCode(27))
})
