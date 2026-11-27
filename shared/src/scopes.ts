/**
 * Scope resolution (#196, design record §P1).
 *
 * An adapter's `data_scopes` names *where* a training strategy reads, not *what* it reads:
 * `sessions`, `feedback`, `documents`, or a saved selector `library:<name>`. Turning those strings
 * into concrete member keys is the first stage of the pipeline, and it lives in `@saip/shared`
 * because both gateways need the same answer — inference materializes library manifests against
 * the knowledge index, training resolves the same scopes into a dataset, and two implementations of
 * "which object is a document" is precisely the drift #196 exists to remove.
 *
 * Everything here goes through the `StorageProvider` seam. That is not ceremony: the same code runs
 * against memory in tests, the in-process fake S3 in the loop e2e, and real R2 in production, and a
 * concrete client anywhere in this path would make the hermetic tier a lie.
 *
 * The load-bearing decision is that **nothing here can produce a silent empty result**. Every path
 * that could yield zero members returns a structured failure instead, because training on zero
 * records does not error — it "succeeds" and shifts the adapter's weights toward forgetting, with a
 * green job record as the only trace.
 */
import type { StorageProvider } from './storage.js'
import type { LearningJobRecord } from './types.js'

export type ScopeKind = 'sessions' | 'feedback' | 'documents' | 'library'

export interface ResolvedScope {
  /** The scope string exactly as the adapter or request declared it. */
  scope: string
  kind: ScopeKind
  /** Member keys, sorted, all confirmed present at resolution time. */
  keys: string[]
}

export type ScopeError = { code: 'no_scopes' | 'unknown_scope' | 'library_not_found' | 'library_empty' | 'empty_scope'; message: string }

export type ScopeResolution = { ok: true; scopes: ResolvedScope[] } | { ok: false; error: ScopeError }

/** Minimal job shape: resolution needs the scopes and an optional id narrowing, nothing else. */
type ScopeInput = Pick<LearningJobRecord, 'data_scopes'> & Partial<Pick<LearningJobRecord, 'data_ids'>>

const LIBRARY_PREFIX = 'library:'

/**
 * Which object represents a knowledge document, given everything stored under its prefix.
 *
 * Preference order is the #198 retention layout: `processed.md` (what a dataset wants), then
 * `source.*` (raw bytes, re-processable), then the pre-#198 `content.*` (processed text stored as
 * the only object). Both gateways call this instead of each keeping a copy of the rule.
 */
export function selectKnowledgeObject(keys: string[]): string | undefined {
  const relevant = keys.filter((k) => !k.endsWith('manifest.json') && !k.endsWith('_index.json'))
  return relevant.find((k) => k.endsWith('/processed.md'))
    ?? relevant.find((k) => /\/source\.[a-z0-9]+$/i.test(k))
    ?? relevant.find((k) => /\/content\.[a-z0-9]+$/i.test(k))
    ?? relevant[0]
}

/** Does a storage key belong to one of the requested record ids? Keys are `<prefix>/<id>/…` or `<prefix>/<id>.json`. */
function matchesId(key: string, ids: string[]): boolean {
  return ids.some((id) => key.includes(`/${id}/`) || key.endsWith(`/${id}.json`) || key.endsWith(`/${id}.jsonl`))
}

/**
 * Resolve every scope on a job.
 *
 * Order matters: the first unresolvable scope aborts, so a partially-resolved dataset can never be
 * assembled. The alternative — skip the dead scope, train on the rest — produces a job record that
 * says `succeeded` while silently excluding the corpus the operator meant to include.
 */
export async function resolveScopes(job: ScopeInput, storage: StorageProvider): Promise<ScopeResolution> {
  const scopes = job.data_scopes ?? []
  if (scopes.length === 0) {
    return {
      ok: false,
      error: {
        code: 'no_scopes',
        message: 'the job declares no data_scopes, so there is nothing to train on. Check the adapter registry entry (training.data_scopes) or pass data_scopes explicitly.',
      },
    }
  }

  const ids = job.data_ids?.length ? job.data_ids : undefined
  const resolved: ResolvedScope[] = []

  for (const scope of scopes) {
    if (scope === 'sessions') {
      const all = (await storage.list('sessions/')).filter((k) => k.endsWith('conversation.jsonl'))
      const keys = ids ? all.filter((k) => matchesId(k, ids)) : all
      if (!keys.length) return empty(scope, 'sessions/ — no recorded conversations. Sessions are written by the inference gateway\'s Data API.')
      resolved.push({ scope, kind: 'sessions', keys: keys.sort() })
      continue
    }

    if (scope === 'feedback') {
      const all = (await storage.list('feedback/')).filter((k) => k.endsWith('.json') && !k.endsWith('_index.json'))
      const keys = ids ? all.filter((k) => matchesId(k, ids)) : all
      if (!keys.length) return empty(scope, 'feedback/ — no feedback records. The Data API writes them when a user rates a reply.')
      resolved.push({ scope, kind: 'feedback', keys: keys.sort() })
      continue
    }

    if (scope === 'documents') {
      const keys = await documentKeys(storage, ids)
      if (!keys.length) return empty(scope, 'knowledge/ — the document index is empty. Upload through POST /v1/data/documents.')
      resolved.push({ scope, kind: 'documents', keys })
      continue
    }

    if (scope.startsWith(LIBRARY_PREFIX)) {
      const name = scope.slice(LIBRARY_PREFIX.length)
      const raw = await storage.get(`libraries/${name}/manifest.json`)
      if (!raw) {
        return {
          ok: false,
          error: {
            code: 'library_not_found',
            message: `no materialized manifest for scope "${scope}" (libraries/${name}/manifest.json). Declare it under libraries: in saip.yaml and let the inference gateway materialize the manifest before queueing the job.`,
          },
        }
      }
      let manifest: { members?: string[] }
      try { manifest = JSON.parse(raw) as { members?: string[] } } catch {
        return { ok: false, error: { code: 'library_not_found', message: `libraries/${name}/manifest.json is not readable JSON.` } }
      }
      // Verify each member still exists: a manifest is a snapshot, and pruning a document is
      // allowed to make a library smaller. Training on a dangling key would fail deeper in.
      const present: string[] = []
      for (const member of manifest.members ?? []) {
        if ((await storage.get(member)) !== undefined) present.push(member)
      }
      const keys = ids ? present.filter((k) => matchesId(k, ids)) : present
      if (!keys.length) return empty(scope, `library "${name}" resolved to zero existing members (${(manifest.members ?? []).length} recorded).`)
      resolved.push({ scope, kind: 'library', keys: keys.sort() })
      continue
    }

    return {
      ok: false,
      error: {
        code: 'unknown_scope',
        message: `"${scope}" is not a resolvable data scope. Known scopes: sessions, feedback, documents, or library:<name> from the libraries: config.`,
      },
    }
  }

  return { ok: true, scopes: resolved }
}

function empty(scope: string, detail: string): ScopeResolution {
  return {
    ok: false,
    error: { code: 'empty_scope', message: `scope "${scope}" resolved to no records: ${detail} An empty dataset must not reach the trainer — training on nothing reports success and un-learns behavior.` },
  }
}

/** Knowledge members via the index, each resolved through the shared object-preference rule. */
async function documentKeys(storage: StorageProvider, ids?: string[]): Promise<string[]> {
  const out: string[] = []
  let docIds: string[] = []
  try {
    const raw = await storage.get('knowledge/_index.json')
    if (raw) docIds = Object.keys((JSON.parse(raw).documents ?? {}) as Record<string, unknown>)
  } catch { /* index absent → falls through to a prefix scan below */ }

  if (!docIds.length) {
    // No usable index: discover documents by listing, so a bucket written before the index existed
    // (or with a stale one) still resolves instead of silently reporting "nothing".
    const keys = await storage.list('knowledge/')
    docIds = [...new Set(keys.map((k) => k.replace(/^knowledge\//, '').split('/')[0]).filter(Boolean))]
  }

  for (const id of docIds) {
    if (ids && !ids.includes(id)) continue
    const prefixKeys = await storage.list(`knowledge/${id}/`)
    const chosen = selectKnowledgeObject(prefixKeys)
    if (chosen) out.push(chosen)
  }
  return out.sort()
}
