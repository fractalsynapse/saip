/**
 * data-documents — Data API document ingestion. Validates, dedups by sha256,
 * routes to the matching processor plugin, stores content + manifest under
 * knowledge/<id>/ in storage, and maintains knowledge/_index.json. Emits
 * document/uploaded, document/processed, data/stored for other plugins.
 */

import { Service } from 'cordis'
import { Hono } from 'hono'
import { createHash } from 'node:crypto'
import type { StorageProvider } from '../lib/backends.js'
import { selectKnowledgeObject, type LibraryDefinition, type LibraryIndex, type LibraryManifest } from '@saip/shared'
import { processorFor, type ProcessMeta } from '../lib/doc-processors.js'

/** Filters a document's index entry against a library's selector clause. */
function inLibrary(entry: DocIndexEntry, filter?: LibraryDefinition['filter']): boolean {
  if (!filter) return true
  if (filter.ids?.length && !filter.ids.includes(entry.id)) return false
  if (filter.source_type && entry.source_type !== filter.source_type) return false
  if (filter.tags?.length) {
    const have = new Set(entry.tags ?? [])
    if (!filter.tags.every((t) => have.has(t))) return false
  }
  return true
}

export interface DataDocumentsConfig {
  storage: StorageProvider
  /**
   * Declared libraries to materialize as `libraries/<name>/manifest.json` (#196, epic #64 B3).
   * Training resolves `library:<name>` by reading those manifests, and this gateway owns
   * `knowledge/` — the single-writer rule for the prefix extends to the views over it.
   */
  libraries?: LibraryDefinition[]
}

/**
 * Index entry for one knowledge document.
 *
 * `source_key` / `processed_key` are new in #198: the raw upload and the processor output are
 * separate objects, so re-processing after a processor change (#199) has something to re-process.
 * Both are optional because entries written before #198 name neither — `contentKeys()` resolves
 * those through the legacy `content<ext>` fallback rather than requiring a migration.
 */
interface DocIndexEntry {
  id: string
  source: string
  source_type: string
  hash: string
  size_bytes: number
  processed_by: string
  tags?: string[]
  created_at: string
  source_key?: string
  processed_key?: string
}

const MAX_BYTES = 10 * 1024 * 1024 // 10 MB text guard (MVP)

declare module 'cordis' {
  interface Context {
    dataDocuments?: DataDocumentsService
  }
  interface Events {
    'document/uploaded'(payload: { source: string; source_type: string }): void
    'document/processed'(payload: { source: string; processed_by: string }): void
    'data/stored'(payload: { kind: string; id: string }): void
  }
}

export class DataDocumentsService extends Service {
  static readonly provide = 'dataDocuments'
  readonly app = new Hono()
  private counter = 0
  private readonly libraries: LibraryDefinition[]
  /** Resolves after the first materialization; the composition root awaits it before serving. */
  readonly ready: Promise<void>

  constructor(ctx: any, private cfg: DataDocumentsConfig) {
    super(ctx, 'dataDocuments')
    this.libraries = cfg.libraries ?? []
    // A failed refresh is logged and retried on the next write, never a rejected promise: the
    // inference gateway serves chats, and a stale library view is not a reason to be down. The hard
    // failure belongs at job acceptance (#196), where training can say which scope was empty.
    this.ready = this.materializeLibraries().catch((e: Error) => {
      process.stderr.write(`[saip-inference] WARNING: libraries not materialized: ${e.message}\n`)
    })
    this.app.post('/v1/data/documents', (c) => this.create(c))
    this.app.get('/v1/data/documents', (c) => this.list(c))
    this.app.delete('/v1/data/documents/:id', (c) => this.remove(c))
  }

  private extOf(source: string): string | undefined {
    const m = source.match(/(\.[A-Za-z0-9]+)$/)
    return m ? m[1].toLowerCase() : undefined
  }

  private async readIndex(): Promise<{ documents: Record<string, DocIndexEntry> }> {
    try {
      const raw = await this.cfg.storage.get('knowledge/_index.json')
      if (raw) return JSON.parse(raw)
    } catch { /* ignore */ }
    return { documents: {} }
  }
  /**
   * Where a document's bytes live. New entries name their keys; entries written before #198 only
   * ever had `content<ext>`, so the legacy object is returned for both roles — the processed text
   * is all that survives, and pretending otherwise would be a migration this issue does not need.
   */
  async contentKeys(id: string): Promise<{ source: string; processed: string } | undefined> {
    const index = await this.readIndex()
    const entry = index.documents[id]
    if (!entry) return undefined
    if (entry.source_key && entry.processed_key) return { source: entry.source_key, processed: entry.processed_key }
    // No keys recorded: list the prefix, which works whatever extension the source had.
    const objects = (await this.cfg.storage.list(`knowledge/${id}/`))
      .filter((k) => !k.endsWith('manifest.json') && !k.endsWith('_index.json'))
    const legacy = objects.find((k) => k.includes('/content.')) ?? objects[0]
    return legacy ? { source: legacy, processed: legacy } : undefined
  }

  /**
   * Write `libraries/<name>/manifest.json` for every declared library, and remove the manifests of
   * libraries that are no longer declared.
   *
   * Membership is resolved through `selectKnowledgeObject`, so a library points at the same object
   * training would read — the processed text where it exists, the legacy `content.<ext>` otherwise.
   * Re-running this after every index change is deliberately blunt: the corpus is small, the filter
   * semantics live in one function, and an incremental approach is where a tag edit and a manifest
   * disagree.
   */
  async materializeLibraries(): Promise<void> {
    // Nothing declared: touch no storage. A gateway with no libraries must not spend a boot on
    // listing `libraries/`, and with an unreachable bucket it must not report a failure it cannot
    // have caused.
    if (!this.libraries.length) {
      await this.pruneAllManifestsIfAny()
      return
    }
    const index = await this.readIndex()
    const entries = Object.values(index.documents)
    const at = new Date().toISOString()
    const libIndex: LibraryIndex = { libraries: {}, updated_at: at }

    for (const lib of this.libraries) {
      const members: string[] = []
      for (const entry of entries.filter((e) => inLibrary(e, lib.filter))) {
        const chosen = selectKnowledgeObject(await this.cfg.storage.list(`knowledge/${entry.id}/`))
        if (chosen) members.push(chosen)
      }
      members.sort()
      const manifest: LibraryManifest = { name: lib.name, filter: lib.filter ?? {}, members, count: members.length, updated_at: at }
      await this.cfg.storage.put(`libraries/${lib.name}/manifest.json`, JSON.stringify(manifest, null, 2))
      libIndex.libraries[lib.name] = { count: members.length, updated_at: at }
    }

    // Prune orphans: a library removed from config must not keep serving its old membership, which
    // would train on documents the operator deliberately dropped.
    const known = new Set(this.libraries.map((l) => l.name))
    const manifests = (await this.cfg.storage.list('libraries/')).filter((k) => k.endsWith('/manifest.json'))
    for (const key of manifests) {
      const name = key.split('/')[1]
      if (name && !known.has(name)) await this.cfg.storage.delete(key)
    }

    if (this.libraries.length) await this.cfg.storage.put('libraries/_index.json', JSON.stringify(libIndex, null, 2))
    else await this.cfg.storage.delete('libraries/_index.json')
  }

  /** With no libraries declared, any manifests left from an earlier config are all orphans. */
  private async pruneAllManifestsIfAny(): Promise<void> {
    const manifests = (await this.cfg.storage.list('libraries/')).filter((k) => k.endsWith('/manifest.json'))
    if (!manifests.length && !(await this.cfg.storage.get('libraries/_index.json'))) return
    for (const key of manifests) await this.cfg.storage.delete(key)
    await this.cfg.storage.delete('libraries/_index.json')
  }

  private async writeIndex(idx: { documents: Record<string, DocIndexEntry> }) {
    await this.cfg.storage.put('knowledge/_index.json', JSON.stringify(idx, null, 2))
  }

  private async create(c: any) {
    let body: any
    try { body = await c.req.json() } catch { return c.json({ error: { message: 'invalid JSON', code: 'invalid_request' } }, 400) }
    const { source, source_type, content, license, tags } = body ?? {}
    if (!source || !source_type || typeof content !== 'string') {
      return c.json({ error: { message: 'source, source_type, content required', code: 'invalid_request' } }, 400)
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) {
      return c.json({ error: { message: 'document exceeds size limit', code: 'too_large' } }, 413)
    }
    if (!/^[\x09\x0A\x0D\x20-\x7E\x85\xA0-\uD7FF\uE000-\uFFFD]|[\s\S]/.test(content) && content.includes('\uFFFD')) {
      return c.json({ error: { message: 'content must be UTF-8 text', code: 'encoding' } }, 415)
    }

    const meta: ProcessMeta = { sourceType: source_type, ext: this.extOf(source) }
    const processor = processorFor(meta)
    if (!processor) return c.json({ error: { message: `unsupported document type: ${meta.ext ?? source_type}`, code: 'unsupported_type' } }, 422)

    const hash = 'sha256:' + createHash('sha256').update(content).digest('hex')
    const index = await this.readIndex()
    const existing = Object.values(index.documents).find((d) => d.hash === hash)
    if (existing) {
      return c.json({ ...existing, duplicate: true }, 200)
    }

    this.ctx.emit('document/uploaded', { source, source_type })
    let processed: { intermediate: string; processedBy: string }
    try { processed = processor.process(content, meta) } catch (e: any) {
      return c.json({ error: { message: e.message, code: 'processing_failed' } }, 422)
    }
    this.ctx.emit('document/processed', { source, processed_by: processed.processedBy })

    const id = `doc-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(++this.counter).padStart(3, '0')}`
    const contentExt = meta.ext ?? '.txt'
    const entry: DocIndexEntry = { id, source, source_type, hash, size_bytes: Buffer.byteLength(content, 'utf8'), processed_by: processed.processedBy, tags, created_at: new Date().toISOString() }

    // `content<ext>` held the *processed* text and the upload itself was discarded, which made the
    // corpus a one-shot artifact: any change to a processor invalidated every document with nothing
    // left to re-run. Source bytes and processed bytes now live apart and are both named (#198).
    const sourceKey = `knowledge/${id}/source${contentExt}`
    const processedKey = `knowledge/${id}/processed.md`
    entry.source_key = sourceKey
    entry.processed_key = processedKey
    // Bytes → manifest → index (§1.4). A crash between these leaves an orphan object, never an
    // index entry pointing at bytes that were never written.
    await this.cfg.storage.put(sourceKey, content)
    await this.cfg.storage.put(processedKey, processed.intermediate)
    await this.cfg.storage.put(`knowledge/${id}/manifest.json`, JSON.stringify(entry, null, 2))
    index.documents[id] = entry
    await this.writeIndex(index)
    // The library views follow the index in the same request: a manifest that lags an upload by a
    // boot cycle would make a queueing decision on stale membership.
    await this.materializeLibraries()
    this.ctx.emit('data/stored', { kind: 'document', id })

    return c.json(entry, 201)
  }

  private async list(c: any) {
    const tag = c.req.query('tag')
    const limit = Number(c.req.query('limit') ?? 50)
    const offset = Number(c.req.query('offset') ?? 0)
    const index = await this.readIndex()
    let entries = Object.values(index.documents)
    if (tag) entries = entries.filter((e) => e.tags?.includes(tag))
    const total = entries.length
    return c.json({ entries: entries.slice(offset, offset + limit), total, limit, offset })
  }

  private async remove(c: any) {
    const id = c.req.param('id')
    const index = await this.readIndex()
    if (!index.documents[id]) return c.json({ error: { message: 'not found', code: 'not_found' } }, 404)
    const extKeys = await this.cfg.storage.list(`knowledge/${id}/`)
    for (const k of extKeys) await this.cfg.storage.delete(k)
    delete index.documents[id]
    await this.writeIndex(index)
    await this.materializeLibraries()
    return c.body(null, 204)
  }
}
