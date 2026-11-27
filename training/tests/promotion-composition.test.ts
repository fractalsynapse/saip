/**
 * Promotion wiring at the composition root (#198b).
 *
 * `r2Sync` exists as a class; that is not the same as the gateway promoting when a training run
 * finishes. This file constructs the app the way `createApp()` does — no injected sync service, no
 * manual call — feeds it an artifact directory, and asserts the bucket ends up with a version the
 * serving side could resolve, plus a job record carrying `version`.
 *
 * The failure paths matter as much as the happy one: an adapter that trained but could not be
 * uploaded must land on the record as `failed`, because a `succeeded` job whose bytes never reached
 * storage is precisely the lie the persisted record exists to prevent.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStorage } from '@saip/shared'
import { createApp } from '../src/index.js'
import { seededStore } from './helpers/corpus.js'

const adapters = [
  { name: 'coding', scope: 'global' as const, trainable: true, base: 'Qwen/Qwen3.5-4B', training: { strategy: 'corrective_sft', data_scopes: ['sessions', 'feedback'] } },
]

function artifacts(base = 'Qwen/Qwen3.5-4B') {
  const dir = mkdtempSync(join(tmpdir(), 'saip-promote-'))
  writeFileSync(join(dir, 'adapter_config.json'), JSON.stringify({ r: 16, lora_alpha: 32, base_model_name_or_path: base }))
  writeFileSync(join(dir, 'adapter_model.safetensors'), 'loRA-WEIGHTS')
  return dir
}

async function app() {
  const storage = await seededStore()
  const ctx = await createApp({
    storage,
    adapters,
    env: { SAIP_STORAGE: 'memory', SAIP_TRAINING_DATA_DIR: mkdtempSync(join(tmpdir(), 'saip-d-')), SAIP_ADAPTER_OUTPUT_DIR: mkdtempSync(join(tmpdir(), 'saip-o-')) },
    security: { dev_mode: true },
    config: { training: { precision: 'bf16' }, adapter: { default_rank: 16, default_alpha: 32, target_modules: ['q_proj'] } },
  }) as any
  return { ctx, storage }
}

describe('createApp() promotes trained adapters on the event', () => {
  it('installs r2Sync without anything being injected', async () => {
    const { ctx } = await app()
    expect(ctx.r2Sync, 'the root did not install the promotion plugin').toBeTruthy()
    expect(typeof ctx.r2Sync.promote).toBe('function')
  })

  it('learning/adapter-trained writes a version, the index, and the job record', async () => {
    const { ctx, storage } = await app()
    const created = await ctx.learningApi.app.request('/v1/learning/jobs', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ adapter: 'coding' }),
    })
    const { id } = await created.json()
    await ctx.learningApi.store.transition(id, 'running')
    const dir = artifacts()

    ctx.emit('learning/adapter-trained', { adapter: 'coding', job_id: id, path: dir })
    // The listener runs asynchronously; settle the microtask queue before asserting.
    await new Promise((r) => setTimeout(r, 50))

    const index = JSON.parse((await storage.get('adapters/_index.json'))!)
    expect(index.adapters.coding.latest).toBe(1)
    expect(index.adapters.coding.versions['1'].job_id).toBe(id)
    expect(await storage.get('adapters/coding/v000001/adapter_model.safetensors')).toBe('loRA-WEIGHTS')

    const record = JSON.parse((await storage.get(`jobs/${id}.json`))!)
    expect(record.version).toBe(1)
    expect(record.status).toBe('running', 'promotion assigns a version; it does not change the lifecycle')
  })

  it('a promotion that cannot upload leaves the job failed, not succeeded-with-nothing', async () => {
    const { ctx, storage } = await app()
    const created = await ctx.learningApi.app.request('/v1/learning/jobs', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ adapter: 'coding' }),
    })
    const { id } = await created.json()
    await ctx.learningApi.store.transition(id, 'running')

    // Missing artifact directory — exactly what a worker that exited 0 on an empty output produces.
    const nowhere = join(mkdtempSync(join(tmpdir(), 'saip-empty-')), 'nope')
    ctx.emit('learning/adapter-trained', { adapter: 'coding', job_id: id, path: nowhere })
    await new Promise((r) => setTimeout(r, 50))

    const record = JSON.parse((await storage.get(`jobs/${id}.json`))!)
    expect(record.status).toBe('failed')
    expect(record.error.code).toBe('no_artifact')
    expect(await storage.get('adapters/_index.json'), 'no index was written for a failed promotion').toBeUndefined()
  })
})
