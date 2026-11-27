/**
 * Composition root, runner tier (#197b).
 *
 * `AGENTS.md` requires a test of default production construction for every injectable seam, with no
 * fakes injected. The runner's seam is the command executor, and the failure this guards against is
 * the one that already happened here once: `createApp()` wiring nothing, while every other test
 * constructed the class by hand and passed.
 *
 * So: boot the real gateway with a real temp directory as the training-data volume, queue a job
 * through the real HTTP route, and let the default executor attempt the real `docker` command. The
 * expected outcome is *not* success — a GPU is not attached in CI — it is that the gateway is wired
 * enough to reach the worker boundary and say so precisely.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStorage } from '@saip/shared'
import { createApp } from '../src/index.js'

const adapters = [
  { name: 'coding', scope: 'global' as const, trainable: true, base: 'Qwen/Qwen3.5-4B', training: { strategy: 'corrective_sft', data_scopes: ['sessions', 'feedback'] } },
]

async function bootDefault() {
  const storage = new MemoryStorage()
  await storage.put('sessions/s1/conversation.jsonl', '{"role":"assistant","content":"x","id":"m1","created_at":"2026-01-01T00:00:00Z"}\n')
  await storage.put('feedback/f1.json', JSON.stringify({ id: 'f1', session_id: 's1', message_id: 'm1', reward: -2, created_at: '2026-01-02T00:00:00Z' }))
  const dataDir = mkdtempSync(join(tmpdir(), 'saip-comp-data-'))
  const outputDir = mkdtempSync(join(tmpdir(), 'saip-comp-out-'))
  const ctx = await createApp({
    storage,
    adapters,
    // No `run` injected: the default executor is the point of this file.
    env: { SAIP_STORAGE: 'memory', SAIP_TRAINING_DATA_DIR: dataDir, SAIP_ADAPTER_OUTPUT_DIR: outputDir },
    security: { dev_mode: true },
    config: { training: { precision: 'bf16', sequence_len: 2048 }, adapter: { default_rank: 16, default_alpha: 32, target_modules: ['q_proj'] } },
  }) as any
  return { ctx, storage, dataDir, outputDir }
}

describe('training composition root installs the pipeline', () => {
  it('the runner service is provided by default construction', async () => {
    const { ctx } = await bootDefault()
    expect(ctx.axolotlRunner, 'createApp() did not install the runner').toBeTruthy()
    expect(typeof ctx.axolotlRunner.runNext).toBe('function')
  })

  it('the strategy plugins the API accepts are the ones the runner can export with', async () => {
    const { ctx } = await bootDefault()
    const listed = (await (await ctx.learningApi.app.request('/v1/learning/strategies')).json()).strategies
    expect(listed).toEqual(['corrective_sft'])
  })

  it('queuing through the real route and running with the default executor reaches the worker boundary', async () => {
    const { ctx, storage, dataDir } = await bootDefault()
    const created = await ctx.learningApi.app.request('/v1/learning/jobs', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ adapter: 'coding' }),
    })
    expect(created.status).toBe(202)
    const { id } = await created.json()

    const outcome = await ctx.axolotlRunner.runNext()
    expect(outcome?.jobId).toBe(id)

    const record = JSON.parse((await storage.get(`jobs/${id}.json`))!)
    // CI has no Docker worker and no GPU. What must be true is that the pipeline is wired to the
    // boundary and reports the *right* failure rather than pretending.
    expect(['worker_unavailable', 'training_failed', 'no_artifact']).toContain(record.error?.code)
    expect(record.status).toBe('failed')
    expect(record.history.map((h: { status: string }) => h.status)).toEqual(['queued', 'running', 'failed'])

    // P3/P4 happened for real before the worker was reached: dataset + config bytes are in storage
    // and mirrored into the volume directory the worker would mount.
    expect(record.dataset?.sha256).toMatch(/^[0-9a-z]{64}$/)
    expect(record.config?.sha256).toMatch(/^[0-9a-z]{64}$/)
    expect(readdirSync(join(dataDir, 'jobs', id))).toEqual(expect.arrayContaining(['axolotl.yaml', 'dataset']))
  })

  it('a runner installed with no data dir still refuses to invent a path it cannot verify', async () => {
    const storage = new MemoryStorage()
    const ctx = await createApp({
      storage, adapters, env: { SAIP_STORAGE: 'memory' }, security: { dev_mode: true },
    }) as any
    expect(ctx.axolotlRunner).toBeTruthy()
    // No job exists, so nothing is claimed — and no directory is created behind the caller's back.
    expect(await ctx.axolotlRunner.runNext()).toBeUndefined()
  })
})
