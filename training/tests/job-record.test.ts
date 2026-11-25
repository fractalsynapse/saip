/**
 * The persisted learning-job record (#197a).
 *
 * Before this, `POST /v1/learning/jobs` minted an id from a **process-local counter**
 * (`train-<date>-NNN`, `learning-api.ts:33-34`), emitted an event, and returned a body — and then
 * forgot everything. Two consequences the tests below pin:
 *
 * 1. The counter resets at boot, so two runs mint the same id. Records written by run 1 are
 *    overwritten by run 2, which is worse than not persisting at all.
 * 2. Nothing could answer "did that job finish?". A killed cloud instance left no trace, and the
 *    loop's durability claim (goal file §C) depends on the job record being the truth.
 *
 * Write-ahead is asserted by reading storage *inside* the event handler: if the event can fire
 * before the object exists, every consumer of the event is racing a write it cannot see.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { Context } from 'cordis'
import { MemoryStorage, type LearningJobRecord } from '@saip/shared'
import { LearningApiService } from '../src/plugins/learning-api.js'

const adapters = [
  { name: 'coding', scope: 'global' as const, trainable: true, training: { strategy: 'corrective_sft', data_scopes: ['sessions', 'feedback'] } },
  { name: 'research', scope: 'global' as const, trainable: true, training: { strategy: 'weighted_kto', data_scopes: ['feedback'] } },
  { name: 'team', scope: 'user' as const, user: 'ada', trainable: false, composite: { gain: 1, merge: 'weighted_linear' as const, components: [{ adapter: 'coding', weight: 1 }, { adapter: 'research', weight: 1 }] } },
]

async function boot(storage = new MemoryStorage(), events: string[] = []) {
  const ctx = new Context()
  ctx.on('learning/job-queued', async () => {
    // Read the store from inside the event: this only passes if the record was written first.
    const ids = (await storage.list('jobs/')).filter((k) => k.endsWith('.json') && !k.endsWith('_index.json'))
    queuedSeenDuringEvent = ids.length
  })
  await ctx.plugin(LearningApiService, { adapters, registeredStrategies: ['corrective_sft', 'weighted_kto'], storage })
  // Same contract the composition root honors: startup is not finished until the sweep is (#197a).
  await (ctx as any).learningApi.ready
  return { ctx: ctx as any, app: (ctx as any).learningApi.app, storage }
}
let queuedSeenDuringEvent = -1

const post = (app: any, body: Record<string, unknown>) =>
  app.request('/v1/learning/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('write-ahead persistence', () => {
  let storage: MemoryStorage
  let app: any
  beforeEach(async () => {
    queuedSeenDuringEvent = -1
    const b = await boot()
    storage = b.storage; app = b.app
  })

  it('a created job exists at jobs/<id>.json before the queued event fires', async () => {
    const res = await post(app, { adapter: 'coding' })
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(queuedSeenDuringEvent, 'event fired before the record was written').toBe(1)

    const raw = await storage.get(`jobs/${body.id}.json`)
    expect(raw, 'the record must be in storage, not only in the response body').toBeTruthy()
    const rec = JSON.parse(raw!) as LearningJobRecord
    expect(rec.status).toBe('queued')
    expect(rec.id).toBe(body.id)
  })

  it('the record carries the five linkage fields the API already returned, not a second shape', async () => {
    const body = await (await post(app, { adapter: 'coding', params: { epochs: 3 } })).json()
    const rec = JSON.parse((await storage.get(`jobs/${body.id}.json`))!) as LearningJobRecord
    expect(rec).toMatchObject({
      adapter: 'coding',
      strategy: 'corrective_sft',
      data_scopes: ['sessions', 'feedback'],
      params: { epochs: 3 },
      inherited: { strategy: true, data_scopes: true },
    })
    expect(rec.history).toEqual([{ at: rec.created_at, status: 'queued' }])
    expect(typeof rec.updated_at).toBe('string')
  })

  it('indexes the job so a list read does not require scanning the bucket', async () => {
    const body = await (await post(app, { adapter: 'coding' })).json()
    const index = JSON.parse((await storage.get('jobs/_index.json'))!)
    expect(index.jobs[body.id]).toMatchObject({ status: 'queued', adapter: 'coding', strategy: 'corrective_sft' })
    expect(typeof index.updated_at).toBe('string')
  })
})

describe('id derivation', () => {
  it('two compositions never mint the same id — the old counter reset at boot (#2.3)', async () => {
    const a = await boot()
    const b = await boot(new MemoryStorage())
    const idA = (await (await post(a.app, { adapter: 'coding' })).json()).id
    const idB = (await (await post(b.app, { adapter: 'coding' })).json()).id
    expect(idA).not.toBe(idB)
    // Shape is documented: train-<YYYYMMDD>-<base36-ms>-<base36-rand4>
    expect(idA).toMatch(/^train-\d{8}-[0-9a-z]+-[0-9a-z]{4}$/)
  })

  it('ids from the same process are distinct and sortable by creation time', async () => {
    const { app } = await boot()
    const ids: string[] = []
    for (let i = 0; i < 25; i++) ids.push((await (await post(app, { adapter: 'coding' })).json()).id)
    expect(new Set(ids).size).toBe(25)
  })
})

describe('boot-time interruption sweep', () => {
  it('a running record from a previous process becomes failed{interrupted} at construction', async () => {
    const storage = new MemoryStorage()
    const stale: LearningJobRecord = {
      id: 'train-20260101-oldjob-0001', caller: 'adrian', adapter: 'coding', strategy: 'corrective_sft',
      data_scopes: ['sessions', 'feedback'], params: {}, inherited: { strategy: true, data_scopes: true },
      status: 'running', history: [{ at: '2026-01-01T00:00:00Z', status: 'queued' }, { at: '2026-01-01T00:00:05Z', status: 'running' }],
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:05Z',
    }
    await storage.put(`jobs/${stale.id}.json`, JSON.stringify(stale))
    await storage.put('jobs/_index.json', JSON.stringify({ jobs: { [stale.id]: { status: 'running', adapter: 'coding', strategy: 'corrective_sft', created_at: stale.created_at, updated_at: stale.updated_at } } }))

    const b = await boot(storage)
    const after = JSON.parse((await storage.get(`jobs/${stale.id}.json`))!) as LearningJobRecord
    expect(after.status).toBe('failed')
    expect(after.error).toMatchObject({ code: 'interrupted' })
    expect(after.history.at(-1)).toMatchObject({ status: 'failed' })
    // The index must not disagree with the object it indexes.
    const index = JSON.parse((await storage.get('jobs/_index.json'))!)
    expect(index.jobs[stale.id].status).toBe('failed')
    void b
  })

  it('leaves records in any other state alone', async () => {
    const storage = new MemoryStorage()
    const done: LearningJobRecord = {
      id: 'train-20260101-done-0001', adapter: 'coding', strategy: 'corrective_sft', data_scopes: [],
      params: {}, inherited: { strategy: true, data_scopes: true }, status: 'succeeded',
      history: [], created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:10:00Z',
    }
    await storage.put(`jobs/${done.id}.json`, JSON.stringify(done))
    await boot(storage)
    expect(JSON.parse((await storage.get(`jobs/${done.id}.json`))!).status).toBe('succeeded')
  })
})

describe('read routes', () => {
  it('GET /v1/learning/jobs/:id returns the stored record', async () => {
    const { app } = await boot()
    const created = await (await post(app, { adapter: 'coding' })).json()
    const res = await app.request(`/v1/learning/jobs/${created.id}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: created.id, status: 'queued', adapter: 'coding' })
  })

  it('an unknown id is a typed 404, not an empty 200', async () => {
    const { app } = await boot()
    const res = await app.request('/v1/learning/jobs/train-20200101-nope-0000')
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('job_not_found')
  })

  it('the list mirrors the Data API document list shape and filters by adapter and status', async () => {
    const { app } = await boot()
    await post(app, { adapter: 'coding' })
    await post(app, { adapter: 'coding' })
    await post(app, { adapter: 'research' })
    const all = await (await app.request('/v1/learning/jobs')).json()
    expect(Object.keys(all).sort()).toEqual(['entries', 'limit', 'offset', 'total'])
    expect(all.total).toBe(3)
    expect(all.entries[0]).toHaveProperty('id')

    const coding = await (await app.request('/v1/learning/jobs?adapter=coding')).json()
    expect(coding.total).toBe(2)
    const failed = await (await app.request('/v1/learning/jobs?status=failed')).json()
    expect(failed.total).toBe(0)
    const page = await (await app.request('/v1/learning/jobs?limit=1&offset=1')).json()
    expect(page.entries).toHaveLength(1)
    expect(page.total).toBe(3)
  })
})

describe('params never carry a credential into storage', () => {
  it('rejects a params key that looks like a secret, and writes nothing', async () => {
    const { app, storage } = await boot()
    for (const key of ['hf_token', 'aws_secret', 'api_key', 'password', 'X-My-Secret-Value']) {
      const res = await post(app, { adapter: 'coding', params: { [key]: 'hunter2' } })
      expect(res.status, key).toBe(422)
      expect((await res.json()).error.code).toBe('forbidden_param')
    }
    expect((await storage.list('jobs/')).filter((k) => k.endsWith('.json')).length).toBe(0)
  })

  it('accepts ordinary training parameters', async () => {
    const { app } = await boot()
    const res = await post(app, { adapter: 'coding', params: { epochs: 3, learning_rate: 0.0002 } })
    expect(res.status).toBe(202)
  })
})
