/**
 * Dataset export (#196b, design record §3 P3).
 *
 * Determinism here is load-bearing in two directions. Forward: a training run must be reproducible
 * from the job record alone, so the dataset's `sha256` is what #197b compares against when a job is
 * re-run, and what makes "the same corpus produced a different adapter" an answerable question
 * instead of a mystery. Backward: the export is mirrored onto the `training-data` volume, so the
 * bytes the worker reads have to be exactly the bytes storage holds.
 *
 * The canary option exists because a hash comparison that can never differ proves nothing. Passing
 * `unsortForCanary` produces the same rows in reverse order, and the suite asserts the hash changes —
 * which is the only way to know the sort is doing work rather than coincidentally agreeing.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LearningJobRecord, StorageProvider } from '@saip/shared'
import { canonicalRow, compareRows, findStrategy, type TrainingStrategyPlugin } from './strategy.js'
import { hostPath, jobRelPath } from './workspace.js'

export interface DatasetExportResult {
  /** Storage key of the JSONL body. */
  key: string
  /** SHA-256 of exactly those bytes. */
  sha256: string
  records: number
  format: string
  /** Absolute path of the volume mirror, when one was configured. */
  mirror?: string
}

export interface DatasetExportOptions {
  job: LearningJobRecord
  storage: StorageProvider
  /** The plugins this gateway actually registered — not a config list. */
  strategies: TrainingStrategyPlugin[]
  /** Directory mirroring the worker's `/app/data`, e.g. `SAIP_TRAINING_DATA_DIR`. */
  mirrorDir?: string
  /** Test-only: skip the sort so the determinism check can be shown to bite. */
  unsortForCanary?: boolean
}

export async function exportDataset(opts: DatasetExportOptions): Promise<DatasetExportResult> {
  const plugin = findStrategy(opts.strategies, opts.job.strategy)
  if (!plugin) {
    // Throwing rather than writing an empty file: an empty dataset is the failure mode this whole
    // stage exists to prevent, and a job that "succeeds" on zero rows un-learns behavior.
    throw new Error(`no strategy plugin registered for "${opts.job.strategy}" — available: ${opts.strategies.map((s) => s.name).join(', ') || 'none'}`)
  }

  const rows = await plugin.build({ storage: opts.storage, job: opts.job })
  const ordered = opts.unsortForCanary ? [...rows].reverse() : [...rows].sort(compareRows)
  const body = ordered.map(canonicalRow).join('\n') + '\n'

  const sha256 = createHash('sha256').update(body, 'utf8').digest('hex')
  // Same relative location in the bucket as on the volume — one shape, two roots.
  const rel = `${jobRelPath(opts.job.id)}/dataset`
  const key = `${rel}/${plugin.name}.jsonl`
  const manifestKey = `${rel}/manifest.json`

  // Bytes first, then the manifest naming them (§1.4 ordering): an index entry for a dataset that
  // was never written is the dangling-reference failure this project keeps having to design out.
  const manifestBody = JSON.stringify(
    { key, sha256, records: ordered.length, format: plugin.format, strategy: plugin.name, created_at: new Date().toISOString() },
    null, 2,
  )
  await opts.storage.put(key, body)
  await opts.storage.put(manifestKey, manifestBody)

  let mirror: string | undefined
  if (opts.mirrorDir) {
    // The worker reads /app/data/jobs/<id>/ from the shared volume. Writing the same bytes there is
    // what the comment in training/docker-compose.yml has promised since it was written; nothing
    // implemented it until now, and only when an operator names the directory — inventing a default
    // path would be a claim with no artifact behind it.
    const dir = hostPath(opts.mirrorDir, opts.job.id, 'dataset')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${plugin.name}.jsonl`)
    writeFileSync(path, body, 'utf8')
    // Written from the same value that went to storage, not read back: a mirror is only evidence of
    // a successful export if it cannot diverge from the bytes that were hashed.
    writeFileSync(join(dir, 'manifest.json'), manifestBody, 'utf8')
    mirror = path
  }

  return { key, sha256, records: ordered.length, format: plugin.format, mirror }
}
