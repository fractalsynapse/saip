/**
 * learning-api — training gateway Cordis plugin.
 *
 * Serves the Learning API (`/v1/learning/*`) on a Hono app. Job creation resolves
 * adapter → strategy → data-scope linkage through the pure resolver in lib/job-linkage.ts,
 * honoring the documented inheritance and error contract, and then **persists** the result:
 * the record at `jobs/<id>.json` is the truth and the event is a notification (#197a).
 */

import { Service } from 'cordis'
import { Hono } from 'hono'
import type { MiddlewareHandler } from 'hono'
import type { AdapterDefinition, LearningJobRecord, StorageProvider } from '@saip/shared'
import { resolveJobLinkage, type JobRequest } from '../lib/job-linkage.js'
import { JobStore, findSecretParam, newJobId } from '../lib/job-store.js'
import { resolveScopes } from '@saip/shared'

export interface LearningApiConfig {
  /**
   * Where job records live. Required: a job that exists only in an HTTP response body cannot be
   * queried after the process that queued it is gone, which is the entire purpose of #197. The
   * composition root resolves it from config (#198's `storageProviderFor()`).
   */
  storage: StorageProvider
  adapters?: AdapterDefinition[]
  registeredStrategies?: string[]
  /** Resolve a caller id to their default training adapter (users[].adapters.training). */
  defaultAdapterFor?: (callerId?: string) => string | undefined
  /** Optional auth middleware applied to the whole jobs subtree (fail-closed enforcement). */
  authMiddleware?: MiddlewareHandler<any>
}

declare module 'cordis' {
  interface Context {
    learningApi?: LearningApiService
  }
  interface Events {
    'learning/job-queued'(payload: { jobId: string; adapter: string; strategy: string }): void
  }
}

export class LearningApiService extends Service {
  static readonly provide = 'learningApi'
  readonly app = new Hono()

  private adapters: AdapterDefinition[]
  private strategies: string[]
  private defaultAdapterFor: (callerId?: string) => string | undefined
  private authMiddleware?: MiddlewareHandler<any>
  readonly store: JobStore
  /**
   * Resolves when the boot-time interruption sweep finishes. Every route awaits it, so a request
   * arriving during startup cannot read a record that is about to be marked `interrupted` — the
   * race is closed by construction rather than by hoping startup finished.
   */
  readonly ready: Promise<void>

  constructor(ctx: any, config: LearningApiConfig) {
    super(ctx, 'learningApi')
    this.adapters = config.adapters ?? []
    this.strategies = config.registeredStrategies ?? []
    this.defaultAdapterFor = config.defaultAdapterFor ?? (() => undefined)
    this.authMiddleware = config.authMiddleware
    this.storageRef = config.storage
    this.store = new JobStore(config.storage)
    this.ready = this.store.sweepInterrupted().then(() => undefined)
    this.routes()
  }

  /** The provider jobs were resolved against — scope resolution must not build a second one. */
  private storageRef?: StorageProvider
  private storeStorage(): StorageProvider { return this.storageRef! }

  setRegistry(adapters: AdapterDefinition[]) { this.adapters = adapters }
  setStrategies(strategies: string[]) { this.strategies = strategies }

  private routes() {
    const { app } = this
    // Mounted on the subtree, not the exact path. Hono's `use('/v1/learning/jobs', mw)` does not
    // cover `/v1/learning/jobs/:id`, so adding the read route under the old pattern would publish
    // every persisted job — adapter, strategy, dataset hash, params — to anonymous readers
    // (design record §2.5). tests/job-routes-auth.test.ts is the guard.
    if (this.authMiddleware) (app as any).use('/v1/learning/jobs/*', this.authMiddleware)

    app.get('/v1/learning/strategies', (c) => {
      return c.json({ strategies: this.strategies })
    })

    app.post('/v1/learning/jobs', async (c) => {
      await this.ready
      const body = (await c.req.json().catch(() => ({}))) as JobRequest
      // Refused at the API rather than sanitized on the way out: the record is stored in object
      // storage beside the dataset it produces, so a credential arriving as a "training parameter"
      // would be published with it. Same stance `saip deploy` takes.
      const offending = findSecretParam(body.params)
      if (offending) {
        return c.json({
          error: {
            code: 'forbidden_param',
            message: `params."${offending}" looks like a credential. Job records are written to object storage; pass only training parameters.`,
          },
        }, 422)
      }
      // Caller identity comes from the authenticated principal when present.
      const principal = (c as any).get?.('principal') as { callerId?: string } | undefined
      const caller = principal?.callerId ?? c.req.header('x-saip-caller') ?? undefined
      const result = resolveJobLinkage(body, {
        adapters: this.adapters,
        defaultAdapter: this.defaultAdapterFor(caller),
        registeredStrategies: this.strategies,
      })
      if (!result.ok) {
        return c.json({ error: { code: result.error.code, message: result.error.message } }, result.error.status as 404 | 422)
      }
      const job = result.job
      const at = new Date().toISOString()
      const record: LearningJobRecord = {
        id: newJobId(),
        ...(caller ? { caller } : {}),
        adapter: job.adapter,
        strategy: job.strategy,
        data_scopes: job.data_scopes,
        ...(job.data_ids ? { data_ids: job.data_ids } : {}),
        params: job.params ?? {},
        inherited: job.inherited,
        status: 'queued',
        history: [{ at, status: 'queued' }],
        created_at: at,
        updated_at: at,
      }
      // Write-ahead, in this order: the object, then the index, then the event. A consumer of the
      // event can always read the record it describes.
      await this.store.create(record)

      // P1 scope resolution, at the boundary rather than in a later worker (#196, Review Focus #5).
      // The gateway has the storage seam, so it can answer "is there anything to train on?" now
      // instead of after a runner exists. A refusal is still a job: the record is transitioned to
      // failed with the structured code, because an untraceable 422 leaves the operator asking why
      // nothing happened, and "nothing happened" is exactly the silence this whole slice is against.
      const resolution = await resolveScopes(record, this.storeStorage())
      if (!resolution.ok) {
        const failed = await this.store.transition(record.id, 'failed', { error: resolution.error })
        return c.json({ error: resolution.error, job: failed ?? { ...record, status: 'failed', error: resolution.error } }, 422)
      }

      this.ctx.emit('learning/job-queued', { jobId: record.id, adapter: record.adapter, strategy: record.strategy })
      return c.json(record, 202)
    })

    app.get('/v1/learning/jobs/:id', async (c) => {
      await this.ready
      const record = await this.store.get(c.req.param('id'))
      if (!record) {
        return c.json({ error: { code: 'job_not_found', message: `no learning job with id "${c.req.param('id')}"` } }, 404)
      }
      return c.json(record, 200)
    })

    app.get('/v1/learning/jobs', async (c) => {
      await this.ready
      const { entries, total, limit, offset } = await this.store.list({
        adapter: c.req.query('adapter') || undefined,
        status: c.req.query('status') || undefined,
        limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
        offset: c.req.query('offset') ? Number(c.req.query('offset')) : undefined,
      })
      // Shape mirrors the Data API document list so one client pages both.
      return c.json({ entries, total, limit, offset }, 200)
    })
  }
}
