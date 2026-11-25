/**
 * Library materialization at the inference gateway (#196, epic #64 B3).
 *
 * Training resolves `library:<name>` by reading `libraries/<name>/manifest.json`. Someone has to
 * write that manifest, and it has to be the gateway that owns `knowledge/` — the same single-writer
 * rule the design record applies to every prefix. Splitting it (config parsed in one place, index
 * written in another, manifest computed by a third) is how a library and its corpus drift apart.
 *
 * The interesting assertions are the cheap ones: a document uploaded *after* boot appears in the
 * manifest, a deleted one disappears, and a library removed from config leaves no orphan manifest
 * behind. "Re-materializable after a filter edit" is only worth saying if pruning actually happens.
 */
import { describe, it, expect } from 'vitest'
import { Context } from 'cordis'
import { MemoryStorage, type LibraryDefinition, type LibraryManifest } from '@saip/shared'
import { DataDocumentsService } from '../src/plugins/data-documents.js'

/** Rest args, because the pruning test needs one call shape for both runs. */
const libs = (...defs: LibraryDefinition[]): LibraryDefinition[] => defs

async function boot(libraries: LibraryDefinition[], storage = new MemoryStorage()) {
  const ctx = new Context()
  await ctx.plugin(DataDocumentsService, { storage, libraries })
  await (ctx as any).dataDocuments.ready
  return { svc: ctx.dataDocuments!, storage }
}

const upload = (svc: any, body: Record<string, unknown>) =>
  svc.app.request('/v1/data/documents', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })

async function manifest(storage: MemoryStorage, name: string): Promise<LibraryManifest | undefined> {
  const raw = await storage.get(`libraries/${name}/manifest.json`)
  return raw ? (JSON.parse(raw) as LibraryManifest) : undefined
}

describe('materialize on boot', () => {
  it('writes a manifest per declared library, with the filter recorded', async () => {
    const { storage } = await boot([
      { name: 'wiki', filter: { tags: ['wiki'] } },
      { name: 'all', filter: {} },
    ])
    const wiki = await manifest(storage, 'wiki')
    expect(wiki).toMatchObject({ name: 'wiki', filter: { tags: ['wiki'] }, count: 0, members: [] })
    expect((await manifest(storage, 'all'))!.name).toBe('all')
    expect(typeof wiki!.updated_at).toBe('string')
  })

  it('indexes the libraries it wrote', async () => {
    const { storage } = await boot([{ name: 'wiki', filter: { tags: ['wiki'] } }])
    const index = JSON.parse((await storage.get('libraries/_index.json'))!)
    expect(Object.keys(index.libraries)).toEqual(['wiki'])
  })

  it('no libraries section means nothing is written — existing configs are unaffected', async () => {
    const { storage } = await boot([])
    expect(await storage.list('libraries/')).toEqual([])
  })
})

describe('membership follows the knowledge index', () => {
  it('an upload after boot lands in the matching manifest', async () => {
    const { svc, storage } = await boot([{ name: 'wiki', filter: { tags: ['wiki'] } }])
    const res = await upload(svc, { source: 'a.md', source_type: 'document', content: '# A', tags: ['wiki'] })
    const created = await res.json()
    const m = await manifest(storage, 'wiki')
    expect(m!.members).toEqual([`knowledge/${created.id}/processed.md`])
    expect(m!.count).toBe(1)
  })

  it('a document without the tag stays out', async () => {
    const { svc, storage } = await boot([{ name: 'wiki', filter: { tags: ['wiki'] } }])
    await upload(svc, { source: 'a.md', source_type: 'document', content: '# A', tags: ['other'] })
    expect((await manifest(storage, 'wiki'))!.members).toEqual([])
  })

  it('all listed tags must match, not any', async () => {
    const { svc, storage } = await boot([{ name: 'both', filter: { tags: ['a', 'b'] } }])
    await upload(svc, { source: 'one.md', source_type: 'document', content: 'x', tags: ['a'] })
    expect((await manifest(storage, 'both'))!.members).toEqual([])
    await upload(svc, { source: 'two.md', source_type: 'document', content: 'y', tags: ['a', 'b', 'c'] })
    expect((await manifest(storage, 'both'))!.members).toHaveLength(1)
  })

  it('source_type and explicit ids narrow the selection', async () => {
    const { svc, storage } = await boot([
      { name: 'repos', filter: { source_type: 'repository' } },
      { name: 'pinned', filter: { ids: ['doc-pinned'] } },
    ])
    await upload(svc, { source: 'x.md', source_type: 'repository', content: 'repo-ish' })
    expect((await manifest(storage, 'repos'))!.members).toHaveLength(1)
    expect((await manifest(storage, 'pinned'))!.members).toEqual([])
  })

  it('a member is the document\'s resolved object key, not a directory', async () => {
    const { svc, storage } = await boot([{ name: 'all', filter: {} }])
    const created = await (await upload(svc, { source: 'a.md', source_type: 'document', content: '# A' })).json()
    const m = await manifest(storage, 'all')
    expect(m!.members).toEqual([`knowledge/${created.id}/processed.md`])
    // The key must be readable: training verifies members exist.
    expect(await storage.get(m!.members[0])).toBeTruthy()
  })

  it('deleting a document removes it from every manifest', async () => {
    const { svc, storage } = await boot([{ name: 'wiki', filter: { tags: ['wiki'] } }])
    const created = await (await upload(svc, { source: 'a.md', source_type: 'document', content: '# A', tags: ['wiki'] })).json()
    expect((await manifest(storage, 'wiki'))!.count).toBe(1)
    await svc.app.request(`/v1/data/documents/${created.id}`, { method: 'DELETE' })
    const m = await manifest(storage, 'wiki')
    expect(m!.members).toEqual([])
    expect(m!.count).toBe(0)
  })
})

describe('pruning', () => {
  it('a library dropped from config leaves no manifest and no index entry', async () => {
    const storage = new MemoryStorage()
    const first = await boot([{ name: 'gone', filter: {} }, { name: 'keep', filter: {} }], storage)
    await first.svc.ready
    expect(await manifest(storage, 'gone')).toBeTruthy()

    // Second gateway, one library removed from config.
    const ctx = new Context()
    await ctx.plugin(DataDocumentsService, { storage, libraries: libs({ name: 'keep', filter: {} }) })
    await (ctx as any).dataDocuments.ready
    expect(await manifest(storage, 'gone')).toBeUndefined()
    expect(await manifest(storage, 'keep')).toBeTruthy()
    const index = JSON.parse((await storage.get('libraries/_index.json'))!)
    expect(Object.keys(index.libraries)).toEqual(['keep'])
  })
})
