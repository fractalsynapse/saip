/**
 * The training-strategy plugin contract (#196b, training/README.md).
 *
 * The README has described a plugin registry since the gateway existed, and nothing implemented it:
 * `registeredStrategies` was a list of names passed into `POST /v1/learning/jobs`, so a strategy
 * could be accepted at the API with no code behind it, and the job would fail later — after the
 * dataset, after the config, possibly after a GPU was rented for it.
 *
 * A plugin therefore declares three things, all of which are used: the canonical name the registry
 * matches, the scopes it reads (so a caller can see whether a job's `data_scopes` can satisfy it),
 * and the dataset format it emits (recorded in the job manifest, because "which file did I just
 * train on" has to survive the process).
 */
import type { LearningJobRecord, ScopeKind, StorageProvider } from '@saip/shared'

/** One row of an Axolotl-ready dataset. Absent `weight` means context, not signal. */
export interface StrategyRow {
  role: string
  content: string
  /** |reward| / 3 for a rated message; undefined for context-only turns, which are never targets. */
  weight?: number
  /** `correct` for a positive reward, `corrected` for a negative one. Never present on context. */
  label?: 'correct' | 'corrected'
  /** Where the row came from, so a bad dataset can be traced to a session instead of guessed at. */
  provenance?: { session_id: string; message_id?: string }
  /** Sort key. Emitted, because a dataset whose order cannot be re-derived is not reproducible. */
  created_at: string
}

export interface StrategyInput {
  storage: StorageProvider
  job: LearningJobRecord
}

export interface TrainingStrategyPlugin {
  /** Canonical snake_case, matched against the adapter's `training.strategy`. */
  readonly name: string
  /** Which resolved scopes this strategy reads. A scope set that cannot satisfy it fails the job. */
  readonly consumes: readonly ScopeKind[]
  /** Dataset format recorded in the job manifest. */
  readonly format: string
  build(input: StrategyInput): Promise<StrategyRow[]>
}

/** Fixed field order: serialization that follows object insertion order is not reproducible. */
export function canonicalRow(row: StrategyRow): string {
  const out: Record<string, unknown> = { created_at: row.created_at }
  if (row.provenance) out.provenance = { session_id: row.provenance.session_id, ...(row.provenance.message_id ? { message_id: row.provenance.message_id } : {}) }
  out.role = row.role
  out.content = row.content
  if (row.weight !== undefined) out.weight = Number(row.weight.toFixed(6))
  if (row.label) out.label = row.label
  return JSON.stringify(out)
}

/** Sort by (created_at, session, message): stable across runs regardless of storage listing order. */
export function compareRows(a: StrategyRow, b: StrategyRow): number {
  const ka = `${a.created_at}|${a.provenance?.session_id ?? ''}|${a.provenance?.message_id ?? ''}`
  const kb = `${b.created_at}|${b.provenance?.session_id ?? ''}|${b.provenance?.message_id ?? ''}`
  return ka < kb ? -1 : ka > kb ? 1 : 0
}

/**
 * What the gateway actually has installed. The API validates against this, not against a config
 * list, so "the strategy resolved" and "a dataset can be produced" stop being different claims.
 */
export function findStrategy(registry: TrainingStrategyPlugin[], name: string): TrainingStrategyPlugin | undefined {
  return registry.find((s) => s.name === name)
}
