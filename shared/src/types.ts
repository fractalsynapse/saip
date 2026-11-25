/**
 * SAIP shared type definitions
 */

/** Adapter scope — visibility/ownership boundary controlling reuse rules */
export type AdapterScope = 'global' | 'domain' | 'project' | 'user'

/** Training linkage declared by a leaf adapter in the registry */
export interface TrainingLinkage {
  /** Registered training strategy plugin name (e.g. 'knowledge_embedding') */
  strategy: string
  /** Data types from the Data API registry that feed this adapter's training */
  data_scopes: string[]
  /** Strategy-specific defaults for jobs targeting this adapter */
  params?: Record<string, unknown>
}

/** One weighted component inside a composite adapter specification */
export interface CompositeComponent {
  /** Component adapter name (composites may not reference themselves; no cycles) */
  adapter: string
  /** Per-component composition weight wᵢ */
  weight: number
  /** Optional version pin (e.g. '@000012'); default '@latest' resolved at compile time */
  version?: string
}

/** Composition spec for derived adapters merged into a single vLLM artifact */
export interface CompositeSpec {
  /** Overall λ applied to the merged delta; evaluated hyperparameter */
  gain: number
  /** PEFT merge algorithm */
  merge: 'weighted_linear' | 'ties' | 'dare'
  components: CompositeComponent[]
}

/** Adapter definition entry in the saip.yaml registry */
export interface AdapterDefinition {
  name: string
  scope: AdapterScope
  project?: string
  user?: string
  description?: string
  /** False for purely-derived (composite) adapters without their own training runs */
  trainable: boolean
  /** Base model this adapter targets; must match all components when compiling */
  base?: string
  /** Present on leaf adapters: how this adapter learns */
  training?: TrainingLinkage
  /** Present on composite adapters: what it is built from */
  composite?: CompositeSpec
}

/** Composition provenance recorded in a compiled adapter's manifest */
export interface CompositionRecord {
  gain: number
  merge: string
  components: Array<{ id: string; version: number; weight: number }>
}

/** Adapter manifest stored in R2 at adapters/<id>/manifest.json */
export interface AdapterManifest {
  id: string
  base_model: string
  base_revision?: string
  rank: number
  alpha: number
  version: number
  parent?: string
  training_run?: string
  training_method?: 'knowledge_embedding' | 'corrective_sft' | 'weighted_kto'
  /** Registry linkage that produced this version (leaf adapters) */
  strategy?: string
  data_scopes?: string[]
  /** Present when this artifact was compiled from components (composite adapters) */
  composition?: CompositionRecord
  metrics?: Record<string, number>
  created_at: string
  updated_at: string
}

/** Global adapter index stored in R2 at adapters/_index.json */
export interface AdapterIndex {
  adapters: Record<string, AdapterManifest>
  aliases: Record<string, string>  // e.g., "general@latest" → "general@000042"
  updated_at: string
}

export type LearningJobStatus = 'queued' | 'running' | 'succeeded' | 'failed'

/** One append-only status change. `detail` carries the runner's short reason, never a log blob. */
export interface JobHistoryEntry {
  at: string
  status: string
  detail?: string
}

/**
 * Persisted learning-job record, stored at `jobs/<id>.json` (design record §2.2).
 *
 * Every field has a named consumer: `dataset.sha256` is the determinism proof #196 is judged by,
 * `artifact` is what `r2Sync` uploads, `version` is assigned only at promotion so a succeeded job
 * that was never promoted says so by leaving it absent, and `history` is the audit trail a
 * training run needs when the process that ran it is gone.
 *
 * There is deliberately no `progress` field: nothing produces a meaningful fraction, and a number
 * that is always 0 or always guessed is worse than no number.
 */
export interface LearningJobRecord {
  id: string
  /** Authenticated principal, from the existing x-saip-caller/principal path. */
  caller?: string
  adapter: string
  strategy: string
  data_scopes: string[]
  data_ids?: string[]
  params: Record<string, unknown>
  inherited: { strategy: boolean; data_scopes: boolean }
  status: LearningJobStatus
  error?: { code: string; message: string }
  dataset?: { key: string; sha256: string; records: number; format: string }
  config?: { key: string; sha256: string }
  artifact?: { prefix: string; base_model: string }
  /** Assigned at promotion ONLY; links back via the adapters index. */
  version?: number
  history: JobHistoryEntry[]
  created_at: string
  updated_at: string
}

/** What `jobs/_index.json` holds per job — enough to filter a list without reading every record. */
export interface LearningJobSummary {
  status: LearningJobStatus
  adapter: string
  strategy: string
  created_at: string
  updated_at: string
}

/** Index of job summaries. Single-writer: only the training gateway mutates `jobs/`. */
export interface LearningJobIndex {
  jobs: Record<string, LearningJobSummary>
  updated_at: string
}

/** Knowledge manifest stored in R2 at knowledge/<id>/manifest.json */
export interface KnowledgeManifest {
  id: string
  source: string
  source_type: 'document' | 'repository' | 'dataset'
  license?: string
  hash: string
  size_bytes: number
  created_at: string
  updated_at: string
  tags?: string[]
}

/** Session manifest stored in R2 at sessions/<id>/manifest.json */
export interface SessionManifest {
  id: string
  caller: string
  adapter_id: string
  started_at: string
  completed_at?: string
  message_count: number
  artifact_count: number
}

/** Feedback record stored in R2 at feedback/<id>.json */
export interface FeedbackRecord {
  id: string
  session_id: string
  message_id?: string
  reward: number
  confidence?: number
  dimensions?: Record<string, number>
  feedback_text?: string
  created_at: string
}

/** User → adapter mapping entry */
export interface UserEntry {
  id: string
  adapters: {
    inference: string
    training: string
  }
}

/** Platform mode */
export type PlatformMode = 'awake' | 'asleep' | 'down'
