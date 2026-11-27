/**
 * Test fixture: a store with a resolvable corpus (#196).
 *
 * Queueing a job now resolves the adapter's `data_scopes` before accepting it, so any fixture that
 * posts a job needs records behind those scopes. Doing this per-file would be four copies of the
 * same two keys, and a helper keeps the reason visible instead of mysterious: without it a job POST
 * returns 422 `empty_scope`, which reads like a broken gate rather than a working one.
 */
import { MemoryStorage } from '@saip/shared'

export async function seededStore(
  extra: Record<string, string> = {},
  opts: { sessions?: number; feedback?: number } = {},
): Promise<MemoryStorage> {
  const storage = new MemoryStorage()
  const sessions = opts.sessions ?? 1
  const feedback = opts.feedback ?? 1
  for (let i = 1; i <= sessions; i++) {
    await storage.put(`sessions/s${i}/conversation.jsonl`, JSON.stringify({ role: 'user', content: `turn ${i}` }) + '\n')
    await storage.put(`sessions/s${i}/manifest.json`, JSON.stringify({ id: `s${i}` }))
  }
  for (let i = 1; i <= feedback; i++) {
    await storage.put(`feedback/f${i}.json`, JSON.stringify({ id: `f${i}`, session_id: 's1', message_id: 'm1', reward: 2, created_at: '2026-01-01T00:00:00Z' }))
  }
  await storage.put('feedback/_index.json', JSON.stringify({ records: {} }))
  for (const [k, v] of Object.entries(extra)) await storage.put(k, v)
  return storage
}
