/**
 * Raw-input retention (#198, design record §1.4).
 *
 * Before this change the Data API stored the *processed* text under `content<ext>` and threw the
 * upload away. That makes the knowledge corpus un-reprocessable: a processor fix, a new OCR
 * backend (#199), or a different chunker is worthless if the only bytes on disk were produced by
 * the thing being replaced — and the hash recorded in the index described the processed output,
 * so even deduplication was comparing the wrong artifact.
 *
 * New writes keep both objects and name them in the index. Pre-existing entries are read through
 * the documented fallback, so no re-ingestion migration is required for a bucket that already has
 * data in it.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { Context } from 'cordis'
import { MemoryStorage } from '@saip/shared'
import { DataDocumentsService } from '../src/plugins/data-documents.js'

async function boot(storage = new MemoryStorage()) {
  const ctx = new Context()
  await ctx.plugin(DataDocumentsService, { storage })
  return { app: ctx.dataDocuments!.app, storage }
}

const upload = (app: any, body: Record<string, unknown>) =>
  app.request('/v1/data/documents', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })

describe('knowledge/<id>/ object layout', () => {
  let app: any
  let storage: MemoryStorage
  beforeEach(async () => { const b = await boot(); app = b.app; storage = b.storage })

  it('stores the original upload and the processed text as separate objects', async () => {
    const res = await upload(app, { source: 'wiki/onboarding.md', source_type: 'document', content: '# On\n\nraw text' })
    expect(res.status).toBe(201)
    const entry = await res.json()

    expect(entry.source_key).toBe(`knowledge/${entry.id}/source.md`)
    expect(entry.processed_key).toBe(`knowledge/${entry.id}/processed.md`)
    expect(await storage.get(entry.source_key)).toBe('# On\n\nraw text')
    expect(typeof await storage.get(entry.processed_key)).toBe('string')
  })

  it('the recorded hash describes the source bytes, not the processor output', async () => {
    const content = '---\ntags: [wiki]\n---\n# Onboarding\n\nread the manual'
    const res = await upload(app, { source: 'a.md', source_type: 'document', content })
    const entry = await res.json()
    const { createHash } = await import('node:crypto')
    expect(entry.hash).toBe('sha256:' + createHash('sha256').update(content).digest('hex'))
    expect(entry.size_bytes).toBe(Buffer.byteLength(content, 'utf8'))
    // The processor does change these bytes (frontmatter is stripped), and the manifest hash still
    // describes the *source*. That is the point: re-processing with a different processor must not
    // look like a new document arriving.
    expect(await storage.get(entry.processed_key)).not.toBe(content)
  })

  it('no longer writes the ambiguous `content<ext>` key for new uploads', async () => {
    const res = await upload(app, { source: 'a.md', source_type: 'document', content: '# hi' })
    const entry = await res.json()
    expect(await storage.get(`knowledge/${entry.id}/content.md`)).toBeUndefined()
  })

  it('duplicate detection still hits on identical source content', async () => {
    await upload(app, { source: 'a.md', source_type: 'document', content: '# same' })
    const again = await upload(app, { source: 'elsewhere.md', source_type: 'document', content: '# same' })
    expect(again.status).toBe(200)
    expect((await again.json()).duplicate).toBe(true)
  })
})

describe('legacy entries (content<ext> only)', () => {
  it('resolve through the fallback without re-ingestion', async () => {
    const storage = new MemoryStorage()
    const legacy = {
      documents: {
        'doc-20250101-001': {
          id: 'doc-20250101-001', source: 'old.md', source_type: 'document', hash: 'sha256:zz',
          size_bytes: 5, processed_by: 'markdown-processor', created_at: '2025-01-01T00:00:00.000Z',
        },
      },
      updated_at: '2025-01-01T00:00:00.000Z',
    }
    await storage.put('knowledge/_index.json', JSON.stringify(legacy))
    // Pre-#198 stored the processed text under content<ext>; nothing else exists for this entry.
    await storage.put('knowledge/doc-20250101-001/content.md', '# ancient')

    const ctx = new Context()
    await ctx.plugin(DataDocumentsService, { storage })
    const keys = await ctx.dataDocuments!.contentKeys('doc-20250101-001')
    expect(keys).toEqual({ source: 'knowledge/doc-20250101-001/content.md', processed: 'knowledge/doc-20250101-001/content.md' })
    expect(await storage.get(keys!.processed)).toBe('# ancient')
  })

  it('an unknown id resolves to nothing rather than guessing a key', async () => {
    const ctx = new Context()
    await ctx.plugin(DataDocumentsService, { storage: new MemoryStorage() })
    expect(await ctx.dataDocuments!.contentKeys('doc-nope')).toBeUndefined()
  })

  it('delete removes whatever objects exist under the prefix, new or legacy layout', async () => {
    const storage = new MemoryStorage()
    await storage.put('knowledge/doc-1/content.md', 'legacy')
    const ctx = new Context()
    await ctx.plugin(DataDocumentsService, { storage })
    await storage.put('knowledge/_index.json', JSON.stringify({
      documents: { 'doc-1': { id: 'doc-1', source: 'a', source_type: 'document', hash: 'h', size_bytes: 1, processed_by: 'p', created_at: 'now' } },
    }))
    const res = await ctx.dataDocuments!.app.request('/v1/data/documents/doc-1', { method: 'DELETE' })
    expect(res.status).toBe(204)
    expect((await storage.list('knowledge/doc-1/')).filter((k) => !k.endsWith('_index.json'))).toEqual([])
  })
})
