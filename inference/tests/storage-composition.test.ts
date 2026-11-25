/**
 * Composition-root tier for storage selection (#198).
 *
 * `AGENTS.md` requires at least one test of default production construction with **no fakes
 * injected** for every injectable seam. For storage that is the whole point of the change: the
 * previous default was a fake (`MemoryStorage`) wired into production, and every test that
 * injected a store was passing while the shipped gateway silently lost data at restart.
 *
 * Nothing here injects a provider. Config and environment are data the composition root reads, so
 * the fake S3 endpoint is reached over real HTTP by the real client.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MemoryStorage, R2StorageProvider } from '@saip/shared'
import { startFakeS3, FAKE_ACCESS_KEY, FAKE_SECRET_KEY, type FakeS3 } from '@saip/shared/testing'
import { createApp } from '../src/index.js'

const repoConfig = fileURLToPath(new URL('../../saip.yaml', import.meta.url))
const seed = readFileSync(repoConfig, 'utf8')

/**
 * A copy of the committed config with dev auth and an explicit `storage:` block. Literal values
 * rather than `${VAR}` so interpolation, and therefore the shell, cannot change the outcome.
 */
function configWith(storageYaml: string): string {
  const p = join(mkdtempSync(join(tmpdir(), 'saip-storage-')), 'saip.yaml')
  const withoutBlock = seed.replace(/^storage:\n(?:[ \t].*\n|\n)/m, '')
  writeFileSync(p, `${withoutBlock.replace('dev_mode: false', 'dev_mode: true')}\n${storageYaml}`)
  return p
}

/** A store path that does not exist: "nothing stored", not "unlock the developer's real vault". */
const sealedEnv = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  SAIP_SECRETS_FILE: join(mkdtempSync(join(tmpdir(), 'saip-store-')), 'secrets.enc.json'),
  ...over,
})

const r2Block = (endpoint: string, bucket = 'loop-bucket') =>
  `storage:\n  r2:\n    bucket: "${bucket}"\n    endpoint: "${endpoint}"\n`

let fake: FakeS3
let lines: string[] = []
let realWrite: typeof process.stderr.write

beforeAll(async () => { fake = await startFakeS3() })
afterAll(async () => { await fake.close() })

beforeEach(() => {
  lines = []
  realWrite = process.stderr.write.bind(process.stderr)
  ;(process as any).stderr.write = (c: any) => { lines.push(String(c)); return true }
})

// Restored per test rather than in afterAll: a leaked stderr patch hides every later failure.
function restoreStderr(): void { (process as any).stderr.write = realWrite }

describe('inference composition root resolves storage from config', () => {
  it('default construction with a bucket selects the R2 provider, not a memory stand-in', async () => {
    try {
      const ctx = (await createApp({
        configPath: configWith(r2Block(fake.baseUrl)),
        env: sealedEnv({ SAIP_R2_ACCESS_KEY_ID: FAKE_ACCESS_KEY, SAIP_R2_SECRET_ACCESS_KEY: FAKE_SECRET_KEY }),
      })) as any
      expect(ctx.gatewayState.storage).toBeInstanceOf(R2StorageProvider)
      expect((ctx.gatewayState.storage as R2StorageProvider).bucket).toBe('loop-bucket')
    } finally { restoreStderr() }
  })

  it('the wired provider really talks to the configured endpoint over HTTP', async () => {
    try {
      const ctx = (await createApp({
        configPath: configWith(r2Block(fake.baseUrl)),
        env: sealedEnv({ SAIP_R2_ACCESS_KEY_ID: FAKE_ACCESS_KEY, SAIP_R2_SECRET_ACCESS_KEY: FAKE_SECRET_KEY }),
      })) as any
      // Through the assembled gateway — not a unit call on the class. This is the assertion that
      // would have failed under the old default, where the "storage" the gateway used was a Map.
      const res = await ctx.dataSessions.app.request('/v1/data/sessions', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ caller: 'adrian', adapter_id: 'coding', messages: [{ role: 'user', content: 'hi' }] }),
      })
      if (res.status !== 201 && res.status !== 200) {
        throw new Error(`session write failed: ${res.status} ${await res.text()}`)
      }
      expect(fake.keys().some((k) => k.startsWith('/loop-bucket/sessions/'))).toBe(true)
    } finally { restoreStderr() }
  })

  it('reads the promoted-version index from the same store', async () => {
    // Seed the index before boot: `makeLatestVersion` loads it at construction.
    const body = JSON.stringify({ adapters: { general: { latest: 42 } }, aliases: {}, updated_at: '' })
    await fake.putObject('loop-bucket', 'adapters/_index.json', body)
    try {
      const ctx = (await createApp({
        configPath: configWith(r2Block(fake.baseUrl)),
        env: sealedEnv({ SAIP_R2_ACCESS_KEY_ID: FAKE_ACCESS_KEY, SAIP_R2_SECRET_ACCESS_KEY: FAKE_SECRET_KEY }),
      })) as any
      expect(ctx.adapterCompiler !== undefined).toBe(true)
      expect(fake.listRequestsFor('loop-bucket', '').length + fake.requests.filter((r) => r.path === '/loop-bucket/adapters/_index.json').length)
        .toBeGreaterThan(0)
    } finally { restoreStderr() }
  })

  it('an empty bucket refuses to boot and names SAIP_R2_BUCKET', async () => {
    try {
      await expect(createApp({
        configPath: configWith(r2Block(fake.baseUrl, '')),
        env: sealedEnv({ SAIP_R2_ACCESS_KEY_ID: FAKE_ACCESS_KEY, SAIP_R2_SECRET_ACCESS_KEY: FAKE_SECRET_KEY }),
      })).rejects.toThrow(/SAIP_R2_BUCKET/)
    } finally { restoreStderr() }
  })

  it('a configured bucket with no credentials refuses to boot and names the credential', async () => {
    try {
      await expect(createApp({
        configPath: configWith(r2Block(fake.baseUrl)),
        env: sealedEnv(),
      })).rejects.toThrow(/SAIP_R2_ACCESS_KEY_ID/)
    } finally { restoreStderr() }
  })

  it('memory still works when opted into by name, and says so on stderr', async () => {
    try {
      const ctx = (await createApp({
        configPath: configWith(r2Block(fake.baseUrl)),
        env: sealedEnv({ SAIP_STORAGE: 'memory' }),
      })) as any
      expect(ctx.gatewayState.storage).toBeInstanceOf(MemoryStorage)
      expect(lines.join('')).toContain('EXPLICIT MEMORY')
      // The opt-in line never repeats a credential.
      expect(lines.join('')).not.toContain(FAKE_SECRET_KEY)
    } finally { restoreStderr() }
  })
})
