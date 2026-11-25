/**
 * An unresolvable scope is refused at the API, and still recorded (#196, Review Focus #5).
 *
 * The design record puts the failure at P1: "an empty or unresolvable scope fails the job with a
 * structured error **before** any config is materialized — never a silent zero-record dataset that
 * trains the model into amnesia."
 *
 * Two things had to be decided, and both are pinned here rather than left implicit:
 *
 * - **Refuse at queue time.** Waiting until a runner exists to discover the corpus is empty means
 *   the operator learns about a typo days later, from a job that never ran. The API has the storage
 *   seam now, so it can answer immediately.
 * - **Persist the refusal anyway.** A bare 422 would leave no trace, and "why is there no job for
 *   that run?" is a worse question than "why did this job fail". So the record is written with
 *   `status: 'failed'` and the structured error, and the response carries the same code.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { Context } from 'cordis'
import { MemoryStorage, type LearningJobRecord } from '@saip/shared'
import { LearningApiService } from '../src/plugins/learning-api.js'

const adapters = [
  { name: 'coding', scope: 'global' as const, trainable: true, training: { strategy: 'corrective_sft', data_scopes: ['sessions', 'feedback'] } },
  { name: 'docs', scope: 'global' as const, trainable: true, training: { strategy: 'knowledge_embedding', data_scopes: ['documents'] } },
  // Library scopes are declared by the adapter, not per-request: design record §P1 resolves "the
  // coding adapter's declaration", and the Learning API offers no data_scopes override. Adding one
  // here would invent a flag the reference does not document (#162's class, in reverse).
  { name: 'onboarding-learner', scope: 'global' as const, trainable: true, training: { strategy: 'knowledge_embedding', data_scopes: ['library:onboarding'] } },
  { name: 'broken', scope: 'global' as const, trainable: true, training: { strategy: 'knowledge_embedding', data_scopes: ['vibes'] } },
]

let storage: MemoryStorage
let app: any

beforeEach(async () => {
  storage = new MemoryStorage()
  const ctx = new Context()
  await ctx.plugin(LearningApiService, {
    storage, adapters, registeredStrategies: ['corrective_sft', 'knowledge_embedding'],
  })
  app = (ctx as any).learningApi.app
  await (ctx as any).learningApi.ready
})

const post = (body: Record<string, unknown>) =>
  app.request('/v1/learning/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('scope resolution gates job acceptance', () => {
  it('rejects a job whose scopes resolve to nothing, with empty_scope', async () => {
    const res = await post({ adapter: 'coding' })
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error.code).toBe('empty_scope')
    expect(body.error.message).toMatch(/sessions/)
  })

  it('still writes a record, so the refusal is auditable', async () => {
    const res = await post({ adapter: 'coding' })
    const record = (await res.json()).job as LearningJobRecord
    expect(record.status).toBe('failed')
    expect(record.error?.code).toBe('empty_scope')
    expect(record.history.map((h) => h.status)).toEqual(['queued', 'failed'])
    const stored = JSON.parse((await storage.get(`jobs/${record.id}.json`))!) as LearningJobRecord
    expect(stored.status).toBe('failed')
  })

  it('names the scope that failed rather than reporting a generic validation error', async () => {
    // `onboarding-learner` declares library:onboarding and no manifest exists.
    const res = await post({ adapter: 'onboarding-learner' })
    const body = await res.json()
    expect(body.error.code).toBe('library_not_found')
    expect(body.error.message).toMatch(/library:onboarding/)
  })

  it('accepts the job once the corpus exists', async () => {
    await storage.put('sessions/s1/conversation.jsonl', '{"role":"user"}\n')
    await storage.put('feedback/f1.json', '{"id":"f1","reward":2}')
    const res = await post({ adapter: 'coding' })
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.status).toBe('queued')
    expect(body.dataset).toBeUndefined()
  })

  it('accepts a library scope once its manifest is materialized (#64 B4)', async () => {
    // Before the manifest exists the adapter's own scope is unresolvable…
    expect((await post({ adapter: 'onboarding-learner' })).status).toBe(422)

    await storage.put('libraries/onboarding/manifest.json', JSON.stringify({
      name: 'onboarding', filter: { tags: ['wiki'] }, members: ['knowledge/d1/processed.md'], count: 1, updated_at: 'now',
    }))
    await storage.put('knowledge/d1/processed.md', '# hello')

    const res = await post({ adapter: 'onboarding-learner' })
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.data_scopes).toEqual(['library:onboarding'])
    expect(body.inherited).toEqual({ strategy: true, data_scopes: true })
  })

  it('narrows a scope by data_ids, which the API does document', async () => {
    await storage.put('sessions/s1/conversation.jsonl', 'a')
    await storage.put('sessions/s2/conversation.jsonl', 'b')
    await storage.put('feedback/f1.json', '{"id":"f1"}')
    const ok = await post({ adapter: 'coding', data_ids: ['s2', 'f1'] })
    expect(ok.status).toBe(202)
    const bad = await post({ adapter: 'coding', data_ids: ['nonexistent'] })
    expect(bad.status).toBe(422)
    expect((await bad.json()).error.code).toBe('empty_scope')
  })

  it('rejects an unknown scope name with unknown_scope', async () => {
    const res = await post({ adapter: 'broken' })
    expect((await res.json()).error.code).toBe('unknown_scope')
  })

  it('emits no queued event for a refused job', async () => {
    let events = 0
    const ctx = new Context()
    ctx.on('learning/job-queued', () => { events++ })
    const s = new MemoryStorage()
    await ctx.plugin(LearningApiService, { storage: s, adapters, registeredStrategies: ['corrective_sft'] })
    await (ctx as any).learningApi.app.request('/v1/learning/jobs', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ adapter: 'coding' }),
    })
    expect(events).toBe(0)
  })

  it('a refused record shows in the list and the index', async () => {
    await post({ adapter: 'coding' })
    const listed = await (await app.request('/v1/learning/jobs')).json()
    expect(listed.total).toBe(1)
    expect(listed.entries[0].status).toBe('failed')
    const failed = await (await app.request('/v1/learning/jobs?status=failed')).json()
    expect(failed.total).toBe(1)
  })
})
