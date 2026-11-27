/**
 * `corrective_sft` — the first strategy plugin, and the one that closes the loop (#196b).
 *
 * It joins sessions to feedback on the keys the records actually carry (`session_id`,
 * `message_id`, `reward ∈ [-3, 3]`, `confidence`) and produces weighted SFT rows. The rule that
 * makes this *learning* rather than *memorizing the transcript* is the one that is easy to get
 * wrong: a message nobody rated is context. It stays in the conversation so the model sees what it
 * was asked, and it carries no weight and no label, so it is never a target. Rate one reply and the
 * surrounding turns should not become training signal for it.
 *
 * Weight is `|reward| / 3` with the sign moved into `label`, so a strong correction and a strong
 * confirmation have the same magnitude — the trainer decides how to use each, the dataset does not
 * hide the difference in a negative number a loss function would treat as "less important".
 */
import { Service } from 'cordis'
import { resolveScopes, type LearningJobRecord, type StorageProvider } from '@saip/shared'
import type { StrategyInput, StrategyRow, TrainingStrategyPlugin } from '../lib/strategy.js'

interface SessionMessage { id?: string; message_id?: string; role: string; content: string; created_at?: string }
interface FeedbackRecord {
  id: string
  session_id: string
  message_id?: string
  reward: number
  confidence?: number
  created_at: string
}

const REWARD_MAGNITUDE = 3

export class CorrectiveSftService extends Service implements TrainingStrategyPlugin {
  static readonly provide = 'correctiveSft'
  readonly name = 'corrective_sft'
  readonly consumes = ['sessions', 'feedback'] as const
  readonly format = 'axolotl_sft'

  constructor(ctx: any) {
    super(ctx, 'correctiveSft')
  }

  async build({ storage, job }: StrategyInput): Promise<StrategyRow[]> {
    const resolution = await resolveScopes(job, storage)
    if (!resolution.ok) throw new Error(`${this.name}: ${resolution.error.message}`)

    const byKind = new Map(resolution.scopes.map((s) => [s.kind, s.keys]))
    const sessionKeys = byKind.get('sessions') ?? []
    const feedbackKeys = byKind.get('feedback') ?? []

    const feedback = (await Promise.all(feedbackKeys.map((k) => readJson<FeedbackRecord>(storage, k))))
      .filter((f): f is FeedbackRecord => !!f && typeof f.reward === 'number')
    // Only feedback pointing at a session this job actually resolved. Rating a conversation in
    // another user's session must not silently import it into this dataset.
    const sessionsInView = new Set(sessionKeys.map(sessionId))
    const relevant = feedback.filter((f) => sessionsInView.has(f.session_id))

    const rows: StrategyRow[] = []
    for (const key of sessionKeys) {
      const sid = sessionId(key)
      const messages = await readConversation(storage, key)
      for (const message of messages) {
        const mid = message.id ?? message.message_id
        const rated = relevant.find((f) => f.session_id === sid && (f.message_id === undefined || f.message_id === mid))
        const created = message.created_at ?? rated?.created_at ?? '0000-00-00T00:00:00Z'
        if (!rated) {
          // Context only: no weight, no label. See the header — this is the load-bearing branch.
          rows.push({ role: message.role, content: message.content, ...(mid ? { provenance: { session_id: sid, message_id: mid } } : {}), created_at: created })
          continue
        }
        // |reward| / 3, clamped — the design record's formula, applied literally.
        //
        // `confidence` is read from the record and deliberately NOT multiplied in. Scaling loss
        // weights by a self-reported 0–1 figure would make the dataset depend on a number nothing
        // has calibrated, and the effect is invisible in the bytes: two runs differing only because
        // a user moved a slider would look like nondeterminism. It stays available to a later
        // strategy that earns it, and #196b's determinism claim is stronger for the restraint.
        const weight = Math.min(Math.abs(rated.reward), REWARD_MAGNITUDE) / REWARD_MAGNITUDE
        rows.push({
          role: message.role,
          content: message.content,
          provenance: { session_id: sid, ...(mid ? { message_id: mid } : {}) },
          created_at: created,
          weight,
          label: rated.reward > 0 ? 'correct' : 'corrected',
        })
      }
    }

    if (!rows.some((r) => r.label)) {
      // Every row being context means the join produced nothing to learn from — a dataset of pure
      // context trains the model on its own past answers. Fail the export instead.
      throw new Error(`${this.name}: resolved ${rows.length} messages but none carry feedback — nothing to correct. Refusing to export a context-only dataset.`)
    }
    return rows
  }
}

function sessionId(conversationKey: string): string {
  return conversationKey.split('/')[1] ?? conversationKey
}

async function readJson<T>(storage: StorageProvider, key: string): Promise<T | undefined> {
  const raw = await storage.get(key)
  if (!raw) return undefined
  try { return JSON.parse(raw) as T } catch { return undefined }
}

async function readConversation(storage: StorageProvider, key: string): Promise<SessionMessage[]> {
  const raw = await storage.get(key)
  if (!raw) return []
  const out: SessionMessage[] = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const parsed = JSON.parse(t) as SessionMessage
      if (parsed && typeof parsed.content === 'string' && typeof parsed.role === 'string') out.push(parsed)
    } catch { /* a malformed line is skipped, not fatal: one bad turn is not a lost corpus */ }
  }
  return out
}

/** Plain object form for registry composition, so `createApp()` can install it without a context. */
export const CORRECTIVE_SFT_PROVIDER = CorrectiveSftService

export function asPlugin(service: CorrectiveSftService): TrainingStrategyPlugin {
  return { name: service.name, consumes: [...service.consumes], format: service.format, build: (i: StrategyInput) => service.build(i) }
}

export type { LearningJobRecord }
