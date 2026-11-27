/**
 * P4–P6: materialize the config, run the worker, judge the artifact (#197b).
 *
 * The design record's whole argument is that these stages communicate through storage keys and exit
 * codes rather than in-process state, so the tests treat the worker as an external process whose
 * *output directory* is the only honest report it gives.
 *
 * Review Focus #8 is the one that would otherwise slip through: a worker that exits 0 having written
 * nothing — wrong path, silent preemption, an image that changed its output layout — reads as
 * success to anything judging by exit code alone. So "exit 0 + empty directory" is a required test,
 * and it must produce `no_artifact`, not a `succeeded` record pointing at bytes that do not exist.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { Context } from 'cordis'
import { mkdtempSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStorage, type LearningJobRecord, type StorageProvider } from '@saip/shared'
import { buildAxolotlConfig, materializeConfig } from '../src/lib/axolotl-config.js'
import { AxolotlRunnerService } from '../src/plugins/axolotl-runner.js'

const adapters = [
  {
    name: 'coding', scope: 'global' as const, trainable: true, base: 'Qwen/Qwen3.5-4B',
    training: { strategy: 'corrective_sft', data_scopes: ['sessions', 'feedback'] },
  },
  { name: 'orphan', scope: 'global' as const, trainable: true, training: { strategy: 'corrective_sft', data_scopes: ['sessions', 'feedback'] } },
]

const profileConfig = {
  training: { precision: 'bf16', sequence_len: 2048, gradient_checkpointing: true, optimizer: 'adamw_bnb_8bit' },
  adapter: { default_rank: 16, default_alpha: 32, target_modules: ['q_proj', 'k_proj', 'v_proj', 'o_proj', 'gate_proj', 'up_proj', 'down_proj'] },
}

const job = (over: Partial<LearningJobRecord> = {}): LearningJobRecord => ({
  id: 'train-20261125-run-0001', caller: 'adrian', adapter: 'coding', strategy: 'corrective_sft',
  data_scopes: ['sessions', 'feedback'], params: {}, inherited: { strategy: true, data_scopes: true },
  status: 'queued', history: [], created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  ...over,
})

describe('P4 config materialization', () => {
  it('merges profile training block, adapter block, base, then job params — in that precedence', () => {
    const yaml = buildAxolotlConfig({
      job: job({ params: { epochs: 5, sequence_len: 1024 } }),
      adapter: adapters[0], config: profileConfig, dataDir: '/app/data',
    })
    expect(yaml).toMatch(/base_model:\s*Qwen\/Qwen3\.5-4B/)
    expect(yaml).toMatch(/sequence_len:\s*1024/)     // job params win over the profile block
    expect(yaml).toMatch(/gradient_checkpointing:\s*true/)
    expect(yaml).toMatch(/optimizer:\s*adamw_bnb_8bit/)
    expect(yaml).toMatch(/r:\s*16/)
    expect(yaml).toMatch(/lora_alpha:\s*32/)
    expect(yaml).toMatch(/q_proj/)
    expect(yaml).toMatch(/dataset:\s*\/app\/data\/jobs\/train-20261125-run-0001\/dataset\/corrective_sft\.jsonl/)
  })

  it('references the HF token by NAME only — never a value', () => {
    const yaml = buildAxolotlConfig({ job: job(), adapter: adapters[0], config: profileConfig, dataDir: '/app/data', hfTokenName: 'SAIP_HF_TOKEN' })
    expect(yaml).toMatch(/SAIP_HF_TOKEN/)
    expect(yaml).not.toMatch(/hf_[A-Za-z0-9]{20,}/)
  })

  it('a leaf without a base fails as no_base_model rather than borrowing model.base', () => {
    expect(() => buildAxolotlConfig({ job: job({ adapter: 'orphan' }), adapter: adapters[1], config: profileConfig, dataDir: '/app/data' }))
      .toThrow(/no_base_model|base/)
  })

  it('writes the config to jobs/<id>/axolotl.yaml and mirrors identical bytes', async () => {
    const storage: StorageProvider = new MemoryStorage()
    await storage.put(`jobs/${job().id}/dataset/corrective_sft.jsonl`, '{"role":"user"}\n')
    const dir = mkdtempSync(join(tmpdir(), 'saip-mirror-'))
    const out = await materializeConfig({ job: job(), adapter: adapters[0], config: profileConfig, storage, mirrorDir: dir })
    const stored = await storage.get(`jobs/${job().id}/axolotl.yaml`)
    expect(stored).toBeTruthy()
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/)
    const mirrored = require('node:fs').readFileSync(join(dir, 'jobs', job().id, 'axolotl.yaml'), 'utf8')
    expect(mirrored).toBe(stored)
  })
})

describe('P5/P6 runner lifecycle', () => {
  let storage: MemoryStorage

  async function runner(run: (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>, outDir: string) {
    const ctx = new Context()
    await ctx.plugin(AxolotlRunnerService, {
      storage, adapters, config: profileConfig, dataDir: mkdtempSync(join(tmpdir(), 'saip-data-')),
      outputDir: outDir, run,
    })
    return (ctx as any).axolotlRunner
  }

  beforeEach(async () => {
    storage = new MemoryStorage()
    await storage.put('sessions/s1/conversation.jsonl', '{"role":"assistant","content":"x","id":"m1","created_at":"2026-01-01T00:00:00Z"}\n')
    await storage.put('feedback/f1.json', JSON.stringify({ id: 'f1', session_id: 's1', message_id: 'm1', reward: -3, created_at: '2026-01-02T00:00:00Z' }))
    // Seeded the way the API writes it, history included, so the assertions below read as real.
    await storage.put('jobs/train-20261125-run-0001.json', JSON.stringify(job({ history: [{ at: '2026-01-01T00:00:00Z', status: 'queued' }] })))
    await storage.put('jobs/_index.json', JSON.stringify({ jobs: { 'train-20261125-run-0001': { status: 'queued', adapter: 'coding', strategy: 'corrective_sft', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' } } }))
  })

  it('claims the oldest queued job and records running before executing', async () => {
    const seen: string[] = []
    const outDir = mkdtempSync(join(tmpdir(), 'saip-out-'))
    const r = await runner(async () => {
      // Read the record from inside the "worker": running must already be persisted.
      const rec = JSON.parse((await storage.get('jobs/train-20261125-run-0001.json'))!)
      seen.push(rec.status)
      const dir = join(outDir, 'train-20261125-run-0001')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'adapter_config.json'), '{}')
      writeFileSync(join(dir, 'adapter_model.safetensors'), 'bytes')
      return { code: 0, stdout: 'done', stderr: '' }
    }, outDir)
    const result = await r.runNext()
    expect(result?.jobId).toBe('train-20261125-run-0001')
    expect(seen).toEqual(['running'])
    const rec = JSON.parse((await storage.get('jobs/train-20261125-run-0001.json'))!)
    expect(rec.history.map((h: { status: string }) => h.status)).toEqual(['queued', 'running', 'succeeded'])
  })

  it('exit 0 with an empty output directory is no_artifact, not success (Review Focus #8)', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'saip-empty-'))
    const r = await runner(async () => ({ code: 0, stdout: '', stderr: '' }), empty)
    const result = await r.runNext()
    expect(result?.status).toBe('failed')
    const rec = JSON.parse((await storage.get('jobs/train-20261125-run-0001.json'))!)
    expect(rec.status).toBe('failed')
    expect(rec.error.code).toBe('no_artifact')
    expect(readdirSync(join(empty, 'train-20261125-run-0001')), 'nothing was promoted').toEqual([])
  })

  it('a non-zero exit fails with training_failed and keeps the log tail in history', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'saip-out2-'))
    const r = await runner(async () => ({ code: 137, stdout: '', stderr: 'CUDA out of memory\nline two\n'.repeat(40) }), outDir)
    await r.runNext()
    const rec = JSON.parse((await storage.get('jobs/train-20261125-run-0001.json'))!)
    expect(rec.error.code).toBe('training_failed')
    expect(rec.history.at(-1).detail).toMatch(/CUDA out of memory/)
    expect(String(rec.history.at(-1).detail).length).toBeLessThan(4000)
  })

  it('an unreachable worker reports worker_unavailable instead of a fake failure', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'saip-out3-'))
    const r = await runner(async () => { throw Object.assign(new Error('docker: command not found'), { code: 'ENOENT' }) }, outDir)
    await r.runNext()
    const rec = JSON.parse((await storage.get('jobs/train-20261125-run-0001.json'))!)
    expect(rec.error.code).toBe('worker_unavailable')
  })

  it('runs only one job at a time — the second claim sees nothing to do', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'saip-out4-'))
    let during: string | null = null
    const r = await runner(async () => {
      during = (await r.runNext()) ? 'claimed' : 'idle'
      const dir = join(outDir, 'train-20261125-run-0001')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'adapter_config.json'), '{}')
      writeFileSync(join(dir, 'adapter_model.safetensors'), 'x')
      return { code: 0, stdout: '', stderr: '' }
    }, outDir)
    await r.runNext()
    expect(during).toBe('idle')
  })

  it('emits learning/adapter-trained with the artifact path on success', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'saip-out5-'))
    const events: any[] = []
    const ctx = new Context()
    ctx.on('learning/adapter-trained', (p: any) => events.push(p))
    await ctx.plugin(AxolotlRunnerService, {
      storage, adapters, config: profileConfig, dataDir: mkdtempSync(join(tmpdir(), 'saip-d-')), outputDir: outDir,
      run: async () => {
        const dir = join(outDir, 'train-20261125-run-0001')
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'adapter_config.json'), '{}')
        writeFileSync(join(dir, 'adapter_model.safetensors'), 'weights')
        return { code: 0, stdout: '', stderr: '' }
      },
    })
    await (ctx as any).axolotlRunner.runNext()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ adapter: 'coding', job_id: 'train-20261125-run-0001' })
    expect(existsSync(events[0].path)).toBe(true)
    // The record carries where the artifact lives, which is what promotion (#198b) reads.
    const rec = JSON.parse((await storage.get('jobs/train-20261125-run-0001.json'))!)
    expect(rec.artifact).toMatchObject({ base_model: 'Qwen/Qwen3.5-4B' })
    expect(rec.dataset?.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(rec.config?.sha256).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('the volume and the worker agree on the layout (#197b)', () => {
  it('a mirrored file is exactly where the container path points', async () => {
    const { containerPath, hostPath, CONTAINER_DATA_ROOT } = await import('../src/lib/workspace.js')
    const dataDir = mkdtempSync(join(tmpdir(), 'saip-ws-'))
    const id = 'train-20261125-ws-0001'

    const storage: StorageProvider = new MemoryStorage()
    await storage.put('sessions/s1/conversation.jsonl', '{"role":"assistant","content":"x","id":"m1","created_at":"2026-01-01T00:00:00Z"}\n')
    await storage.put('feedback/f1.json', JSON.stringify({ id: 'f1', session_id: 's1', message_id: 'm1', reward: -2, created_at: '2026-01-02T00:00:00Z' }))
    const { exportDataset } = await import('../src/lib/dataset-export.js')
    const { CorrectiveSftService } = await import('../src/plugins/strategy-corrective-sft.js')
    const ctx = new Context()
    await ctx.plugin(CorrectiveSftService, {})

    const dataset = await exportDataset({
      job: job({ id }), storage, strategies: [(ctx as any).correctiveSft], mirrorDir: dataDir,
    })
    const cfg = await materializeConfig({
      job: job({ id }), adapter: adapters[0], config: profileConfig, storage, mirrorDir: dataDir,
    })

    // The bug this pins: the gateway wrote <dataDir>/<id>/… while the runner told the worker
    // /app/data/jobs/<id>/…  — training could never open its own config.
    expect(existsSync(dataset.mirror!)).toBe(true)
    expect(existsSync(cfg.mirror!)).toBe(true)
    expect(dataset.mirror!.startsWith(join(dataDir, 'jobs', id))).toBe(true)
    const containerConfig = containerPath(id, 'axolotl.yaml')
    expect(containerConfig.startsWith(CONTAINER_DATA_ROOT)).toBe(true)
    expect(hostPath(dataDir, id, 'axolotl.yaml')).toBe(cfg.mirror)
    // A docker shim resolving the container path against the host must land on the mirrored file.
    const resolved = containerConfig.replace(CONTAINER_DATA_ROOT, dataDir)
    expect(existsSync(resolved)).toBe(true)
  })
})

describe('secret scan over everything the job writes', () => {
  it('no configured secret value appears in dataset, config, or record bytes', async () => {
    const storage: StorageProvider = new MemoryStorage()
    const secret = 'hf_SUPERSECRETVAlUE_0123456789abcdef'
    await storage.put('sessions/s1/conversation.jsonl', '{"role":"assistant","content":"x","id":"m1","created_at":"2026-01-01T00:00:00Z"}\n')
    await storage.put('feedback/f1.json', JSON.stringify({ id: 'f1', session_id: 's1', message_id: 'm1', reward: 2, created_at: '2026-01-02T00:00:00Z' }))
    const { JobStore } = await import('../src/lib/job-store.js')
    const store = new JobStore(storage)
    const j = job()
    await store.create(j)

    const dir = mkdtempSync(join(tmpdir(), 'saip-scan-'))
    const { exportDataset } = await import('../src/lib/dataset-export.js')
    const { CorrectiveSftService } = await import('../src/plugins/strategy-corrective-sft.js')
    const ctx = new Context()
    await ctx.plugin(CorrectiveSftService, {})
    const dataset = await exportDataset({ job: j, storage, strategies: [(ctx as any).correctiveSft], mirrorDir: dir })
    const cfg = await materializeConfig({ job: j, adapter: adapters[0], config: profileConfig, storage, mirrorDir: dir, hfTokenName: 'SAIP_HF_TOKEN' })
    const record = await store.get(j.id)

    const { scanForSecrets } = await import('../src/lib/secret-scan.js')
    const hits = scanForSecrets(
      { dataset: await storage.get(dataset.key)!, config: await storage.get(cfg.key)!, record: JSON.stringify(record) },
      [secret],
    )
    expect(hits).toEqual([])

    // And the scan is capable of failing: put the value where it must never be.
    const dirty = scanForSecrets({ dataset: `token: ${secret}` }, [secret])
    expect(dirty).toEqual(['dataset'])
  })
})
