/**
 * `r2Sync` — promotion from the adapter-output volume to a served version (#198b, §3 P7).
 *
 * The ordering is the design. A promotion becomes visible exactly when `adapters/_index.json` says it
 * is, so:
 *
 *   upload artifacts → read each one back → write the version manifest → **then** move `latest`
 *
 * A crash anywhere before the last write leaves the previous version serving complete bytes. A crash
 * after it means everything the index names has already been verified in storage. The alternative —
 * writing the index first, or keeping a separate `@latest` alias object — is what used to be
 * documented, and it left `@latest` able to point at bytes that were never uploaded. That is the
 * failure Review Focus #9 pins: a dangling version is worse than a stale one, because the stale one
 * still works.
 *
 * Artifacts are immutable per version. Rollback re-points `latest`; it never deletes history, because
 * "which adapter did the traffic that went wrong?" has to stay answerable.
 */
import { Service } from 'cordis'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AdapterIndex, AdapterLineage, AdapterVersionEntry, StorageProvider } from '@saip/shared'

const INDEX_KEY = 'adapters/_index.json'
const ARTIFACT_FILES = ['adapter_config.json', 'adapter_model.safetensors'] as const
const pad = (n: number): string => String(n).padStart(6, '0')

export interface PromoteRequest {
  /** Adapter lineage name, e.g. `coding`. */
  adapter: string
  /** The job that produced the artifact — recorded so a version traces back to its training run. */
  job_id: string
  /** Host directory holding the worker's output (the `adapter-output` volume). */
  path: string
  /** Training record count, from the dataset manifest, for provenance. */
  records?: number
  /** The checkpoint the adapter was trained against; must match the leaf's `base`. */
  base_model?: string
}

export interface PromoteResult {
  version: number
  prefix: string
  id: string
}

export class PromotionError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'PromotionError'
  }
}

export class R2SyncService extends Service {
  static readonly provide = 'r2Sync'
  private readonly storage: StorageProvider

  constructor(ctx: any, config: { storage: StorageProvider }) {
    super(ctx, 'r2Sync')
    this.storage = config.storage
  }

  private async readIndex(): Promise<AdapterIndex> {
    const raw = await this.storage.get(INDEX_KEY)
    if (!raw) return { adapters: {}, updated_at: new Date().toISOString() }
    try {
      const parsed = JSON.parse(raw) as AdapterIndex
      // A pre-#198b index carried `aliases` and keyed `adapters` by canonical id. Treat it as empty
      // rather than silently promoting over a shape the reader no longer understands: the first
      // promote rebuilds lineage entries from v1, and the old objects remain in the bucket untouched.
      if (!parsed || typeof parsed !== 'object' || (parsed as any).aliases) return { adapters: {}, updated_at: new Date().toISOString() }
      return { adapters: parsed.adapters ?? {}, updated_at: parsed.updated_at }
    } catch {
      return { adapters: {}, updated_at: new Date().toISOString() }
    }
  }

  /** Upload a trained adapter as the next version of its lineage. */
  async promote(req: PromoteRequest): Promise<PromoteResult> {
    const bodies = new Map<string, Buffer>()
    for (const file of ARTIFACT_FILES) {
      const local = join(req.path, file)
      if (!existsSync(local)) {
        throw new PromotionError(`no_artifact: ${file} is missing from ${req.path}`, 'no_artifact')
      }
      const buf = readFileSync(local)
      if (buf.length === 0) {
        throw new PromotionError(`no_artifact: ${file} in ${req.path} is empty`, 'no_artifact')
      }
      bodies.set(file, buf)
    }

    const index = await this.readIndex()
    const lineage: AdapterLineage = index.adapters[req.adapter] ?? { latest: 0, versions: {} }
    const version = lineage.latest + 1
    const prefix = `adapters/${req.adapter}/v${pad(version)}/`

    // 1. bytes
    for (const [file, buf] of bodies) {
      await this.storage.put(`${prefix}${file}`, buf)
    }

    // 2. verify each object by reading it back, before anything can reference it
    for (const [file, buf] of bodies) {
      const back = await this.storage.get(`${prefix}${file}`)
      if (back === undefined) {
        throw new PromotionError(`verify_failed: ${prefix}${file} is not readable after upload`, 'promotion_failed')
      }
      if (Buffer.from(back, 'utf8').compare(buf) !== 0) {
        throw new PromotionError(`verify_failed: ${prefix}${file} does not match the bytes uploaded`, 'promotion_failed')
      }
    }

    // 3. version manifest (still invisible to readers: the index has not moved)
    const at = new Date().toISOString()
    const manifest = {
      id: `${req.adapter}@${pad(version)}`,
      name: req.adapter,
      version,
      base_model: req.base_model ?? '',
      training_run: req.job_id,
      records: req.records,
      files: [...bodies.keys()],
      created_at: at,
      updated_at: at,
    }
    await this.storage.put(`${prefix}manifest.json`, JSON.stringify(manifest, null, 2))

    // 4. the commit: index last, and only now does @latest move
    const entry: AdapterVersionEntry = {
      job_id: req.job_id,
      base_model: req.base_model ?? '',
      trained_at: at,
      ...(req.records !== undefined ? { records: req.records } : {}),
    }
    index.adapters[req.adapter] = { latest: version, versions: { ...lineage.versions, [String(version)]: entry } }
    index.updated_at = at
    await this.storage.put(INDEX_KEY, JSON.stringify(index, null, 2))

    return { version, prefix, id: manifest.id }
  }

  /**
   * Move `latest` back to an earlier version. Artifacts stay put: the point of keeping them is that a
   * later question ("what did that traffic run?") can still be answered.
   */
  async rollback(adapter: string, version: number): Promise<AdapterIndex> {
    const index = await this.readIndex()
    const lineage = index.adapters[adapter]
    if (!lineage) throw new PromotionError(`no lineage for adapter "${adapter}"`, 'unknown_adapter')
    if (!lineage.versions[String(version)]) {
      throw new PromotionError(`version ${version} was never promoted for "${adapter}"`, 'unknown_version')
    }
    lineage.latest = version
    index.updated_at = new Date().toISOString()
    await this.storage.put(INDEX_KEY, JSON.stringify(index, null, 2))
    return index
  }
}
