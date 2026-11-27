/**
 * SAIP Training Gateway — Cordis application entry point
 *
 * Composes the training plugins: shared adapter registry service, auth, learning
 * API (strategy registration + job linkage), Axolotl runner, and R2 sync as those
 * are implemented.
 */

import { Context } from 'cordis'
import { AdapterRegistryService, SecretsService } from '@saip/shared/services'
import { BearerTokenAuth, MemoryStorage, AllowAllDevAuth, MetricsService, loadYamlConfig, storageProviderFor, defaultSecretsProvider,
  type AuthProvider, type MonitoringProvider, type SecretsProvider, type StorageConfig, type StorageProvider } from '@saip/shared'
import { LearningApiService } from './plugins/learning-api.js'
import { CorrectiveSftService, asPlugin } from './plugins/strategy-corrective-sft.js'
import { AxolotlRunnerService } from './plugins/axolotl-runner.js'
import { R2SyncService } from './plugins/r2-sync.js'
import type { TrainingStrategyPlugin } from './lib/strategy.js'
import { createMiddleware } from 'hono/factory'

export interface SecurityConfig {
  dev_mode?: boolean
  api_tokens?: Array<{ caller: string; token_secret: string }>
}

/** The slice of `saip.yaml` the training gateway reads for storage selection. */
export interface TrainingConfig {
  storage?: StorageConfig
  /** Profile-resolved training block, used as the floor for a generated Axolotl config. */
  training?: Record<string, unknown>
  /** Registry-wide LoRA defaults (rank, alpha, target modules). */
  adapter?: { default_rank?: number; default_alpha?: number; target_modules?: string[] }
}

export interface CreateAppOptions {
  /**
   * Resolved by `storageProviderFor()` when absent: `storage.r2` from config, credentials by
   * name (#198). Training writes `jobs/<id>.json` and promoted adapters there, so the same
   * fail-closed rule applies as at the inference gateway — a job record that lives in a Map is
   * not a job record.
   */
  storage?: StorageProvider
  config?: TrainingConfig
  /** Environment for selection. Defaults to process.env. */
  env?: NodeJS.ProcessEnv
  /** Defaults to the env → encrypted-store chain. */
  secrets?: SecretsProvider
  security?: SecurityConfig
  adapters?: any[]
  registeredStrategies?: string[]
  defaultAdapterFor?: (callerId?: string) => string | undefined
  monitoring?: MonitoringProvider
}

/**
 * Read the `storage:` block from `saip.yaml`. The training gateway had no config loader at all —
 * it took adapters/security by argument only — so an operator who configured a bucket in the file
 * still got the empty-bucket refusal, which reads as "your config is wrong" when the truth is that
 * nothing read the file. Absent/unreadable is reported by the selection error that follows, not
 * swallowed: `SAIP_R2_BUCKET is empty` plus a line saying the config could not be read is a
 * diagnosable pair; silence is not.
 */
function readStorageConfig(opts: CreateAppOptions): { config?: TrainingConfig; unreadable?: string } {
  if (opts.config) return { config: opts.config }
  const env = opts.env ?? process.env
  try {
    return { config: loadYamlConfig<TrainingConfig>(env.SAIP_CONFIG ?? 'saip.yaml', { env, envFile: env.SAIP_ENV_FILE }) }
  } catch (e) {
    return { unreadable: (e as Error).message }
  }
}

/** One line naming the selected store, never a secret value. */
function storageSummary(storage: StorageProvider): string {
  return storage instanceof MemoryStorage
    ? 'storage: EXPLICIT MEMORY — job records die at restart'
    : `storage: ${storage.constructor.name}`
}

function pickAuthProvider(security: SecurityConfig, secrets: any): AuthProvider {
  if (security.dev_mode) return new AllowAllDevAuth()
  return new BearerTokenAuth(security.api_tokens ?? [], secrets)
}

export { exportDataset } from './lib/dataset-export.js'
export type { DatasetExportOptions, DatasetExportResult } from './lib/dataset-export.js'
export { CorrectiveSftService } from './plugins/strategy-corrective-sft.js'
export { canonicalRow, compareRows, findStrategy } from './lib/strategy.js'
export type { StrategyRow, StrategyInput, TrainingStrategyPlugin } from './lib/strategy.js'
export { JobStore, newJobId, findSecretParam } from './lib/job-store.js'
export type { JobListQuery, JobListResult } from './lib/job-store.js'
export async function createApp(opts: CreateAppOptions = {}) {
  const ctx = new Context()
  await ctx.plugin(AdapterRegistryService)
  // Was `{ provider: new EnvSecrets() }`: env only, never the encrypted store. That made the
  // design record's premise false for this root — it assumed training already resolved
  // store → env like inference, and the R2 credentials #198 requires exist precisely to make
  // that the rule. The injected `env` is threaded through so a test's environment is the one the
  // chain reads; a provider consulting process.env instead is untestable (#86's lesson).
  await ctx.plugin(SecretsService, { provider: opts.secrets ?? defaultSecretsProvider(opts.env ?? process.env) })

  // Storage selection is fail-closed here exactly as it is at the inference gateway (#198):
  // no bucket means refuse to boot, never an in-process Map that a later job read would find
  // empty after a restart.
  const { config: fileConfig, unreadable } = readStorageConfig(opts)
  if (unreadable) process.stderr.write(`[saip-training] WARNING: could not read config: ${unreadable}\n`)
  const storage = opts.storage ?? await storageProviderFor({
    config: fileConfig, secrets: (ctx as any).secrets, env: opts.env ?? process.env,
    log: (line) => process.stderr.write(`[saip-training] ${line}\n`),
  })
  await ctx.plugin(MetricsService, { provider: opts.monitoring })

  process.stderr.write(`[saip-training] ${storageSummary(storage)}\n`)

  const security = opts.security ?? { dev_mode: false, api_tokens: [] }
  const provider = pickAuthProvider(security, (ctx as any).secrets)
  const authMiddleware = createMiddleware(async (c: any, next: any) => {
    const principal = await provider.verifyApi({ headers: { authorization: c.req.header('authorization') ?? c.req.header('Authorization') } })
    if (!principal) return c.json({ error: { message: 'authentication required', code: 'unauthorized' } }, 401)
    c.set('principal', principal)
    await next()
  })

  // Strategy plugins are installed here, at the root, so the API's accepted list is a fact about
  // this build rather than a string in a config file (#196b). `knowledge_embedding` and
  // `weighted_kto` are deliberately absent: the MVP loop closes through `corrective_sft`, and
  // registering a name with no plugin behind it is the defect this replaces.
  await ctx.plugin(CorrectiveSftService)
  const plugins: TrainingStrategyPlugin[] = [asPlugin((ctx as any).correctiveSft)]

  await ctx.plugin(LearningApiService, {
    storage,
    adapters: opts.adapters,
    strategies: plugins,
    ...(opts.registeredStrategies ? { registeredStrategies: opts.registeredStrategies } : {}),
    defaultAdapterFor: opts.defaultAdapterFor,
    authMiddleware,
  })

  // The interruption sweep is part of coming up, not a background chore: until it finishes, the
  // store still says a dead process's job is `running`, and anything reading during that window —
  // including the first request of the boot — is told a lie about live work (#197a).
  try {
    await (ctx as any).learningApi.ready
  } catch (e) {
    // Refusing to boot is the point: without reading `jobs/` this gateway cannot know whether a
    // job is running on a worker somewhere else, and "single-flight" is only real if the record
    // store answers. Starting anyway would let a second job claim the same GPU.
    throw new Error(`refusing to start: ${(e as Error).message} (jobs/ must be reconciled before queueing work)`)
  }

  // The runner is installed but does not start itself: on a single card, training and serving are
  // time-shared through `saip awake`/`saip sleep`, so a gateway that grabbed the GPU on boot would
  // fight the engine. An operator (or the hardware tier) calls runNext() when the card is theirs.
  await ctx.plugin(AxolotlRunnerService, {
    storage,
    adapters: opts.adapters,
    config: fileConfig ?? {},
    dataDir: (opts.env ?? process.env).SAIP_TRAINING_DATA_DIR,
    outputDir: (opts.env ?? process.env).SAIP_ADAPTER_OUTPUT_DIR,
    strategies: plugins,
  })

  // P7: promotion consumes the runner's event, so the loop closes through storage rather than a
  // caller remembering to invoke it. A failed promotion is written to the job record: an adapter
  // that trained but never reached the bucket must be visible as failed, not as succeeded.
  await ctx.plugin(R2SyncService, { storage })
  ctx.on('learning/adapter-trained', (payload: { adapter: string; job_id: string; path: string }) => {
    void (ctx as any).r2Sync
      .promote({ adapter: payload.adapter, job_id: payload.job_id, path: payload.path })
      // A version assignment is not a status change — the job already succeeded — so it is recorded
      // with annotate rather than appending a second `succeeded` row to history.
      .then((r: { version: number }) => (ctx as any).learningApi.store.annotate(payload.job_id, { version: r.version }))
      .catch(async (e: Error) => {
        await (ctx as any).learningApi.store.transition(payload.job_id, 'failed', {
          error: { code: (e as { code?: string }).code ?? 'promotion_failed', message: e.message },
        }, e.message)
      })
  })

  // Monitoring bridge: count queued learning jobs. Observe-only.
  ctx.on('learning/job-queued', () => (ctx as any).metrics.counter('saip_learning_jobs_queued_total'))
  // The provider is named in boot output because it decides where job records go: an operator
  // asking "why did my job vanish" needs to know the gateway booted on a volatile store.
  // `r2Sync` (#198b) is the other consumer.
  // Remaining plugins (axolotlRunner, r2Sync) register here as they are implemented.
  return ctx
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void createApp()
    .then(() => console.log('[saip-training] Gateway starting...'))
    .catch((e: unknown) => {
      process.stderr.write(`[saip-training] cannot start: ${(e as Error).message}\n`)
      process.exit(2)
    })
}
