/**
 * `corrective_sft`: the join, the weights, and byte-determinism (#196b).
 *
 * Three things had to be pinned before this could be trusted as the thing a GPU runs:
 *
 * 1. **The join is on real keys.** Feedback records carry `session_id` and `message_id`; a message
 *    with no feedback is *context*, never a weighted target. Without that rule every assistant turn
 *    in a session becomes training signal for whatever the user happened to reply to next.
 * 2. **Determinism is checkable, not asserted.** Two exports over identical storage must be
 *    byte-identical — and the comparison must be shown to be capable of failing, by exporting a
 *    deliberately unordered dataset and confirming the hash differs. A hash that can never differ
 *    is decoration (design record §3 P3, Review Focus #6).
 * 3. **The registry is the truth about strategies.** `registeredStrategies` used to be a config
 *    list; a strategy accepted at the API with no plugin behind it produces a job that dies later.
 *    The default composition now registers what actually exists.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { Context } from 'cordis'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStorage, type LearningJobRecord } from '@saip/shared'
import { LearningApiService } from '../src/plugins/learning-api.js'
import { CorrectiveSftService, exportDataset } from '../src/index.js'

const adapters = [
  { name: 'coding', scope: 'global' as const, trainable: true, training: { strategy: 'corrective_sft', data_scopes: ['sessions', 'feedback'] } },
]

const msg = (id: string, role: string, content: string) => ({ id, role, content, created_at: `2026-01-0${id.length}T00:00:00Z` })

/** One session with a corrected turn, a confirmed turn, and a turn nobody rated. */
async function corpus() {
  const storage = new MemoryStorage()
  const conversation = [
    msg('m1', 'user', 'how do I rebase?'),
    msg('m2', 'assistant', 'git pull --rebase'),
    msg('m3', 'user', 'and to undo?'),
    msg('m4', 'assistant', 'git rebase --abort'),
    msg('m5', 'assistant', 'unrated reply'),
  ]
  await storage.put('sessions/sess-1/conversation.jsonl', conversation.map((m) => JSON.stringify(m)).join('\n') + '\n')
  await storage.put('sessions/sess-1/manifest.json', JSON.stringify({ id: 'sess-1', created_at: '2026-01-01T00:00:00Z' }))
  await storage.put('feedback/f1.json', JSON.stringify({ id: 'f1', session_id: 'sess-1', message_id: 'm2', reward: -3, confidence: 0.9, created_at: '2026-01-02T00:00:00Z' }))
  await storage.put('feedback/f2.json', JSON.stringify({ id: 'f2', session_id: 'sess-1', message_id: 'm4', reward: 2, created_at: '2026-01-03T00:00:00Z' }))
  await storage.put('feedback/_index.json', JSON.stringify({ records: {} }))
  return storage
}

const job = (over: Partial<LearningJobRecord> = {}): LearningJobRecord => ({
  id: 'train-20261125-test-0001', caller: 'adrian', adapter: 'coding', strategy: 'corrective_sft',
  data_scopes: ['sessions', 'feedback'], params: {}, inherited: { strategy: true, data_scopes: true },
  status: 'queued', history: [], created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  ...over,
})

describe('corrective_sft rows', () => {
  let storage: MemoryStorage
  let plugin: CorrectiveSftService
  beforeEach(async () => {
    storage = await corpus()
    const ctx = new Context()
    await ctx.plugin(CorrectiveSftService, {})
    plugin = (ctx as any).correctiveSft
  })

  it('weights by |reward|/3 and carries the sign as a label', async () => {
    const rows = await plugin.build({ storage, job: job() })
    const corrected = rows.find((r) => r.label === 'corrected')
    const confirmed = rows.find((r) => r.label === 'correct')
    // reward -3 with confidence 0.9: the record's formula ignores confidence, on purpose.
    expect(corrected).toMatchObject({ weight: 1, provenance: { session_id: 'sess-1', message_id: 'm2' } })
    expect(confirmed).toMatchObject({ weight: 2 / 3, provenance: { message_id: 'm4' } })
  })

  it('an unrated message is context only — present, never weighted, never a target', async () => {
    const rows = await plugin.build({ storage, job: job() })
    const unrated = rows.find((r) => 'content' in r && (r as any).content === 'unrated reply')
    expect(unrated, 'context should still be carried').toBeTruthy()
    expect((unrated as any).weight ?? 0).toBe(0)
    expect((unrated as any).label).toBeUndefined()
  })

  it('ignores feedback pointing at another session', async () => {
    await storage.put('feedback/f9.json', JSON.stringify({ id: 'f9', session_id: 'other', message_id: 'm2', reward: -3, created_at: '2026-01-04T00:00:00Z' }))
    const rows = await plugin.build({ storage, job: job() })
    expect(rows.filter((r) => r.label === 'corrected')).toHaveLength(1)
  })

  it('declares the scopes it consumes and the format it produces', () => {
    expect(plugin.name).toBe('corrective_sft')
    expect(plugin.consumes).toEqual(expect.arrayContaining(['sessions', 'feedback']))
    expect(plugin.format).toBe('axolotl_sft')
  })
})

describe('dataset export', () => {
  let storage: MemoryStorage
  beforeEach(async () => { storage = await corpus() })

  it('writes canonical JSONL at jobs/<id>/dataset/<strategy>.jsonl', async () => {
    const out = await exportDataset({ job: job(), storage, strategies: [await pluginFor()] })
    expect(out.key).toBe('jobs/train-20261125-test-0001/dataset/corrective_sft.jsonl')
    const raw = await storage.get(out.key)
    expect(typeof raw).toBe('string')
    expect(raw!.endsWith('\n')).toBe(true)
    expect(raw!.split('\n').filter(Boolean).length).toBe(out.records)
  })

  it('two exports over identical storage are byte-identical', async () => {
    const strategies = [await pluginFor()]
    const a = await exportDataset({ job: job(), storage, strategies })
    const b = await exportDataset({ job: job(), storage, strategies })
    expect(a.sha256).toBe(b.sha256)
    expect(await storage.get(a.key)).toBe(await storage.get(b.key))
  })

  it('canary: unordered rows produce a different hash, so the check compares something', async () => {
    const ordered = await exportDataset({ job: job(), storage, strategies: [await pluginFor()] })
    const shuffled = await exportDataset({
      job: job(), storage, strategies: [await pluginFor()],
      // Test hook: reverses row order before hashing, exactly the bug determinism guards against.
      unsortForCanary: true,
    })
    expect(shuffled.sha256).not.toBe(ordered.sha256)
    expect(shuffled.records).toBe(ordered.records)
  })

  it('the manifest carries the hash, the record count and the format', async () => {
    const out = await exportDataset({ job: job(), storage, strategies: [await pluginFor()] })
    const manifest = JSON.parse((await storage.get(`jobs/${job().id}/dataset/manifest.json`))!)
    expect(manifest).toMatchObject({ sha256: out.sha256, records: out.records, format: 'axolotl_sft' })
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/)
    // The hash must describe the bytes actually stored, not a value computed separately.
    expect(createHash('sha256').update((await storage.get(out.key))!, 'utf8').digest('hex')).toBe(out.sha256)
  })

  it('mirrors to the training-data directory when one is configured', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'saip-data-'))
    const out = await exportDataset({ job: job(), storage, strategies: [await pluginFor()], mirrorDir: dir })
    const mirrored = readFileSync(join(dir, 'train-20261125-test-0001', 'dataset', 'corrective_sft.jsonl'), 'utf8')
    expect(mirrored).toBe(await storage.get(out.key))
    expect(readdirSync(join(dir, 'train-20261125-test-0001'))).toContain('dataset')
  })

  it('writes no mirror when no directory is configured — no invented path', async () => {
    const out = await exportDataset({ job: job(), storage, strategies: [await pluginFor()] })
    expect(out.mirror).toBeUndefined()
  })

  it('refuses to export a strategy with no plugin rather than emitting an empty dataset', async () => {
    await expect(exportDataset({ job: job({ strategy: 'weighted_kto' }), storage, strategies: [await pluginFor()] }))
      .rejects.toThrow(/weighted_kto/)
  })
})

describe('strategy registry at the composition root', () => {
  it('createApp() default construction registers corrective_sft with no injected strategies', async () => {
    const ctx = (await createAppDefault()) as any
    const res = await ctx.learningApi.app.request('/v1/learning/strategies')
    const body = await res.json()
    expect(body.strategies).toContain('corrective_sft')
  })

  it('a job naming an unregistered strategy is refused at the API', async () => {
    const ctx = (await createAppDefault()) as any
    const res = await ctx.learningApi.app.request('/v1/learning/jobs', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ adapter: 'coding', strategy: 'knowledge_embedding' }),
    })
    expect(res.status).toBe(422)
    expect((await res.json()).error.code).toBe('unknown_strategy')
  })

  it('the accepted strategy list is exactly the installed plugins', async () => {
    const ctx = (await createAppDefault()) as any
    const listed = (await (await ctx.learningApi.app.request('/v1/learning/strategies')).json()).strategies as string[]
    const installed = ctx.learningApi.strategyPlugins().map((p: { name: string }) => p.name) as string[]
    // This is the defect #196b removes: a name the API accepts with nothing behind it.
    expect(listed).toEqual(installed)
    expect(installed).toEqual(['corrective_sft'])
  })
})

async function pluginFor() {
  const ctx = new Context()
  await ctx.plugin(CorrectiveSftService, {})
  return (ctx as any).correctiveSft
}

async function createAppDefault() {
  const { createApp } = await import('../src/index.js')
  const storage = await corpus()
  return createApp({
    storage,
    config: {},
    env: { SAIP_STORAGE: 'memory' },
    security: { dev_mode: true },
    adapters,
  })
}
