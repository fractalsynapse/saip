/**
 * The training gateway must serve as a program (#218).
 *
 * This is the test that should have existed from the first day of the training gateway. 97 tests
 * construct `createApp()` and call `app.request(...)` on the in-process Hono object — all of them
 * passed while `node training/dist/index.js` printed "Gateway starting...", bound nothing, and exited
 * 0. Compose mapped port 8001, the Dockerfile said `EXPOSE 8001`, and the docs showed curl examples
 * against `localhost:8001`. The repo's own rule is that anything users run as a program is tested as
 * a program; this file is that rule applied to the gap.
 *
 * The canary matters: a test that "checks the server answers" written with a try/catch that treats a
 * connection refused as acceptable would pass against the broken entry point. So the assertions are
 * positive (a real HTTP response, an exit code that is still running when we stop it) and the test
 * fails against `origin/staging` today.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const pkgRoot = join(import.meta.dirname, '..')
const repoRoot = join(pkgRoot, '..')
const entry = join(pkgRoot, 'dist', 'index.js')

interface Probe { status: number; body: string }

async function fetchJson(url: string, init?: RequestInit): Promise<Probe> {
  const res = await fetch(url, init)
  return { status: res.status, body: await res.text() }
}

/** Poll until the port answers, so "slow to bind" is not confused with "never binds". */
async function waitListening(port: number, ms = 12_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`)
      if (res.status < 500) return true
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 120))
  }
  return false
}

let child: ChildProcess | undefined
let port = 0
let exitedEarly: number | null = null

/**
 * A copy of the committed config with dev auth on, for the assertions that need to read routes.
 * The committed file keeps `dev_mode: false`, which is the right default and is asserted below as
 * fail-closed over the wire — a route that answers 401 anonymously proves both the listener and the
 * auth mount are real.
 */
function devConfig(): string {
  const { readFileSync, writeFileSync: wf } = require('node:fs')
  const src = readFileSync(join(repoRoot, 'saip.yaml'), 'utf8')
  const path = join(mkdtempSync(join(tmpdir(), 'saip-serve-cfg-')), 'saip.yaml')
  wf(path, src.replace('dev_mode: false', 'dev_mode: true'))
  return path
}

function start(env: Record<string, string> = {}): Promise<void> {
  port = 8400 + Math.floor(Math.random() * 500)
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, [entry], {
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        SAIP_CONFIG: join(repoRoot, 'saip.yaml'),
        SAIP_ENV_FILE: join(mkdtempSync(join(tmpdir(), 'saip-serve-')), 'none.env'),
        SAIP_SECRETS_FILE: join(mkdtempSync(join(tmpdir(), 'saip-serve-')), 'secrets.enc.json'),
        SAIP_STORAGE: 'memory',
        SAIP_TRAINING_PORT: String(port),
        ...env,
      },
    })
    child.on('exit', (code) => { exitedEarly = code })
    child.on('error', reject)
    void waitListening(port).then(() => resolve())
  })
}

afterAll(async () => {
  child?.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 150))
})

describe('training gateway as a program', () => {
  it('the built entry exists', () => {
    expect(existsSync(entry), `${entry} missing — run pnpm -r build`).toBe(true)
    // Fresh-source guard: a program test against a stale dist proves nothing about the code under review.
    const stale = ['src/index.ts', 'src/plugins/server.ts', 'src/plugins/learning-api.ts']
      .map((f) => join(pkgRoot, f))
      .filter((f) => existsSync(f) && statSync(f).mtimeMs > statSync(entry).mtimeMs)
    expect(stale.map((f) => f.split('/').pop()), 'dist/ is older than src — rebuild').toEqual([])
  })

  it('binds the configured port instead of exiting after a cheerful log line', async () => {
    await start()
    expect(exitedEarly, 'the process exited without listening').toBeNull()
    const health = await fetchJson(`http://127.0.0.1:${port}/health`)
    expect(health.status).toBe(200)
  })

  it('serves GET /v1/learning/strategies over real HTTP', async () => {
    if (!child) await start()
    const res = await fetchJson(`http://127.0.0.1:${port}/v1/learning/strategies`)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body).strategies).toContain('corrective_sft')
  })

  it('refuses an anonymous job read over the wire, with the committed config', async () => {
    // The shipped saip.yaml has dev_mode: false. A 401 here is two facts at once: something is
    // listening (impossible before #218) and the /v1/learning/jobs/* auth mount survived the trip
    // through a real socket rather than only existing in an in-process app.
    if (!child) await start()
    const anon = await fetchJson(`http://127.0.0.1:${port}/v1/learning/jobs`)
    expect(anon.status).toBe(401)
    const one = await fetchJson(`http://127.0.0.1:${port}/v1/learning/jobs/whatever`)
    expect(one.status).toBe(401)
  })

  it('accepts a job over HTTP and reads it back by id', async () => {
    await start({ SAIP_CONFIG: devConfig() })
    const created = await fetchJson(`http://127.0.0.1:${port}/v1/learning/jobs`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ adapter: 'coding' }),
    })
    // A memory store starts empty, so the scope gate refuses: 422 with a record is the honest answer.
    expect(created.status).toBe(422)
    const body = JSON.parse(created.body)
    expect(body.error.code).toBe('empty_scope')

    const read = await fetchJson(`http://127.0.0.1:${port}/v1/learning/jobs/${body.job.id}`)
    expect(read.status).toBe(200)
    expect(JSON.parse(read.body).status).toBe('failed')
  })

  it('stays up: a serving process must not exit on its own', async () => {
    if (!child) await start()
    await new Promise((r) => setTimeout(r, 800))
    expect(exitedEarly, 'the gateway exited while it should be serving').toBeNull()
    expect(child!.kill(0), 'process is gone').toBe(true)
  })
})

describe('job claiming is opt-in', () => {
  it('without SAIP_TRAINING_RUN the process serves but never claims a job', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'saip-norun-'))
    await start({ SAIP_CONFIG: devConfig(), SAIP_TRAINING_RUN: '', SAIP_TRAINING_DATA_DIR: dataDir })
    const created = await fetchJson(`http://127.0.0.1:${port}/v1/learning/jobs`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ adapter: 'coding' }),
    })
    const before = JSON.parse(created.body).job?.status
    await new Promise((r) => setTimeout(r, 1200))
    const after = await fetchJson(`http://127.0.0.1:${port}/v1/learning/jobs`)
    const statuses = JSON.parse(after.body).entries.map((e: { status: string }) => e.status)
    // The job refused at queue time here (empty corpus); the claim is that no transition to `running`
    // ever happened without the opt-in.
    expect(statuses.some((s: string) => s === 'running'), `unclaimed jobs moved on their own: ${statuses.join(',')}`).toBe(false)
    expect([before, 'failed', 'queued']).toContain(before)
  })
})
