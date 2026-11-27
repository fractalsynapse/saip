/**
 * server — the training gateway's HTTP entry point (#218).
 *
 * The package had an Hono app, a documented port, a compose mapping and `EXPOSE 8001`, but no
 * listener: the entry point logged "Gateway starting..." and exited 0. Everything in
 * `api-training.mdx` was reachable only from inside a test process.
 *
 * This mirrors what the inference gateway already does — compose the plugins' sub-apps, bind the
 * configured port — and adds the one thing the training side needs that serving does not: the job
 * claimer. Claiming is opt-in (`SAIP_TRAINING_RUN=1`) because on a single card, training and serving
 * are time-shared through `saip awake`/`saip sleep`; a gateway that grabbed the GPU at boot would
 * fight whatever is holding it, and the operator would see an OOM rather than a queue.
 */
import { Service } from 'cordis'
import { Hono } from 'hono'
import { serve, type ServerType } from '@hono/node-server'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

declare module 'cordis' {
  interface Context { trainingServer?: TrainingServerService }
}

export interface TrainingServerConfig {
  /** Config file to read `training.port` from when no port is given. */
  configPath?: string
  env?: NodeJS.ProcessEnv
}

export class TrainingServerService extends Service {
  static readonly provide = 'trainingServer'
  // Only `learningApi`: Cordis refuses a cross-service read that was not declared, and declaring a
  // dependency the plugin does not use (the runner is handed to `startClaiming()` by the entry point)
  // made the whole service unresolvable wherever that peer had not been installed.
  static readonly inject = ['learningApi'] as const
  readonly app = new Hono()
  private readonly owner: Record<string, any>
  private server?: ServerType
  private timer?: NodeJS.Timeout
  private mounted = false

  constructor(ctx: any, cfg: TrainingServerConfig = {}) {
    super(ctx, 'trainingServer')
    this.owner = ctx as Record<string, any>
    void cfg

    // Health first: an orchestrator needs to distinguish "container up" from "service answering",
    // which is exactly the distinction that let a non-listening process look healthy.
    this.app.get('/health', (h) => h.json({ status: 'ok', service: 'training' }))
  }

  /**
   * Mount the routes the moment something asks to serve.
   *
   * Declaring `static inject` was the first attempt and it made the service unresolvable in a context
   * where an injected dependency had not been installed — the whole gateway then came back with
   * `ctx.trainingServer === undefined`, which is a worse failure than the one being fixed. Mounting at
   * `start()` keeps the plugin order-free: whatever has registered by the time the port is bound is
   * what gets served.
   */
  private mount(): void {
    if (this.mounted) return
    this.mounted = true
    const api = this.owner.learningApi?.app
    if (api) this.app.route('/', api)
  }

  /** Resolve the listen port: explicit arg → SAIP_TRAINING_PORT → saip.yaml training.port → 8001. */
  static portFrom(explicit: number | undefined, env: NodeJS.ProcessEnv, configPath?: string): number {
    if (explicit && Number.isFinite(explicit)) return explicit
    const fromEnv = Number(env.SAIP_TRAINING_PORT ?? '')
    if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv
    const path = configPath ?? env.SAIP_CONFIG ?? 'saip.yaml'
    if (existsSync(path)) {
      try {
        // Cheap read: this is a port lookup, not a config load. The validated loader lives in the
        // inference gateway; duplicating it here would give two answers to one question.
        const raw = readFileSync(path, 'utf8')
        const m = raw.match(/^training:\n(?:[ \t].*\n)*?[ \t]+port:[ \t]*(\d+)/m)
        if (m) return Number(m[1])
      } catch { /* unreadable config falls through to the documented default */ }
    }
    return 8001
  }

  start(port: number): ServerType {
    this.mount()
    this.server = serve({ fetch: this.app.fetch, port })
    return this.server
  }

  /**
   * Begin claiming queued jobs. Off unless an operator turns it on — see the header for why.
   *
   * One job at a time is enforced by the runner itself (single-flight), so overlapping ticks are
   * harmless: the second claim sees the busy flag and returns undefined.
   */
  startClaiming(runner: { runNext: () => Promise<unknown> }, seconds = 5): void {
    this.stopClaiming()
    const tick = () => {
      void Promise.resolve(runner.runNext()).catch((e: Error) => {
        process.stderr.write(`[saip-training] WARNING: claim failed: ${e.message}\n`)
      })
    }
    this.timer = setInterval(tick, Math.max(1, seconds) * 1000)
    tick()
  }

  stopClaiming(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  close(): Promise<void> {
    this.stopClaiming()
    return new Promise((resolve) => {
      if (!this.server) return resolve()
      this.server.close(() => resolve())
    })
  }
}
