/**
 * Storage contract suite (#198) — one set of assertions, run against every implementation.
 *
 * This seam holds the learning loop's only durable state: documents, sessions, feedback, job
 * records, promoted adapters. A provider that satisfies the *type* but not the documented
 * behaviour — an unsorted `list()`, a `get()` that throws on a missing key, a truncated page
 * silently treated as the whole corpus — fails the loop far from the loop, which is what this
 * file exists to catch.
 *
 * Three deliberate choices, each answering a failure this project has already had:
 * - Every behavioural assertion runs **twice**, against `MemoryStorage` and against the R2
 *   client talking to an in-process fake S3. A contract only the fake satisfies is documentation,
 *   not a constraint.
 * - The pagination tier seeds 2,500 keys and separately truncates a page, because a provider that
 *   drops a page returns a list that is sorted, plausible, and short.
 * - The signature detector is exercised with a **deliberately corrupted** signature. A fake that
 *   accepts anything proves nothing (the "described vs wired" class, #179).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import { MemoryStorage, R2StorageProvider, type StorageProvider } from '../src/storage.js'
import { startFakeS3, FAKE_ACCESS_KEY, FAKE_SECRET_KEY, type FakeS3 } from '../src/testing/fake-s3.js'

const BUCKET = 'saip-test'

type Make = () => Promise<{ provider: StorageProvider; close?: () => Promise<void> }>

function contractSuite(label: string, make: Make): void {
  describe(`StorageProvider contract — ${label}`, () => {
    it('round-trips a value and returns undefined for a key never written', async () => {
      const { provider, close } = await make()
      try {
        await provider.put('knowledge/a/manifest.json', '{"id":"a"}')
        expect(await provider.get('knowledge/a/manifest.json')).toBe('{"id":"a"}')
        expect(await provider.get('knowledge/missing.json')).toBeUndefined()
      } finally { await close?.() }
    })

    it('put is last-write-wins, not append', async () => {
      const { provider, close } = await make()
      try {
        await provider.put('sessions/_index.json', 'first')
        await provider.put('sessions/_index.json', 'second')
        expect(await provider.get('sessions/_index.json')).toBe('second')
      } finally { await close?.() }
    })

    it('preserves text exactly, including non-ASCII', async () => {
      const { provider, close } = await make()
      try {
        const text = '# heading\n\nünïcödé ✅ → done\n'
        await provider.put('knowledge/x/processed.md', text)
        expect(await provider.get('knowledge/x/processed.md')).toBe(text)
      } finally { await close?.() }
    })

    it('accepts bytes', async () => {
      const { provider, close } = await make()
      try {
        await provider.put('knowledge/bin/source.pdf', new Uint8Array([0, 1, 2, 250, 251, 252]))
        expect(typeof await provider.get('knowledge/bin/source.pdf')).toBe('string')
      } finally { await close?.() }
    })

    it('lists a prefix lexicographically and excludes other prefixes', async () => {
      const { provider, close } = await make()
      try {
        for (const k of ['feedback/c.json', 'feedback/a.json', 'feedback/b.json', 'sessions/a/manifest.json']) {
          await provider.put(k, k)
        }
        expect(await provider.list('feedback/')).toEqual(['feedback/a.json', 'feedback/b.json', 'feedback/c.json'])
        expect(await provider.list('knowledge/')).toEqual([])
      } finally { await close?.() }
    })

    it('treats a prefix as a string boundary, not a directory', async () => {
      const { provider, close } = await make()
      try {
        await provider.put('feedback/1.json', 'x')
        await provider.put('feedback/1.json.bak', 'y')
        expect(await provider.list('feedback/1')).toEqual(['feedback/1.json', 'feedback/1.json.bak'])
      } finally { await close?.() }
    })

    it('delete reports whether the key existed', async () => {
      const { provider, close } = await make()
      try {
        await provider.put('jobs/train-x.json', '{}')
        expect(await provider.delete('jobs/train-x.json')).toBe(true)
        expect(await provider.delete('jobs/train-x.json')).toBe(false)
        expect(await provider.get('jobs/train-x.json')).toBeUndefined()
      } finally { await close?.() }
    })
  })
}

contractSuite('MemoryStorage', async () => ({ provider: new MemoryStorage() }))

describe('R2StorageProvider against the fake S3 endpoint', () => {
  let fake: FakeS3
  beforeAll(async () => { fake = await startFakeS3({ enforceSignature: true }) })
  afterAll(async () => { await fake.close() })
  // One shared fake server, but not one shared namespace: without this the suite's earlier
  // writes leak into the pagination and prefix assertions below, and a length check stops
  // meaning what it says.
  beforeEach(() => { fake.reset() })

  const make: Make = async () => ({
    provider: new R2StorageProvider({
      endpoint: fake.baseUrl, bucket: BUCKET, accessKeyId: FAKE_ACCESS_KEY, secretAccessKey: FAKE_SECRET_KEY,
    }),
  })

  contractSuite('R2StorageProvider', make)

  it('signs each request with SigV4 and commits to the payload hash', async () => {
    const { provider } = await make()
    await provider.put('feedback/sig.json', 'v')
    const headers = fake.lastRequestFor('PUT', `/${BUCKET}/feedback/sig.json`).headers
    expect(headers['x-amz-content-sha256']).toBe(createHash('sha256').update('v').digest('hex'))
    const auth = headers.authorization
    expect(auth).toMatch(/^AWS4-HMAC-SHA256 /)
    expect(auth).toContain(`Credential=${FAKE_ACCESS_KEY}/`)
    expect(auth).toMatch(/\/s3\/aws4_request,/)
    expect(auth).toContain('SignedHeaders=')
    expect(auth).toContain('Signature=')
  })

  it('a corrupted signature is rejected — the detector is capable of failing', async () => {
    const provider = new R2StorageProvider({
      endpoint: fake.baseUrl, bucket: BUCKET, accessKeyId: FAKE_ACCESS_KEY, secretAccessKey: FAKE_SECRET_KEY,
      // Mutates the finished HMAC only. Pointing the same client at a fake that skipped
      // verification would make this line pass while authenticating nothing.
      signOverride: (sig) => (sig[0] === 'a' ? `b${sig.slice(1)}` : `a${sig.slice(1)}`),
    })
    await expect(provider.put('feedback/bad.json', 'v')).rejects.toMatchObject({ status: 403 })
    expect(fake.getObjectRaw(`/${BUCKET}/feedback/bad.json`)).toBeUndefined()
  })

  it('paginates past the 1,000-key page cap and returns all 2,500 keys', async () => {
    const { provider } = await make()
    const N = 2500
    fake.seed(BUCKET, Array.from({ length: N }, (_, i) => `sessions/k${String(i).padStart(5, '0')}.json`))
    const before = fake.requests.length
    const keys = await provider.list('sessions/')
    expect(keys).toHaveLength(N)
    expect(keys).toEqual([...keys].sort())
    expect(keys[0]).toBe('sessions/k00000.json')
    expect(keys[N - 1]).toBe('sessions/k02499.json')
    // Multiple LIST requests proves the provider followed the continuation tokens instead of
    // receiving a short answer and believing it.
    expect(fake.requests.slice(before).filter((r) => r.query['list-type'] === '2').length).toBeGreaterThanOrEqual(3)
  })

  it('canary: a silently dropped truncated page fails here rather than in the loop', async () => {
    const { provider } = await make()
    fake.seed(BUCKET, Array.from({ length: 1200 }, (_, i) => `feedback/drop${i}.json`))
    fake.truncateNextListPage(BUCKET, 'feedback/drop', 500)
    // Following IsTruncated yields all 1,200; ignoring it yields 500 sorted, plausible keys.
    expect(await provider.list('feedback/drop')).toHaveLength(1200)
  })

  it('maps a missing key to undefined instead of throwing', async () => {
    const { provider } = await make()
    await expect(provider.get('sessions/nope.json')).resolves.toBeUndefined()
  })

  it('lists an unwritten prefix as empty rather than erroring', async () => {
    const { provider } = await make()
    expect(await provider.list('adapters/never-written/')).toEqual([])
  })

  it('surfaces a transport failure as an error, never as an empty listing', async () => {
    const closed = await startFakeS3()
    const url = closed.baseUrl
    await closed.close()
    const provider = new R2StorageProvider({ endpoint: url, bucket: BUCKET, accessKeyId: FAKE_ACCESS_KEY, secretAccessKey: FAKE_SECRET_KEY })
    // A dead endpoint must not read as "no data": that is how a corpus becomes an empty dataset.
    await expect(provider.list('sessions/')).rejects.toBeDefined()
  })

  it('returns a sorted list even when the server answers out of order', async () => {
    const { provider } = await make()
    fake.seed(BUCKET, ['feedback/b.json', 'feedback/a.json', 'feedback/c.json'])
    fake.shuffleNextList(BUCKET, 'feedback/')
    // `MemoryStorage` sorts by construction, so only this tier can detect a provider that trusts
    // the server's ordering instead of honoring the documented contract.
    expect(await provider.list('feedback/')).toEqual(['feedback/a.json', 'feedback/b.json', 'feedback/c.json'])
  })

  it('a server error on get is an error, not a missing object', async () => {
    const { provider } = await make()
    await provider.put('adapters/_index.json', '{}')
    fake.failNext('GET', `/${BUCKET}/adapters/_index.json`, 500, 'InternalError')
    // `undefined` here means "no promoted version yet" downstream. Saying that when the bucket
    // merely 500'd is how a transient failure becomes an amnesia-shaped success.
    await expect(provider.get('adapters/_index.json')).rejects.toMatchObject({ status: 500 })
  })

  it('a server error partway through list() fails the call instead of returning a short page', async () => {
    const { provider } = await make()
    fake.seed(BUCKET, Array.from({ length: 1500 }, (_, i) => `jobs/j${String(i).padStart(4, '0')}.json`))
    fake.failNext('GET', `/${BUCKET}`, 503, 'SlowDown')
    await expect(provider.list('jobs/')).rejects.toMatchObject({ status: 503 })
  })
})
