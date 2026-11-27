/**
 * Scope resolution (#196, design record §P1).
 *
 * An adapter's `data_scopes` is a list of strings that, until now, nothing resolved: the job
 * record carried them and the pipeline ended. This is the step that turns them into concrete
 * member keys over the shared `StorageProvider`, and the step where the loop's worst silent
 * failure lives.
 *
 * The failure mode worth the most care is the empty scope. A training run over zero records does
 * not error — it "succeeds" and produces an adapter that un-learned behavior, because a LoRA
 * trained on nothing still shifts weights. So every path that could yield zero members must be a
 * structured job failure *before* any configuration is materialized, and each one gets its own
 * assertion here rather than a shared "it should fail" expectation.
 *
 * All reads go through the seam: `list()`/`get()` only. No provider is imported, because training
 * must work against memory, the fake S3, and real R2 without change.
 */
import { describe, it, expect } from 'vitest'
import { MemoryStorage, resolveScopes, type LearningJobRecord } from '@saip/shared'

const rec = (over: Partial<LearningJobRecord> = {}): LearningJobRecord => ({
  id: 'train-20261125-abc-0001', adapter: 'coding', strategy: 'corrective_sft',
  data_scopes: [], params: {}, inherited: { strategy: true, data_scopes: true },
  status: 'queued', history: [], created_at: '2026-11-25T00:00:00Z', updated_at: '2026-11-25T00:00:00Z',
  ...over,
})

async function storageWith(entries: Record<string, string>) {
  const s = new MemoryStorage()
  for (const [k, v] of Object.entries(entries)) await s.put(k, v)
  return s
}

describe('named scopes', () => {
  it('resolves sessions to their conversation keys', async () => {
    const storage = await storageWith({
      'sessions/s1/conversation.jsonl': '{"role":"user","content":"a"}\n',
      'sessions/s1/manifest.json': '{"id":"s1"}',
      'sessions/s2/conversation.jsonl': '{"role":"user","content":"b"}\n',
    })
    const r = await resolveScopes(rec({ data_scopes: ['sessions'] }), storage)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.scopes[0].keys).toEqual(['sessions/s1/conversation.jsonl', 'sessions/s2/conversation.jsonl'])
  })

  it('resolves feedback to record keys, skipping the index object', async () => {
    const storage = await storageWith({
      'feedback/_index.json': '{"records":{}}',
      'feedback/f1.json': '{"id":"f1"}',
      'feedback/f2.json': '{"id":"f2"}',
    })
    const r = await resolveScopes(rec({ data_scopes: ['feedback'] }), storage)
    expect(r.ok && r.scopes[0].keys).toEqual(['feedback/f1.json', 'feedback/f2.json'])
  })

  it('resolves documents through the knowledge index, preferring processed text', async () => {
    const storage = await storageWith({
      'knowledge/_index.json': JSON.stringify({ documents: { 'doc-1': { id: 'doc-1' } } }),
      'knowledge/doc-1/source.md': '# raw',
      'knowledge/doc-1/processed.md': '# processed',
      'knowledge/doc-1/manifest.json': JSON.stringify({ id: 'doc-1', processed_key: 'knowledge/doc-1/processed.md' }),
    })
    const r = await resolveScopes(rec({ data_scopes: ['documents'] }), storage)
    expect(r.ok && r.scopes[0].keys).toEqual(['knowledge/doc-1/processed.md'])
  })

  it('falls back to the legacy content key for pre-#198 documents', async () => {
    const storage = await storageWith({
      'knowledge/_index.json': JSON.stringify({ documents: { 'doc-9': { id: 'doc-9' } } }),
      'knowledge/doc-9/content.md': '# ancient',
    })
    const r = await resolveScopes(rec({ data_scopes: ['documents'] }), storage)
    expect(r.ok && r.scopes[0].keys).toEqual(['knowledge/doc-9/content.md'])
  })
})

describe('library:<name> scopes (#64 B3/B4)', () => {
  const library = {
    name: 'onboarding',
    filter: { tags: ['wiki'] },
    members: ['knowledge/doc-1/processed.md', 'knowledge/doc-2/processed.md'],
    count: 2,
    updated_at: '2026-11-25T00:00:00Z',
  }

  it('resolves to the materialized member keys', async () => {
    const storage = await storageWith({
      'libraries/onboarding/manifest.json': JSON.stringify(library),
      'knowledge/doc-1/processed.md': 'a', 'knowledge/doc-2/processed.md': 'b',
    })
    const r = await resolveScopes(rec({ data_scopes: ['library:onboarding'] }), storage)
    expect(r.ok && r.scopes[0]).toMatchObject({ scope: 'library:onboarding', kind: 'library', keys: library.members })
  })

  it('an unknown library fails with library_not_found, naming what was asked for', async () => {
    const storage = await storageWith({})
    const r = await resolveScopes(rec({ data_scopes: ['library:ghost'] }), storage)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('library_not_found')
  })

  it('a manifest whose members are all missing from storage fails as empty, not silent', async () => {
    const storage = await storageWith({
      'libraries/onboarding/manifest.json': JSON.stringify({ ...library, members: ['knowledge/gone/processed.md'] }),
    })
    const r = await resolveScopes(rec({ data_scopes: ['library:onboarding'] }), storage)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('empty_scope')
  })
})

describe('failure before work (Review Focus #5)', () => {
  it('an unrecognized scope name fails with unknown_scope', async () => {
    const r = await resolveScopes(rec({ data_scopes: ['vibes'] }), await storageWith({}))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('unknown_scope')
  })

  it('an empty data_scopes list fails rather than producing a zero-record dataset', async () => {
    const r = await resolveScopes(rec({ data_scopes: [] }), await storageWith({}))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('no_scopes')
  })

  it('a named scope that matches nothing fails with empty_scope', async () => {
    const r = await resolveScopes(rec({ data_scopes: ['sessions'] }), await storageWith({}))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('empty_scope')
  })

  it('reports the FIRST failure only — a partial dataset is never a success', async () => {
    const storage = await storageWith({ 'sessions/s1/conversation.jsonl': 'x' })
    const r = await resolveScopes(rec({ data_scopes: ['sessions', 'library:ghost'] }), storage)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('library_not_found')
  })

  it('the error message says which scope and what to check', async () => {
    const r = await resolveScopes(rec({ data_scopes: ['library:ghost'] }), await storageWith({}))
    expect(!r.ok && r.error.message).toMatch(/library:ghost/)
    expect(!r.ok && r.error.message).toMatch(/libraries|manifest|config/i)
  })
})

describe('data_ids narrowing', () => {
  it('restricts resolution to the requested ids across scopes', async () => {
    const storage = await storageWith({
      'sessions/s1/conversation.jsonl': 'a',
      'sessions/s2/conversation.jsonl': 'b',
    })
    const r = await resolveScopes(rec({ data_scopes: ['sessions'], data_ids: ['s2'] }), storage)
    expect(r.ok && r.scopes[0].keys).toEqual(['sessions/s2/conversation.jsonl'])
  })

  it('an id that matches nothing is an empty_scope failure, not an empty dataset', async () => {
    const storage = await storageWith({ 'sessions/s1/conversation.jsonl': 'a' })
    const r = await resolveScopes(rec({ data_scopes: ['sessions'], data_ids: ['nope'] }), storage)
    expect(r.ok).toBe(false)
  })
})
