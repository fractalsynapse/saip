/**
 * Promotion: objects first, index last (#198b, design record §3 P7).
 *
 * `r2Sync` consumes `learning/adapter-trained` and turns a directory on the `adapter-output` volume
 * into a served adapter version. The ordering is the entire design: a promotion is visible exactly
 * when the index says it is, so every artifact must already be readable at that moment, and nothing
 * may be committed if any of it failed.
 *
 * Review Focus #9 is the test that matters most here: an upload that dies partway must leave the
 * previous `latest` serving a complete artifact — not a pointer to bytes that were never written.
 * A dangling version is worse than a stale one, because the stale one still works.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { Context } from 'cordis'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStorage } from '@saip/shared'
import { R2StorageProvider } from '@saip/shared/storage'
import { startFakeS3, FAKE_ACCESS_KEY, FAKE_SECRET_KEY } from '@saip/shared/testing'
import { R2SyncService } from '../src/plugins/r2-sync.js'

const NAME = 'coding'

function artifactDir(files: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'saip-art-'))
  const base = { 'adapter_config.json': '{"r":16,"base_model_name_or_path":"Qwen/Qwen3.5-4B"}', 'adapter_model.safetensors': 'weights-bytes' }
  for (const [n, body] of Object.entries({ ...base, ...files })) writeFileSync(join(dir, n), body)
  return dir
}

/** Wraps a provider to record the order of writes, so "index last" is a fact, not a hope. */
function recording(storage: MemoryStorage) {
  const order: string[] = []
  const proxy: MemoryStorage = Object.create(storage) as MemoryStorage
  proxy.put = async (key, body) => { order.push(key); return storage.put(key, body) }
  proxy.get = (key) => storage.get(key)
  proxy.list = (prefix) => storage.list(prefix)
  proxy.delete = (key) => storage.delete(key)
  return { proxy, order }
}

async function boot(storage: MemoryStorage, dir: string) {
  const ctx = new Context()
  await ctx.plugin(R2SyncService, { storage })
  return { sync: ctx.r2Sync as any, storage, dir }
}

describe('first promotion', () => {
  let storage: MemoryStorage
  let dir: string

  beforeEach(async () => {
    storage = new MemoryStorage()
    dir = artifactDir()
  })

  it('uploads adapter_config.json, adapter_model.safetensors and manifest.json under adapters/<name>/v<N>/', async () => {
    const { sync } = await boot(storage, dir)
    const result = await sync.promote({ adapter: NAME, job_id: 'train-20261125-a-1', path: dir, records: 412, base_model: 'Qwen/Qwen3.5-4B' })
    expect(result.version).toBe(1)
    expect(result.prefix).toBe('adapters/coding/v000001/')
    for (const f of ['adapter_config.json', 'adapter_model.safetensors', 'manifest.json']) {
      expect(await storage.get(`${result.prefix}${f}`), f).toBeTruthy()
    }
  })

  it('writes the index LAST, and it is the only thing that makes the version visible', async () => {
    const { proxy, order } = recording(storage)
    const ctx = new Context()
    await ctx.plugin(R2SyncService, { storage: proxy })
    await (ctx as any).r2Sync.promote({ adapter: NAME, job_id: 'train-20261125-a-1', path: dir })
    expect(order, 'nothing was written').toContain('adapters/_index.json')
    expect(order[order.length - 1]).toBe('adapters/_index.json')
    // Artifacts precede it, which is the whole point: the pointer moves only over written bytes.
    expect(order.slice(0, -1)).toEqual([
      'adapters/coding/v000001/adapter_config.json',
      'adapters/coding/v000001/adapter_model.safetensors',
      'adapters/coding/v000001/manifest.json',
    ])
  })

  it('the index holds latest plus the version entry with job provenance', async () => {
    const { sync } = await boot(storage, dir)
    await sync.promote({ adapter: NAME, job_id: 'train-20261125-a-1', path: dir, records: 412, base_model: 'Qwen/Qwen3.5-4B' })
    const index = JSON.parse((await storage.get('adapters/_index.json'))!)
    expect(index.adapters.coding.latest).toBe(1)
    expect(index.adapters.coding.versions['1']).toMatchObject({ records: 412,
      job_id: 'train-20261125-a-1', base_model: 'Qwen/Qwen3.5-4B',
    })
    expect(typeof index.adapters.coding.versions['1'].trained_at).toBe('string')
    // No alias map anymore: @latest is derived from `latest`.
    expect(index.aliases).toBeUndefined()
  })

  it('the version manifest names the job, the base and the artifact files', async () => {
    const { sync } = await boot(storage, dir)
    const r = await sync.promote({ adapter: NAME, job_id: 'train-20261125-a-1', path: dir, base_model: 'Qwen/Qwen3.5-4B', records: 412 })
    const manifest = JSON.parse((await storage.get(`${r.prefix}manifest.json`))!)
    expect(manifest).toMatchObject({ id: 'coding@000001', version: 1, training_run: 'train-20261125-a-1', base_model: 'Qwen/Qwen3.5-4B' })
  })
})

describe('versioning across promotions', () => {
  it('increments within a lineage and leaves older bytes alone', async () => {
    const storage = new MemoryStorage()
    const { sync } = await boot(storage, artifactDir())
    const first = await sync.promote({ adapter: NAME, job_id: 'j1', path: artifactDir() })
    const second = await sync.promote({ adapter: NAME, job_id: 'j2', path: artifactDir() })
    expect([first.version, second.version]).toEqual([1, 2])
    expect(await storage.get('adapters/coding/v000001/adapter_model.safetensors')).toBeTruthy()
    const index = JSON.parse((await storage.get('adapters/_index.json'))!)
    expect(index.adapters.coding.latest).toBe(2)
    expect(Object.keys(index.adapters.coding.versions).sort()).toEqual(['1', '2'])
  })

  it('a different lineage gets its own numbering', async () => {
    const storage = new MemoryStorage()
    const { sync } = await boot(storage, artifactDir())
    await sync.promote({ adapter: 'coding', job_id: 'j1', path: artifactDir() })
    const research = await sync.promote({ adapter: 'research', job_id: 'j2', path: artifactDir() })
    expect(research.version).toBe(1)
    const index = JSON.parse((await storage.get('adapters/_index.json'))!)
    expect(index.adapters.coding.latest).toBe(1)
  })
})

describe('failure leaves the previous version valid (Review Focus #9)', () => {
  it('an upload that dies mid-way keeps the old latest and writes no index entry', async () => {
    const storage = new MemoryStorage()
    const good = artifactDir()
    const { sync } = await boot(storage, good)
    await sync.promote({ adapter: NAME, job_id: 'j1', path: good })

    // Second promotion: the safetensors upload fails.
    const original = storage.put.bind(storage)
    let calls = 0
    ;(storage as any).put = async (key: string, body: string | Uint8Array) => {
      if (key.endsWith('adapter_model.safetensors') && ++calls === 1) throw new Error('connection reset')
      return original(key, body)
    }
    await expect(sync.promote({ adapter: NAME, job_id: 'j2', path: artifactDir() })).rejects.toBeDefined()

    const index = JSON.parse((await storage.get('adapters/_index.json'))!)
    expect(index.adapters.coding.latest, 'a dead upload must not move the pointer').toBe(1)
    expect(index.adapters.coding.versions['2']).toBeUndefined()
    expect(await storage.get('adapters/coding/v000001/adapter_model.safetensors')).toBeTruthy()
  })

  it('a read-back mismatch is refused, so the index never points at unverifiable bytes', async () => {
    const storage = new MemoryStorage()
    const dir = artifactDir()
    const { sync } = await boot(storage, dir)
    const originalGet = storage.get.bind(storage)
    ;(storage as any).get = async (key: string) => (key.endsWith('adapter_model.safetensors') ? 'corrupted' : await originalGet(key))
    await expect(sync.promote({ adapter: NAME, job_id: 'j9', path: dir })).rejects.toThrow(/verify|read-back|mismatch/i)
    const index = await storage.get('adapters/_index.json')
    expect(index ? JSON.parse(index).adapters.coding.latest : undefined).toBeUndefined()
  })

  it('an artifact directory with no adapter files promotes nothing', async () => {
    const storage = new MemoryStorage()
    const empty = mkdtempSync(join(tmpdir(), 'saip-noart-'))
    const { sync } = await boot(storage, empty)
    await expect(sync.promote({ adapter: NAME, job_id: 'j0', path: empty })).rejects.toThrow(/adapter_config|missing/i)
    expect(await storage.get('adapters/_index.json')).toBeUndefined()
  })
})

describe('rollback', () => {
  it('re-points latest to an older version without touching artifact bytes', async () => {
    const storage = new MemoryStorage()
    const { sync } = await boot(storage, artifactDir())
    await sync.promote({ adapter: NAME, job_id: 'j1', path: artifactDir() })
    await sync.promote({ adapter: NAME, job_id: 'j2', path: artifactDir() })
    await sync.rollback(NAME, 1)
    const index = JSON.parse((await storage.get('adapters/_index.json'))!)
    expect(index.adapters.coding.latest).toBe(1)
    expect(index.adapters.coding.versions['2'], 'the version stays available').toBeTruthy()
    expect(await storage.get('adapters/coding/v000002/adapter_model.safetensors')).toBeTruthy()
  })

  it('refuses to roll back to a version that was never promoted', async () => {
    const storage = new MemoryStorage()
    const { sync } = await boot(storage, artifactDir())
    await sync.promote({ adapter: NAME, job_id: 'j1', path: artifactDir() })
    await expect(sync.rollback(NAME, 7)).rejects.toThrow(/7/)
  })
})

describe('promotion against the S3-shaped endpoint', () => {
  it('round-trips real PUT/GET bytes through R2StorageProvider', async () => {
    const fake = await startFakeS3()
    try {
      const storage = new R2StorageProvider({ endpoint: fake.baseUrl, bucket: 'loop', accessKeyId: FAKE_ACCESS_KEY, secretAccessKey: FAKE_SECRET_KEY })
      const dir = artifactDir({ 'adapter_model.safetensors': 'binary-ish-\x00\x01bytes' })
      const ctx = new Context()
      await ctx.plugin(R2SyncService, { storage })
      const r = await (ctx as any).r2Sync.promote({ adapter: NAME, job_id: 'jr1', path: dir })
      expect(await storage.get(`${r.prefix}adapter_model.safetensors`)).toBe('binary-ish-\x00\x01bytes')
      const index = JSON.parse((await storage.get('adapters/_index.json'))!)
      expect(index.adapters.coding.latest).toBe(1)
    } finally { await fake.close() }
  })
})
