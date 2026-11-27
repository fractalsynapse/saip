/**
 * The Axolotl runner: P4 → P5 → P6 for one job at a time (#197b).
 *
 * The runner owns the lifecycle and the worker owns the GPU. That split is the reason P5 executes
 * `docker exec` rather than leaving a marker file for the worker to poll: a polled marker is a second
 * state machine, invisible in the record, where the API believes one thing and the worker another —
 * and the disagreement surfaces as a job stuck in `running` forever. Here the verdict is an exit code
 * plus a directory listing, both of which are outside this process and cannot lie about themselves.
 *
 * Single-flight by construction: one card, one running job, claimed oldest-`created_at` first.
 *
 * `run` is injectable because this gateway reaches the Docker daemon as a host process — there is no
 * socket mounted into the container, and adding one would hand the training API root-equivalent
 * control of the host. Inside a container the runner reports `worker_unavailable` instead of failing a
 * job for an infrastructure choice it cannot see past.
 */
import { Service } from 'cordis'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AdapterDefinition, LearningJobRecord, StorageProvider } from '@saip/shared'
import { JobStore } from '../lib/job-store.js'
import { materializeConfig } from '../lib/axolotl-config.js'
import { containerPath } from '../lib/workspace.js'
import { exportDataset } from '../lib/dataset-export.js'
import type { TrainingStrategyPlugin } from '../lib/strategy.js'
import { CorrectiveSftService, asPlugin } from './strategy-corrective-sft.js'
import { Context } from 'cordis'

declare module 'cordis' {
  interface Context {
    axolotlRunner?: AxolotlRunnerService
  }
  interface Events {
    /** P6 done, P7 waiting: promotion (#198b) consumes this and nothing else. */
    'learning/adapter-trained'(payload: { adapter: string; job_id: string; path: string }): void
  }
}

export interface RunResult { code: number; stdout: string; stderr: string }
export type RunCommand = (command: string, args: string[], opts: { env?: Record<string, string> }) => Promise<RunResult>

export interface AxolotlRunnerConfig {
  storage: StorageProvider
  adapters?: AdapterDefinition[]
  config?: { training?: Record<string, unknown>; adapter?: { default_rank?: number; default_alpha?: number; target_modules?: string[] } }
  /** Directory that the worker mounts as /app/data. */
  dataDir?: string
  /** Directory that the worker mounts as /app/output (the `adapter-output` volume). */
  outputDir?: string
  /** Container name executing the training. */
  container?: string
  /** Injectable execution; defaults to spawning `docker`. */
  run?: RunCommand
  /** Injectable strategy plugins; defaults to what this build ships. */
  strategies?: TrainingStrategyPlugin[]
}

const LOG_TAIL_CHARS = 3000

export class AxolotlRunnerService extends Service {
  static readonly provide = 'axolotlRunner'
  private readonly store: JobStore
  private readonly adapters: AdapterDefinition[]
  private readonly strategies: TrainingStrategyPlugin[]
  private readonly run: RunCommand
  private busy = false

  constructor(ctx: any, private readonly cfg: AxolotlRunnerConfig) {
    super(ctx, 'axolotlRunner')
    this.store = new JobStore(cfg.storage)
    this.adapters = cfg.adapters ?? []
    this.strategies = cfg.strategies ?? [asPlugin(new CorrectiveSftService(new Context()))]
    this.run = cfg.run ?? defaultRun
  }

  /** The job's artifact directory on the host side of the volume. */
  private outputFor(jobId: string): string {
    return join(this.cfg.outputDir ?? '/var/lib/saip/adapter-output', jobId)
  }

  /** Path inside the worker container, which mounts dataDir as /app/data. */
  private containerConfigPath(jobId: string): string {
    return containerPath(jobId, 'axolotl.yaml')
  }

  /**
   * Claim and execute the oldest queued job, if one exists.
   *
   * Returns undefined when there is nothing to do or another job is in flight — the GPU is one card,
   * and two concurrent `axolotl train` runs on it do not both succeed.
   */
  async runNext(): Promise<{ jobId: string; status: 'succeeded' | 'failed' } | undefined> {
    if (this.busy) return undefined
    const queued = await this.store.list({ status: 'queued', limit: 1 })
    const next = queued.entries[0]
    if (!next) return undefined

    this.busy = true
    try {
      return await this.execute(next)
    } finally {
      this.busy = false
    }
  }

  private async execute(job: LearningJobRecord): Promise<{ jobId: string; status: 'succeeded' | 'failed' }> {
    const dataDir = this.cfg.dataDir ?? '/app/data'
    const outDir = this.outputFor(job.id)
    mkdirSync(outDir, { recursive: true })

    const adapter = this.adapters.find((a) => a.name === job.adapter)
    if (!adapter) {
      await this.store.transition(job.id, 'failed', { error: { code: 'adapter_not_found', message: `adapter "${job.adapter}" is not in the registry` } })
      return { jobId: job.id, status: 'failed' }
    }

    // running first, persisted before the worker is touched: a job whose process died mid-launch must
    // be visible as interrupted at next boot, not as queued-and-never-started.
    const running = await this.store.transition(job.id, 'running') ?? job

    // P2–P3 dataset
    let dataset
    try {
      dataset = await exportDataset({ job: running, storage: this.cfg.storage, strategies: this.strategies, mirrorDir: dataDir })
    } catch (e) {
      const code = /no strategy plugin/.test((e as Error).message) ? 'unknown_strategy' : 'no_dataset_rows'
      await this.store.transition(job.id, 'failed', { error: { code, message: (e as Error).message } }, tail(e))
      return { jobId: job.id, status: 'failed' }
    }

    // P4 config
    let config
    try {
      config = await materializeConfig({
        job: running, adapter, config: this.cfg.config ?? {}, dataDir, storage: this.cfg.storage, mirrorDir: dataDir,
        hfTokenName: process.env.SAIP_HF_TOKEN ? 'SAIP_HF_TOKEN' : undefined,
      })
    } catch (e) {
      const code = (e as { code?: string }).code ?? 'config_failed'
      await this.store.transition(job.id, 'failed', { error: { code, message: (e as Error).message } }, tail(e))
      return { jobId: job.id, status: 'failed' }
    }

    // Artifact hashes are recorded, not announced as a transition: the job was already running.
    await this.store.annotate(job.id, { dataset, config })

    // P5 execution. The token is handed to the worker as an environment variable, never written into
    // the stored config bytes.
    const container = this.cfg.container ?? 'axolotl-worker'
    const args = ['exec', '-e', 'HF_HOME=/root/.cache/huggingface', container, 'axolotl', 'train', this.containerConfigPath(job.id)]
    if (process.env.SAIP_HF_TOKEN) args.splice(2, 0, '-e', 'HF_HUB_TOKEN')
    const env: Record<string, string> = {}
    if (process.env.SAIP_HF_TOKEN) env.HF_HUB_TOKEN = process.env.SAIP_HF_TOKEN

    let result: RunResult
    try {
      result = await this.run('docker', args, { env })
    } catch (e) {
      await this.store.transition(job.id, 'failed', {
        error: { code: 'worker_unavailable', message: `cannot reach the training worker: ${(e as Error).message}` },
      }, tail(e))
      return { jobId: job.id, status: 'failed' }
    }

    if (result.code !== 0) {
      await this.store.transition(job.id, 'failed', {
        error: { code: 'training_failed', message: `axolotl exited ${result.code}` },
      }, tail(result))
      return { jobId: job.id, status: 'failed' }
    }

    // P6 validation: the exit code is not the verdict, the artifact is.
    const missing = ['adapter_config.json', 'adapter_model.safetensors'].filter(
      (f) => !existsSync(join(outDir, f)) || statSync(join(outDir, f)).size === 0,
    )
    if (missing.length) {
      await this.store.transition(job.id, 'failed', {
        error: { code: 'no_artifact', message: `worker exited 0 but wrote no ${missing.join(' or ')}` },
      }, tail(result))
      return { jobId: job.id, status: 'failed' }
    }

    const artifact = { prefix: outDir, base_model: adapter.base ?? '' }
    await this.store.transition(job.id, 'succeeded', { artifact }, `exit 0; artifact at ${outDir}`)
    this.ctx.emit('learning/adapter-trained', { adapter: job.adapter, job_id: job.id, path: outDir })
    return { jobId: job.id, status: 'succeeded' }
  }

  /** Write a stub artifact set — used by the opt-in hardware tier to prove the plumbing without a GPU. */
  writeStubArtifact(jobId: string, files: Record<string, string>): string {
    const dir = this.outputFor(jobId)
    mkdirSync(dir, { recursive: true })
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body, 'utf8')
    return dir
  }
}

function tail(x: unknown): string {
  const text = x instanceof Error
    ? x.message
    : [`${(x as RunResult)?.stderr ?? ''}`, `${(x as RunResult)?.stdout ?? ''}`].filter(Boolean).join('\n')
  return text.length > LOG_TAIL_CHARS ? `…${text.slice(-LOG_TAIL_CHARS)}` : text
}

const defaultRun: RunCommand = (command, args, opts) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { env: { ...process.env, ...(opts.env ?? {}) } })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (c) => { stdout += c.toString() })
  child.stderr?.on('data', (c) => { stderr += c.toString() })
  child.on('error', reject)
  child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
})
