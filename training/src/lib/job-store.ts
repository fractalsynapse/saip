/**
 * The job store (#197a).
 *
 * A learning job outlives the process that queued it: it runs on a worker that can be killed, on
 * a cloud instance that can be replaced. So the record — not an in-memory table, not the event
 * stream — is the truth, and every transition is written before it is announced. This is the same
 * `<prefix>/<id>.json` + `<prefix>/_index.json` pattern documents, sessions and feedback already
 * use, which means it inherits the storage contract suite and its durability rules for free.
 *
 * Single-writer: only the training gateway calls the mutators here. Epic #63 A4 (list-authoritative
 * reads, index rebuild, concurrent writers) is deliberately out of scope; the invariant above is
 * what makes that deferral safe instead of optimistic.
 */
import { randomBytes } from 'node:crypto'
import type { LearningJobIndex, LearningJobRecord, LearningJobStatus, StorageProvider } from '@saip/shared'

const INDEX_KEY = 'jobs/_index.json'

/** `train-<YYYYMMDD>-<base36-ms>-<base36-rand4>`. */
export function newJobId(now: number = Date.now(), rand: () => string = randomSuffix): string {
  const day = new Date(now).toISOString().slice(0, 10).replace(/-/g, '')
  return `train-${day}-${now.toString(36)}-${rand()}`
}

/** Four base36 characters from the CSPRNG; the timestamp alone would collide inside one ms. */
function randomSuffix(): string {
  return randomBytes(3).readUIntBE(0, 3).toString(36).padStart(4, '0').slice(-4)
}

export interface JobListQuery {
  adapter?: string
  status?: string
  limit?: number
  offset?: number
}

export interface JobListResult {
  entries: LearningJobRecord[]
  total: number
  limit: number
  offset: number
}

/** Anything that could be read as a credential must not be published into a bucket with the job. */
const SECRET_PARAM = /token|secret|key|passw/i

/** @returns the offending key, or undefined when every param name is safe to store. */
export function findSecretParam(params: Record<string, unknown> | undefined): string | undefined {
  return Object.keys(params ?? {}).find((k) => SECRET_PARAM.test(k))
}

export class JobStore {
  constructor(private readonly storage: StorageProvider) {}

  private key(id: string): string { return `jobs/${id}.json` }

  private async readIndex(): Promise<LearningJobIndex> {
    try {
      const raw = await this.storage.get(INDEX_KEY)
      if (raw) return JSON.parse(raw) as LearningJobIndex
    } catch { /* absent or corrupt: rebuild below */ }
    return { jobs: {}, updated_at: new Date().toISOString() }
  }

  private async writeIndex(index: LearningJobIndex): Promise<void> {
    await this.storage.put(INDEX_KEY, JSON.stringify(index, null, 2))
  }

  private summary(rec: LearningJobRecord) {
    return { status: rec.status, adapter: rec.adapter, strategy: rec.strategy, created_at: rec.created_at, updated_at: rec.updated_at }
  }

  /**
   * Persist a new record.
   *
   * Ordering is the commit point from design record §1.4: object first, then index. A crash between
   * the two leaves an orphan object — a job nobody can list — which is recoverable. The reverse
   * would leave an index entry pointing at a record that never existed, which reads as corruption.
   */
  async create(record: LearningJobRecord): Promise<void> {
    await this.storage.put(this.key(record.id), JSON.stringify(record, null, 2))
    const index = await this.readIndex()
    index.jobs[record.id] = this.summary(record)
    index.updated_at = record.updated_at
    await this.writeIndex(index)
  }

  async get(id: string): Promise<LearningJobRecord | undefined> {
    const raw = await this.storage.get(this.key(id))
    if (!raw) return undefined
    try { return JSON.parse(raw) as LearningJobRecord } catch { return undefined }
  }

  /**
   * Apply a transition and rewrite the record.
   *
   * `history` is append-only and every status change goes through here, so "when did this job
   * start running" stays answerable after the process that decided it is gone.
   */
  async transition(
    id: string,
    status: LearningJobStatus,
    patch: Partial<LearningJobRecord> = {},
    detail?: string,
  ): Promise<LearningJobRecord | undefined> {
    const current = await this.get(id)
    if (!current) return undefined
    const at = new Date().toISOString()
    const next: LearningJobRecord = {
      ...current,
      ...patch,
      status,
      updated_at: at,
      history: [...current.history, { at, status, ...(detail ? { detail } : {}) }],
    }
    await this.storage.put(this.key(id), JSON.stringify(next, null, 2))
    const index = await this.readIndex()
    index.jobs[id] = this.summary(next)
    index.updated_at = at
    await this.writeIndex(index)
    return next
  }

  /**
   * Read every record behind a filter. Uses the index to decide *which* keys to fetch, then reads
   * the objects — so a stale index can drop a job from a list but never invent one.
   */
  async list(query: JobListQuery = {}): Promise<JobListResult> {
    const index = await this.readIndex()
    const ids = Object.keys(index.jobs).sort((a, b) => {
      const ka = `${index.jobs[a].created_at}|${a}`
      const kb = `${index.jobs[b].created_at}|${b}`
      return ka < kb ? -1 : ka > kb ? 1 : 0
    })
    const records: LearningJobRecord[] = []
    for (const id of ids) {
      const rec = await this.get(id)
      if (!rec) continue // orphaned index entry: skip rather than fabricate
      if (query.adapter && rec.adapter !== query.adapter) continue
      if (query.status && rec.status !== query.status) continue
      records.push(rec)
    }
    const limit = Math.max(0, Number(query.limit ?? 50) || 0)
    const offset = Math.max(0, Number(query.offset ?? 0) || 0)
    return { entries: records.slice(offset, limit ? offset + limit : undefined), total: records.length, limit, offset }
  }

  /**
   * Update artifact fields without claiming a status change.
   *
   * A stage that *produced* something (a dataset hash, a config hash) is not a lifecycle transition:
   * appending a second `running` entry would make history mean "things happened" instead of "the job
   * changed state", and anyone reading a record twice-running would reasonably ask which run.
   */
  async annotate(id: string, patch: Partial<LearningJobRecord>): Promise<LearningJobRecord | undefined> {
    const current = await this.get(id)
    if (!current) return undefined
    const next: LearningJobRecord = { ...current, ...patch, updated_at: new Date().toISOString() }
    await this.storage.put(this.key(id), JSON.stringify(next, null, 2))
    const index = await this.readIndex()
    if (index.jobs[id]) index.jobs[id] = this.summary(next)
    await this.writeIndex(index)
    return next
  }

  /**
   * Boot-time sweep: a record still marked `running` belongs to a process that is not here.
   *
   * Design record §2.4 chooses *interrupted, not resurrected*. Re-adopting an unknown worker state
   * would require trusting that `docker exec` survived, that the output directory is intact, and
   * that nothing else claimed the GPU meanwhile — three things this gateway cannot observe. Marking
   * it failed and requiring a new job is boring, and boring is what survives a killed cloud
   * instance.
   */
  async sweepInterrupted(): Promise<LearningJobRecord[]> {
    const keys = (await this.storage.list('jobs/')).filter((k) => k.endsWith('.json') && k !== INDEX_KEY)
    const changed: LearningJobRecord[] = []
    for (const key of keys) {
      const raw = await this.storage.get(key)
      if (!raw) continue
      let rec: LearningJobRecord
      try { rec = JSON.parse(raw) as LearningJobRecord } catch { continue }
      if (rec.status !== 'running') continue
      const updated = await this.transition(rec.id, 'failed', {
        error: { code: 'interrupted', message: 'the job was running when the gateway stopped; it is not resumed' },
      }, 'interrupted at boot')
      if (updated) changed.push(updated)
    }
    return changed
  }
}
