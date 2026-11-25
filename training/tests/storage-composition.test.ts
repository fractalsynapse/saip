/**
 * Training composition root, storage tier (#198).
 *
 * Same rule as the inference gateway: the default construction path must resolve a real provider
 * from config + environment with nothing injected. Training is the root that matters most for it,
 * because the job record is the thing that has to survive a killed cloud instance — a `jobs/`
 * store living in a process Map is not a job store, it is a rumor.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { R2StorageProvider, MemoryStorage } from '@saip/shared'
import { startFakeS3, FAKE_ACCESS_KEY, FAKE_SECRET_KEY, type FakeS3 } from '@saip/shared/testing'
import { createApp } from '../src/index.js'

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
function restore(): void { (process as any).stderr.write = realWrite }

const storeEnv = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  SAIP_SECRETS_FILE: join(mkdtempSync(join(tmpdir(), 'saip-tr-store-')), 'secrets.enc.json'),
  ...over,
})

const base = { security: { dev_mode: true }, adapters: [], registeredStrategies: ['corrective_sft'] }

describe('training root resolves storage from config', () => {
  it('a configured bucket selects the R2 provider with nothing injected', async () => {
    try {
      await createApp({
        ...base,
        config: { storage: { r2: { bucket: 'loop-bucket', endpoint: fake.baseUrl } } },
        env: storeEnv({ SAIP_R2_ACCESS_KEY_ID: FAKE_ACCESS_KEY, SAIP_R2_SECRET_ACCESS_KEY: FAKE_SECRET_KEY }),
      })
      expect(lines.join('')).toContain('R2StorageProvider')
      expect(lines.join('')).not.toContain(FAKE_SECRET_KEY)
    } finally { restore() }
  })

  it('no bucket means the gateway refuses to boot rather than inventing a store', async () => {
    try {
      await expect(createApp({ ...base, config: {}, env: storeEnv() })).rejects.toThrow(/SAIP_R2_BUCKET/)
    } finally { restore() }
  })

  it('configured bucket without credentials refuses to boot and names the credential', async () => {
    try {
      await expect(createApp({
        ...base,
        config: { storage: { r2: { bucket: 'loop-bucket', endpoint: fake.baseUrl } } },
        env: storeEnv(),
      })).rejects.toThrow(/SAIP_R2_ACCESS_KEY_ID/)
    } finally { restore() }
  })

  it('SAIP_STORAGE=memory is honored and announces that job records die at restart', async () => {
    try {
      const ctx = await createApp({ ...base, env: storeEnv({ SAIP_STORAGE: 'memory' }) })
      expect(lines.join('')).toContain('EXPLICIT MEMORY')
      expect(lines.join('')).toContain('job records die at restart')
      void ctx
    } finally { restore() }
  })

  it('an injected provider still wins — the seam is preserved for the job-store tests (#197)', async () => {
    try {
      const storage = new MemoryStorage()
      await createApp({ ...base, storage, env: storeEnv() })
      expect(lines.join('')).toContain('EXPLICIT MEMORY')
    } finally { restore() }
  })
})
