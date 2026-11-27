/**
 * Training gateway boot, as a program (#198).
 *
 * The training side is where a lost store costs the most: it is the gateway that will write
 * `jobs/<id>.json` and promote adapters. If it can start on a process-lifetime Map, a job record
 * can report `running` and simply not exist after a restart — the failure the persisted-job work
 * (#197) is meant to eliminate, reintroduced by the layer underneath it.
 *
 * Spawned with an explicit environment, never the inherited one.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'

const pkgRoot = join(import.meta.dirname, '..')
const repoRoot = join(pkgRoot, '..')
const entry = join(pkgRoot, 'dist', 'index.js')
const tmp = () => mkdtempSync(join(tmpdir(), 'saip-tboot-'))

/**
 * These tests execute the built artifact, so they can only prove anything if the artifact is
 * newer than the source. Without this check an edit to `src/` that is not rebuilt leaves the suite
 * asserting against stale bytes — which reads as "my change broke nothing" or, worse, as "my
 * change broke this" when the failure is in code that no longer exists.
 */
function assertBuilt(): void {
  if (!existsSync(entry)) throw new Error(`${entry} is missing — run pnpm -r build before pnpm -r test`)
  const distMtime = statSync(entry).mtimeMs
  const stale = ['src/index.ts', 'src/plugins/learning-api.ts', 'src/lib/job-store.ts']
    .map((f) => join(pkgRoot, f))
    .filter((f) => existsSync(f) && statSync(f).mtimeMs > distMtime)
  if (stale.length) throw new Error(`dist/ is older than ${stale.map((f) => basename(f)).join(', ')} — rebuild before testing the program`)
}

/**
 * Start the built gateway and collect output.
 *
 * `until` stops the process once the expected line appears: since #218 the gateway is a server, so
 * waiting for a natural exit would hang any test that boots it successfully. Exit codes are still
 * asserted for the refusal paths, which do exit.
 */
function run(env: Record<string, string>, until?: (out: string) => boolean, ms = 15_000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry], {
      cwd: repoRoot,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    })
    let out = ''
    const collect = (c: Buffer): void => {
      out += c.toString()
      if (until?.(out)) child.kill('SIGTERM')
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const timer = setTimeout(() => child.kill('SIGKILL'), ms)
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }) })
  })
}

beforeAll(() => { assertBuilt() })

describe('saip training: storage is fail-closed at this root too', () => {
  it('refuses to boot without a bucket, exit 2, naming SAIP_R2_BUCKET', async () => {
    const r = await run({
      SAIP_CONFIG: join(repoRoot, 'saip.yaml'),
      SAIP_ENV_FILE: join(tmp(), 'missing.env'),
      SAIP_SECRETS_FILE: join(tmp(), 'secrets.enc.json'),
    })
    expect(r.code).toBe(2)
    expect(r.out).toMatch(/SAIP_R2_BUCKET/)
    expect(r.out).not.toMatch(/at .*node_modules/)
    expect(r.out).not.toMatch(/Gateway starting/)
  })

  it('boots on the named memory opt-in and says job records will not survive', async () => {
    const r = await run({
      SAIP_CONFIG: join(repoRoot, 'saip.yaml'),
      SAIP_ENV_FILE: join(tmp(), 'missing.env'),
      SAIP_SECRETS_FILE: join(tmp(), 'secrets.enc.json'),
      SAIP_STORAGE: 'memory',
      SAIP_TRAINING_PORT: String(8600 + Math.floor(Math.random() * 300)),
    // Stop only once the port is bound — the last line the entry point prints. Terminating on the
    // storage summary would kill the process before the line asserted below was ever written, which
    // is how this test failed while the gateway was behaving correctly.
    }, (out) => /Learning API listening on :\d+/.test(out))
    expect(r.out).toMatch(/EXPLICIT MEMORY — job records die at restart/)
    // The old entry point printed "Gateway starting..." and exited 0 without binding anything.
    // Since #218 the honest signal is a bound port (#218), so that is what is asserted here.
    expect(r.out).toMatch(/Learning API listening on :\d+/)
  })

  it('names the R2 provider at boot and echoes no credential', async () => {
    const r = await run({
      SAIP_CONFIG: join(repoRoot, 'saip.yaml'),
      SAIP_ENV_FILE: join(tmp(), 'missing.env'),
      SAIP_SECRETS_FILE: join(tmp(), 'secrets.enc.json'),
      SAIP_R2_BUCKET: 'loop-bucket',
      SAIP_R2_ENDPOINT: 'http://127.0.0.1:1',
      SAIP_R2_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
      SAIP_R2_SECRET_ACCESS_KEY: 'super-secret-value-should-never-print',
      SAIP_TRAINING_PORT: String(8600 + Math.floor(Math.random() * 300)),
    }, (out) => out.includes('Listening on') || out.includes('storage: R2StorageProvider'))
    expect(r.out).toMatch(/storage: R2StorageProvider/)
    expect(r.out).not.toContain('super-secret-value-should-never-print')
    expect(r.out).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(r.out).not.toMatch(/EXPLICIT MEMORY/)
  })

  it('refuses to start when jobs/ cannot be reconciled', async () => {
    // The sweep reads the store at boot. An unreachable store means this gateway cannot know
    // whether a job is already running on some worker, so starting would break single-flight.
    const r = await run({
      SAIP_CONFIG: join(repoRoot, 'saip.yaml'),
      SAIP_ENV_FILE: join(tmp(), 'missing.env'),
      SAIP_SECRETS_FILE: join(tmp(), 'secrets.enc.json'),
      SAIP_R2_BUCKET: 'loop-bucket',
      SAIP_R2_ENDPOINT: 'http://127.0.0.1:1',
      SAIP_R2_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
      SAIP_R2_SECRET_ACCESS_KEY: 'super-secret-value-should-never-print',
      SAIP_TRAINING_PORT: String(8600 + Math.floor(Math.random() * 300)),
    })
    expect(r.code).toBe(2)
    expect(r.out).toMatch(/refusing to start/)
    expect(r.out).toMatch(/jobs\/ must be reconciled/)
  })
})
