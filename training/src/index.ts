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
import { createMiddleware } from 'hono/factory'

export interface SecurityConfig {
  dev_mode?: boolean
  api_tokens?: Array<{ caller: string; token_secret: string }>
}

/** The slice of `saip.yaml` the training gateway reads for storage selection. */
export interface TrainingConfig {
  storage?: StorageConfig
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

  const security = opts.security ?? { dev_mode: false, api_tokens: [] }
  const provider = pickAuthProvider(security, (ctx as any).secrets)
  const authMiddleware = createMiddleware(async (c: any, next: any) => {
    const principal = await provider.verifyApi({ headers: { authorization: c.req.header('authorization') ?? c.req.header('Authorization') } })
    if (!principal) return c.json({ error: { message: 'authentication required', code: 'unauthorized' } }, 401)
    c.set('principal', principal)
    await next()
  })

  await ctx.plugin(LearningApiService, {
    adapters: opts.adapters,
    registeredStrategies: opts.registeredStrategies,
    defaultAdapterFor: opts.defaultAdapterFor,
    authMiddleware,
  })

  // Monitoring bridge: count queued learning jobs. Observe-only.
  ctx.on('learning/job-queued', () => (ctx as any).metrics.counter('saip_learning_jobs_queued_total'))
  // The provider is resolved and reported here; the plugins that consume it — the `jobs/` store
  // (#197a) and `r2Sync` (#198b) — are the reason it exists. Handing it to a plugin that cannot
  // use it yet would be decorative wiring, so it is named in the boot output instead: an operator
  // needs to see which store the gateway that is about to write job records to actually chose.
  process.stderr.write(`[saip-training] ${storageSummary(storage)}\n`)
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
