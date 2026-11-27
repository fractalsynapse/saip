/**
 * One definition of the job workspace, because two processes read it (#197b).
 *
 * The gateway writes to a host directory; the worker is handed `/app/data/...` inside the container,
 * and the runner passes `docker exec` a path in *that* namespace. When each site composed its own
 * string, the loop e2e caught the gateway mirroring to `<dataDir>/<id>/axolotl.yaml` while telling
 * the worker to read `/app/data/jobs/<id>/axolotl.yaml` — a training run that could never find its
 * own config, and it would have surfaced as `training_failed` on a rented GPU hours later.
 *
 * `hostPath()` and `containerPath()` are therefore the same path, by construction, differing only in
 * root.
 */
import { join } from 'node:path'

/** Where the `training-data` volume is mounted inside `axolotl-worker`. */
export const CONTAINER_DATA_ROOT = '/app/data'

/** Relative location of a job's workspace inside the volume. */
export function jobRelPath(jobId: string): string {
  return join('jobs', jobId)
}

/** The path handed to `docker exec … axolotl train <path>`. */
export function containerPath(jobId: string, file: string): string {
  return `${CONTAINER_DATA_ROOT}/${jobRelPath(jobId)}/${file}`.replace(/\\/g, '/')
}

/** The same file as seen from the host directory mounted as the volume. */
export function hostPath(dataDir: string, jobId: string, file: string): string {
  return join(dataDir, jobRelPath(jobId), file)
}
