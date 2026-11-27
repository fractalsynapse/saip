/**
 * Axolotl config materialization (#197b, design record §3 P4).
 *
 * The merge order is the contract, and it is deliberately boring:
 *
 *   active service profile `training:`  →  registry `adapter:` defaults  →  the leaf's `base`
 *   checkpoint  →  the job's own `params`
 *
 * so a per-job experiment can move one knob without editing a file, and the profile tier — which is
 * the measured hardware contract from #53 — remains the floor. Paths point at the **volume mirror**,
 * not at storage keys, because the process that reads this file is the container on the other side of
 * that mount.
 *
 * The Hugging Face token is referenced **by name** and injected into the worker's environment at
 * execution time. It never appears in these bytes: the config is stored under `jobs/` in the same
 * bucket as the dataset, and a secret written here would be replicated to cloud storage by design
 * rather than by accident.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stringify } from 'yaml'
import type { AdapterDefinition, LearningJobRecord, StorageProvider } from '@saip/shared'
import { containerPath, hostPath, jobRelPath } from './workspace.js'

export interface AxolotlConfigInput {
  job: LearningJobRecord
  /** The resolved leaf adapter; `base` is what Axolotl trains against. */
  adapter: Pick<AdapterDefinition, 'name' | 'base'>
  /** The relevant halves of the loaded saip.yaml (profile-resolved training block + adapter block). */
  config: {
    training?: Record<string, unknown>
    adapter?: { default_rank?: number; default_alpha?: number; target_modules?: string[] }
  }
  /** Directory the worker sees as /app/data. Defaults to the mount in training/docker-compose.yml. */
  dataDir?: string
  /** Name of the env var holding the HF token. Recorded as a name; the value is never read here. */
  hfTokenName?: string
}

export class AxolotlConfigError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'AxolotlConfigError'
  }
}

/** Relative path of the dataset inside the job workspace — the same layout exportDataset writes. */
export function datasetPathInWorkspace(jobId: string, strategy: string): string {
  return `${jobRelPath(jobId)}/dataset/${strategy}.jsonl`
}

export function buildAxolotlConfig(input: AxolotlConfigInput): string {
  const { job, adapter, config } = input
  // Host directory that backs the worker's /app/data. Default matches the compose mount.
  const dataDir = input.dataDir ?? '/app/data'

  if (!adapter.base) {
    // Not falling back to `model.base`: that is the *serving* checkpoint, which on this platform is a
    // quantized build, and silently training a bf16 LoRA against "whatever the engine loads" is the
    // kind of assumption that produces an adapter nobody can load.
    throw new AxolotlConfigError(
      `no_base_model: adapter "${adapter.name}" declares no base checkpoint, so a training config cannot be materialized. Set adapters[].base to the bf16 checkpoint Axolotl should train against.`,
      'no_base_model',
    )
  }

  const training = config.training ?? {}
  const defaults = config.adapter ?? {}

  // Built as an ordered object, then serialized: field order is part of byte-determinism, and YAML
  // emitted from a spread of unknowns would make two runs of the same job differ.
  const doc: Record<string, unknown> = {
    base_model: adapter.base,
    adapter: 'lora',
    dataset: `${dataDir.replace(/\/$/, '')}/${datasetPathInWorkspace(job.id, job.strategy)}`,
    output_dir: containerPath(job.id, 'output'),
    ...(training.precision ? { bf16: training.precision === 'bf16', fp16: training.precision === 'fp16' } : {}),
    ...(training.sequence_len !== undefined ? { sequence_len: training.sequence_len } : {}),
    ...(training.gradient_checkpointing !== undefined ? { gradient_checkpointing: training.gradient_checkpointing } : {}),
    ...(training.optimizer ? { optimizer: training.optimizer } : {}),
    ...(defaults.default_rank !== undefined ? { r: defaults.default_rank } : {}),
    ...(defaults.default_alpha !== undefined ? { lora_alpha: defaults.default_alpha } : {}),
    ...(defaults.target_modules ? { target_modules: defaults.target_modules } : {}),
    ...(input.hfTokenName ? { hf_token_env: input.hfTokenName } : {}),
  }

  // Job params last: they are the operator's explicit override for one experiment.
  for (const [k, v] of Object.entries(job.params ?? {})) doc[k] = v

  // Guard the one case the redaction rule at the API could not see: a value-shaped param that
  // survived because its *name* was innocuous would still be written into a cloud object.
  const serialized = stringify(doc, { lineWidth: 0 })
  if (/hf_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}/.test(serialized)) {
    throw new AxolotlConfigError('config_failed: the materialized config appears to contain a credential value', 'config_failed')
  }
  return serialized
}

export interface MaterializeResult { key: string; sha256: string; mirror?: string }

export async function materializeConfig(opts: AxolotlConfigInput & {
  storage: StorageProvider
  mirrorDir?: string
}): Promise<MaterializeResult> {
  const body = buildAxolotlConfig(opts)
  const key = `${jobRelPath(opts.job.id)}/axolotl.yaml`
  const sha256 = createHash('sha256').update(body, 'utf8').digest('hex')
  await opts.storage.put(key, body)

  let mirror: string | undefined
  if (opts.mirrorDir) {
    const dir = hostPath(opts.mirrorDir, opts.job.id, '').replace(/\/$/, '')
    mkdirSync(dir, { recursive: true })
    mirror = join(dir, 'axolotl.yaml')
    writeFileSync(mirror, body, 'utf8')
  }
  return { key, sha256, mirror }
}
