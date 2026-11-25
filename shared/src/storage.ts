/**
 * The storage seam (#198).
 *
 * Both gateways share state through object storage instead of a database, so this file holds
 * the contract that decision rests on. It lives in `@saip/shared` rather than in the gateway
 * that happened to declare it first: training must read exactly the corpus inference writes,
 * and two independently-declared interfaces drift — the same class #187 removed from the
 * package manifest, where five declared exports pointed at files that never existed.
 *
 * Selection is the policy here, and it is fail-closed by design. Before #198 the inference
 * composition root did `opts.storage ?? new MemoryStorage()`: a gateway with no bucket
 * configured booted happily, returned 2xx for every document, session and feedback write, and
 * lost all of it at restart. Training then read an empty `sessions/` prefix with no way to
 * distinguish "nothing collected" from "everything lost". An unconfigured store is now a
 * startup error naming the variable; the volatile store is reachable only by name.
 *
 * The full contract suite runs against both implementations in
 * `shared/tests/storage-contract.test.ts`.
 */
import { EnvSecrets, MissingSecretError, type SecretsProvider } from './hosting.js'
import { R2StorageProvider } from './r2-client.js'

/** Object storage: four operations, keys are opaque, prefixes are string boundaries. */
export interface StorageProvider {
  put(key: string, body: string | Uint8Array): Promise<void>
  /** `undefined` when the key does not exist — a missing object is not an error. */
  get(key: string): Promise<string | undefined>
  /** Keys under `prefix`, lexicographically sorted. Paginates internally: never partial. */
  list(prefix: string): Promise<string[]>
  /** true if a key existed and was removed. */
  delete(key: string): Promise<boolean>
}

/** The `storage:` block as it appears in `saip.yaml` (values already interpolated). */
export interface StorageConfig {
  r2?: { bucket?: string; endpoint?: string }
}

/** Config shape a composition root must hand the factory. Kept structural on purpose. */
export interface StorageSelectionConfig {
  storage?: StorageConfig
}

export interface StorageFactoryOptions {
  config?: StorageSelectionConfig
  /** Credential source. Defaults to the environment, never to a value baked into config. */
  secrets?: SecretsProvider
  /** Defaults to `process.env`. Tests inject their own so they never read the developer's shell. */
  env?: NodeJS.ProcessEnv
  /** Where the memory warning is announced. Defaults to stderr, which is what a boot log is. */
  log?: (line: string) => void
}

/** The exact prefix the boot line must carry: tests and docs both quote it. */
export const MEMORY_WARNING = 'storage: EXPLICIT MEMORY — data dies at restart'

const R2_BUCKET_VAR = 'SAIP_R2_BUCKET'
const R2_ENDPOINT_VAR = 'SAIP_R2_ENDPOINT'
const R2_ACCESS_VAR = 'SAIP_R2_ACCESS_KEY_ID'
const R2_SECRET_VAR = 'SAIP_R2_SECRET_ACCESS_KEY'

/** A configuration refusal, as distinct from a transport failure. */
export class StorageSelectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StorageSelectionError'
  }
}

/**
 * Process-lifetime store: correct, useful, and **not** a production default.
 *
 * It backs the test tiers and the explicit `SAIP_STORAGE=memory` opt-in. Its `list()` is
 * trivially complete because the Map holds everything — which is exactly why the pagination
 * contract has to be tested against a provider that has to page.
 */
export class MemoryStorage implements StorageProvider {
  private readonly map = new Map<string, string>()

  async put(key: string, body: string | Uint8Array): Promise<void> {
    this.map.set(key, typeof body === 'string' ? body : Buffer.from(body).toString('utf8'))
  }
  async get(key: string): Promise<string | undefined> {
    return this.map.get(key)
  }
  async list(prefix: string): Promise<string[]> {
    return [...this.map.keys()].filter((k) => k.startsWith(prefix)).sort()
  }
  async delete(key: string): Promise<boolean> {
    return this.map.delete(key)
  }
}

const truthy = (v: string | undefined): v is string => v !== undefined && v !== ''

/**
 * Resolve the provider for a deployment. See the selection table in
 * `docs/src/content/docs/reference/configuration.mdx` — the three rows are the entire policy,
 * and this function implements all of them or the build is wrong.
 *
 * Credentials are looked up **by name** through `SecretsProvider` (encrypted store, then
 * environment). They never appear in `saip.yaml`, and a failure message never repeats one.
 */
export async function storageProviderFor(
  opts: StorageFactoryOptions = {},
): Promise<StorageProvider> {
  const env = opts.env ?? process.env
  const log = opts.log ?? ((line: string) => process.stderr.write(`[saip] ${line}\n`))
  const mode = env.SAIP_STORAGE

  if (mode !== undefined && mode !== '') {
    if (mode === 'memory') {
      // Loud and unconditional: an operator who sets this in production must see, at boot, that
      // the corpus is not durable. A debug-level line is a line nobody reads.
      log(`${MEMORY_WARNING}. Set SAIP_STORAGE= (empty) and configure ${R2_BUCKET_VAR} for durable storage.`)
      return new MemoryStorage()
    }
    throw new StorageSelectionError(
      `unknown SAIP_STORAGE="${mode}". The only accepted value is "memory"; leave it unset to select `
      + `the R2 provider from ${R2_BUCKET_VAR}. There is no implicit in-memory default: a store that `
      + `loses the corpus at restart must be chosen by name (#198).`,
    )
  }

  const bucket = opts.config?.storage?.r2?.bucket ?? ''
  if (!truthy(bucket)) {
    throw new StorageSelectionError(
      `${R2_BUCKET_VAR} is empty or unset, so no storage provider can be constructed. `
      + `Set ${R2_BUCKET_VAR} (and ${R2_ENDPOINT_VAR}) in .env or the secret store, or pass `
      + `SAIP_STORAGE=memory to run with the non-durable store deliberately. SAIP will not fall back `
      + `to memory silently: every write would report success and none would survive restart (#198).`,
    )
  }

  const endpoint = opts.config?.storage?.r2?.endpoint ?? ''
  if (!truthy(endpoint)) {
    throw new StorageSelectionError(
      `storage.r2.bucket is set but ${R2_ENDPOINT_VAR} is empty: the bucket name alone does not say `
      + `which account owns it. Set ${R2_ENDPOINT_VAR} to the S3-compatible endpoint `
      + `(https://<ACCOUNT_ID>.r2.cloudflarestorage.com).`,
    )
  }

  const secrets = opts.secrets ?? new EnvSecrets(env)
  let accessKeyId: string
  let secretAccessKey: string
  try {
    accessKeyId = await secrets.require(R2_ACCESS_VAR)
    secretAccessKey = await secrets.require(R2_SECRET_VAR)
  } catch (e) {
    if (e instanceof MissingSecretError) {
      throw new StorageSelectionError(
        `storage: ${e.message} — required once ${R2_BUCKET_VAR} is set. Provide it by name (secret `
        + `store or environment), never in saip.yaml (#198).`,
      )
    }
    throw e
  }

  return new R2StorageProvider({ endpoint, bucket, accessKeyId, secretAccessKey })
}

export { R2StorageProvider }
export type { R2StorageOptions } from './r2-client.js'
