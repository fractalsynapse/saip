/**
 * Boot as a program, not as an import (#198).
 *
 * `AGENTS.md` is explicit that anything users run as a program has to be tested as a program:
 * the built entry path, its observed output, its exit status. Every other test in this package
 * imports `createApp()` and asserts on the returned object, which is exactly how the silent
 * `MemoryStorage` default survived: importing code always "worked", while the process users
 * actually started had no tested failure path at all.
 *
 * These tests spawn `node dist/index.js` with an explicit environment — never the inherited one —
 * so the assertion cannot depend on what happens to be exported in the developer's shell or stored
 * in `~/.saip` (#138's class, applied to a child process).
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = join(import.meta.dirname, '..')
const repoRoot = join(pkgRoot, '..')
const entry = join(pkgRoot, 'dist', 'index.js')
const noEnvFile = () => join(mkdtempSync(join(tmpdir(), 'saip-boot-')), 'missing.env')

/**
 * These tests execute the built artifact, so they can only prove anything if the artifact is
 * newer than the source. Without this check an edit to `src/` that is not rebuilt leaves the suite
 * asserting against stale bytes — which reads as "my change broke nothing" or, worse, as "my
 * change broke this" when the failure is in code that no longer exists.
 */
function assertBuilt(): void {
  if (!existsSync(entry)) throw new Error(`${entry} is missing — run pnpm -r build before pnpm -r test`)
  const distMtime = statSync(entry).mtimeMs
  const stale = ['src/index.ts', 'src/lib/backends.ts', 'src/plugins/data-documents.ts']
    .map((f) => join(pkgRoot, f))
    .filter((f) => existsSync(f) && statSync(f).mtimeMs > distMtime)
  if (stale.length) throw new Error(`dist/ is older than ${stale.map((f) => basename(f)).join(', ')} — rebuild before testing the program`)
}

interface Run { code: number | null; stdout: string; stderr: string }

/** Start the gateway with `env`, collect output, and stop it once `until` matches (or on timeout). */
function run(entryEnv: Record<string, string>, until?: (out: string) => boolean, ms = 15_000): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry], {
      cwd: repoRoot,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...entryEnv },
    })
    let stdout = ''
    let stderr = ''
    const finish = (code: number | null): void => resolve({ code, stdout, stderr })
    const settle = (): void => {
      if (until && until(stdout + stderr)) child.kill('SIGTERM')
    }
    child.stdout.on('data', (c) => { stdout += c.toString(); settle() })
    child.stderr.on('data', (c) => { stderr += c.toString(); settle() })
    child.on('exit', finish)
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, ms)
    child.on('exit', () => clearTimeout(timer))
  })
}

const baseEnv = (over: Record<string, string> = {}): Record<string, string> => ({
  SAIP_CONFIG: join(repoRoot, 'saip.yaml'),
  SAIP_ENV_FILE: noEnvFile(),
  SAIP_SECRETS_FILE: join(noEnvFile(), 'secrets.enc.json'),
  ...over,
})

beforeAll(() => { assertBuilt() })

describe('saip inference: boot refuses or announces, never guesses', () => {
  it('exits non-zero naming SAIP_R2_BUCKET when no bucket is configured', async () => {
    const r = await run(baseEnv({ SAIP_STORAGE: '' }))
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/SAIP_R2_BUCKET/)
    // A refusal is a message, not a stack trace: "cannot start" plus the variable to set.
    expect(r.stderr).not.toMatch(/at .*node_modules/)
    // And it never claims to be listening.
    expect(r.stdout).not.toMatch(/listening/)
  })

  it('boots on the explicit memory opt-in and prints the durability warning', async () => {
    const port = 8300 + Math.floor(Math.random() * 400)
    const r = await run(baseEnv({ SAIP_STORAGE: 'memory', SAIP_INFERENCE_PORT: String(port) }),
      (out) => out.includes('listening'))
    expect(r.stderr).toMatch(/EXPLICIT MEMORY — data dies at restart/)
    expect(r.stdout).toMatch(new RegExp(`listening on :${port}`))
  })

  it('boots when a bucket and credentials are configured, naming no secret value', async () => {
    const port = 8300 + Math.floor(Math.random() * 400)
    // 127.0.0.1:1 refuses instantly: the R2 client is exercised for real, without CI needing a
    // network, a sidecar, or cloud credentials.
    const r = await run(baseEnv({
      SAIP_STORAGE: '',
      SAIP_R2_BUCKET: 'loop-bucket',
      SAIP_R2_ENDPOINT: 'http://127.0.0.1:1',
      SAIP_R2_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
      SAIP_R2_SECRET_ACCESS_KEY: 'super-secret-value-should-never-print',
      SAIP_INFERENCE_PORT: String(port),
    }), (out) => out.includes('listening'))
    expect(r.stdout).toMatch(new RegExp(`listening on :${port}`))
    // The memory banner must be absent: configuration, not a fallback, selected the provider.
    expect(r.stderr).not.toMatch(/EXPLICIT MEMORY/)
    expect(r.stderr).not.toContain('super-secret-value-should-never-print')
    expect(r.stderr).not.toContain('AKIAIOSFODNN7EXAMPLE')
    // An unreadable index is announced, not swallowed: "no promoted version" later is a
    // confusing symptom for a bucket that was unreachable at boot.
    expect(r.stderr).toMatch(/adapter index unreadable/i)
  })
})
