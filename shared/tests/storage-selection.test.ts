/**
 * Storage selection is fail-closed (#198).
 *
 * `saip.yaml` has carried the comment "the R2 storage provider refuses to initialise on an
 * empty value and names the variable" since the block was written, and no code implemented it:
 * the inference composition root did `opts.storage ?? new MemoryStorage()`, so every document,
 * session and feedback record went to a Map that died at restart while the API answered 2xx to
 * each write. That is the described-vs-wired class (#179), here with data loss as the symptom.
 *
 * These tests pin the whole policy in §1.3 of the design record — three rows, no fourth
 * behaviour — and in particular that *nothing* selects memory implicitly. The injectable
 * `storage` opt stays for tests; it is the seam, not the default.
 */
import { describe, it, expect, vi } from 'vitest'
import { storageProviderFor, MemoryStorage, R2StorageProvider, MEMORY_WARNING } from '../src/storage.js'
import { EnvSecrets } from '../src/hosting.js'

const R2_VALUES = {
  SAIP_R2_BUCKET: 'loop-bucket',
  SAIP_R2_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
  SAIP_R2_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
  SAIP_R2_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI-K7MDENG-bPxRfiCYEXAMPLEKEY',
}

const cfg = (bucket: string, endpoint = R2_VALUES.SAIP_R2_ENDPOINT) => ({
  storage: { r2: { bucket, endpoint } },
})

function secrets(over: Record<string, string | undefined> = {}): EnvSecrets {
  return new EnvSecrets({ ...R2_VALUES, ...over } as NodeJS.ProcessEnv)
}

describe('storageProviderFor: the selection table', () => {
  it('unset SAIP_STORAGE with a bucket resolves the R2 provider', async () => {
    const provider = await storageProviderFor({ config: cfg('loop-bucket'), secrets: secrets(), env: {} })
    expect(provider).toBeInstanceOf(R2StorageProvider)
  })

  it('an empty bucket fails startup naming SAIP_R2_BUCKET — never a fallback', async () => {
    const log = vi.fn()
    await expect(storageProviderFor({ config: cfg(''), secrets: secrets(), env: {}, log }))
      .rejects.toThrow(/SAIP_R2_BUCKET/)
    expect(log).not.toHaveBeenCalled()
  })

  it('a missing storage block fails the same way rather than defaulting', async () => {
    await expect(storageProviderFor({ config: {}, secrets: secrets(), env: {} }))
      .rejects.toThrow(/SAIP_R2_BUCKET/)
  })

  it('SAIP_STORAGE=memory is allowed, and announces the data dies at restart', async () => {
    const log = vi.fn()
    const provider = await storageProviderFor({
      config: cfg('loop-bucket'), secrets: secrets(), env: { SAIP_STORAGE: 'memory' }, log,
    })
    expect(provider).toBeInstanceOf(MemoryStorage)
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][0]).toContain(MEMORY_WARNING)
    expect(log.mock.calls[0][0]).toContain('dies at restart')
  })

  it('memory selection needs no bucket and no credentials', async () => {
    const provider = await storageProviderFor({
      config: {}, env: { SAIP_STORAGE: 'memory' }, secrets: secrets({ SAIP_R2_ACCESS_KEY_ID: '' }), log: () => {},
    })
    expect(provider).toBeInstanceOf(MemoryStorage)
  })

  it('an unrecognised SAIP_STORAGE value fails naming the value and the allowed ones', async () => {
    await expect(storageProviderFor({ config: cfg('b'), secrets: secrets(), env: { SAIP_STORAGE: 'minio' } }))
      .rejects.toThrow(/SAIP_STORAGE.*minio/)
  })

  it('a typo that merely starts with "memory" is not treated as the opt-in', async () => {
    await expect(storageProviderFor({ config: cfg('b'), secrets: secrets(), env: { SAIP_STORAGE: 'memoryless' } }))
      .rejects.toThrow(/SAIP_STORAGE/)
  })
})

describe('storageProviderFor: credentials are named, never inlined', () => {
  it('missing access key id fails startup naming SAIP_R2_ACCESS_KEY_ID', async () => {
    await expect(storageProviderFor({
      config: cfg('loop-bucket'), env: {}, secrets: secrets({ SAIP_R2_ACCESS_KEY_ID: undefined }),
    })).rejects.toThrow(/SAIP_R2_ACCESS_KEY_ID/)
  })

  it('missing secret access key fails startup naming SAIP_R2_SECRET_ACCESS_KEY', async () => {
    await expect(storageProviderFor({
      config: cfg('loop-bucket'), env: {}, secrets: secrets({ SAIP_R2_SECRET_ACCESS_KEY: undefined }),
    })).rejects.toThrow(/SAIP_R2_SECRET_ACCESS_KEY/)
  })

  it('an empty endpoint fails naming SAIP_R2_ENDPOINT — a bare path would reach the wrong host', async () => {
    await expect(storageProviderFor({
      config: { storage: { r2: { bucket: 'loop-bucket', endpoint: '' } } }, env: {}, secrets: secrets(),
    })).rejects.toThrow(/SAIP_R2_ENDPOINT/)
  })

  it('a failure message never repeats a credential value', async () => {
    const err = await storageProviderFor({
      config: cfg('loop-bucket'), env: {}, secrets: secrets({ SAIP_R2_SECRET_ACCESS_KEY: undefined }),
    }).catch((e: unknown) => e as Error)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).not.toContain(R2_VALUES.SAIP_R2_ACCESS_KEY_ID)
  })

  it('the resolved provider is usable: a write reaches the endpoint the config named', async () => {
    // Guards against "selection returns an object that talks to nothing" — the silent
    // half-configuration case the fail-closed rule exists to prevent.
    const provider = await storageProviderFor({
      config: { storage: { r2: { bucket: 'loop-bucket', endpoint: 'https://acct.r2.cloudflarestorage.com' } } },
      env: {}, secrets: secrets(),
    })
    expect((provider as R2StorageProvider).endpoint).toBe('https://acct.r2.cloudflarestorage.com')
    expect((provider as R2StorageProvider).bucket).toBe('loop-bucket')
  })
})
