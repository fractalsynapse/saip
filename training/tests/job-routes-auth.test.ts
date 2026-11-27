/**
 * The auth hole the read routes would otherwise open (#197a, design record §2.5).
 *
 * `learning-api.ts:59` mounts auth as `app.use('/v1/learning/jobs', mw)`. In Hono an exact path
 * does **not** cover subpaths, so the moment `GET /v1/learning/jobs/:id` exists it is reachable
 * without a token: every persisted job — adapter, strategy, dataset hash, parameters — readable by
 * anyone who can reach the port. The fix belongs with the route, not after it.
 *
 * These assertions are written against the assembled app rather than the middleware, because the
 * defect is the mount pattern. A unit test of `BearerTokenAuth` passes happily while the route is
 * wide open.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { Context } from 'cordis'
import { MemoryStorage, BearerTokenAuth } from '@saip/shared'
import { seededStore } from './helpers/corpus.js'
import { LearningApiService } from '../src/plugins/learning-api.js'
import { createMiddleware } from 'hono/factory'

const adapters = [
  { name: 'coding', scope: 'global' as const, trainable: true, training: { strategy: 'corrective_sft', data_scopes: ['sessions', 'feedback'] } },
]

class FakeSecrets {
  constructor(private map: Record<string, string>) {}
  async get(n: string) { return this.map[n] }
  async require(n: string) { const v = this.map[n]; if (!v) throw new Error(`missing ${n}`); return v }
}

function authMiddleware(token: string) {
  const provider = new BearerTokenAuth([{ caller: 'alice', token_secret: 'SAIP_TOKEN_ALICE' }], new FakeSecrets({ SAIP_TOKEN_ALICE: token }))
  return createMiddleware(async (c: any, next: any) => {
    const principal = await provider.verifyApi({ headers: { authorization: c.req.header('authorization') ?? '' } })
    if (!principal) return c.json({ error: { message: 'authentication required', code: 'unauthorized' } }, 401)
    c.set('principal', principal)
    await next()
  })
}

const TOKEN = 'a-real-bearer-token-value'
let app: any
let storage: MemoryStorage

beforeEach(async () => {
  storage = await seededStore()
  const ctx = new Context()
  await ctx.plugin(LearningApiService, {
    adapters, registeredStrategies: ['corrective_sft'], storage, authMiddleware: authMiddleware(TOKEN),
  })
  app = (ctx as any).learningApi.app
})

const anon = (path: string, init?: Record<string, unknown>) => app.request(path, init)
const authed = (path: string, init: Record<string, unknown> = {}) => app.request(path, {
  ...init, headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers as object | undefined) },
})

describe('Learning API auth covers the whole jobs subtree', () => {
  it('POST /v1/learning/jobs is already fail-closed', async () => {
    const res = await anon('/v1/learning/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(401)
  })

  it('GET /v1/learning/jobs refuses an unauthenticated list', async () => {
    expect((await anon('/v1/learning/jobs')).status).toBe(401)
    // And a token that is merely present is not enough — it has to be the right one.
    expect((await app.request('/v1/learning/jobs', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401)
  })

  it('GET /v1/learning/jobs/:id refuses an unauthenticated read of a single record', async () => {
    const created = await authed('/v1/learning/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ adapter: 'coding' }) })
    const { id } = await created.json()
    expect(created.status).toBe(202)
    const res = await anon(`/v1/learning/jobs/${id}`)
    // 404 here would be the bug: an unknown-route path is not an authenticated refusal, and the
    // record does exist — it would simply have been served to anyone.
    expect(res.status).toBe(401)
  })

  it('the record is not disclosed in the refusal body', async () => {
    const created = await authed('/v1/learning/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ adapter: 'coding' }) })
    const { id } = await created.json()
    const res = await anon(`/v1/learning/jobs/${id}`)
    const text = await res.text()
    expect(text).not.toContain('corrective_sft')
    expect(text).not.toContain(id)
  })

  it('an authenticated read returns the record', async () => {
    const created = await authed('/v1/learning/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ adapter: 'coding' }) })
    const { id } = await created.json()
    const res = await authed(`/v1/learning/jobs/${id}`)
    expect(res.status).toBe(200)
    expect((await res.json()).id).toBe(id)
  })

  it('the strategies route stays public, as documented', async () => {
    expect((await anon('/v1/learning/strategies')).status).toBe(200)
  })

  it('no route under /v1/learning/jobs/ is reachable anonymously, whatever its depth', async () => {
    // Guards the mount pattern itself: an exact-path `use()` would let a future
    // /v1/learning/jobs/<id>/logs through the same way.
    for (const path of ['/v1/learning/jobs/anything', '/v1/learning/jobs/anything/deeper', '/v1/learning/jobs?status=queued']) {
      expect((await anon(path)).status, path).toBe(401)
    }
  })
})
