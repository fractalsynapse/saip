/**
 * Secret scan over the artifacts a job leaves behind (#197b, Review Focus #7).
 *
 * The rule it enforces is the project's: committed and stored bytes reference secrets by NAME, never
 * by value. The API already refuses `params` whose *name* looks like a credential, and Axolotl config
 * generation refuses a value that looks like a token — but those are shape heuristics. This is the
 * comparison against reality: take the values actually configured in this deployment and check that
 * none of them appear in the dataset, the generated config, or the job record.
 *
 * It runs as a test assertion rather than a runtime scrubber on purpose. Scrubbing on write would
 * "fix" a leak by silently altering training data, which is worse than failing the job: a dataset
 * whose bytes differ from what the model was supposed to learn from is undiagnosable later.
 */

export type ScanArtifacts = Record<string, string | undefined>

/**
 * @returns the names of the artifacts that contain at least one secret value, empty when clean.
 * Values shorter than 8 characters are ignored: a common short string would report a false positive
 * on every corpus that happens to contain it, and a "secret" that short is not worth scanning for.
 */
export function scanForSecrets(artifacts: ScanArtifacts, values: Array<string | undefined>): string[] {
  const secrets = values.filter((v): v is string => typeof v === 'string' && v.length >= 8)
  const dirty: string[] = []
  for (const [name, body] of Object.entries(artifacts)) {
    if (!body) continue
    if (secrets.some((s) => body.includes(s))) dirty.push(name)
  }
  return dirty
}

/** The names a deployment should scan, from the secret catalog's credential entries. */
export const SCANNED_SECRET_NAMES = ['SAIP_R2_SECRET_ACCESS_KEY', 'SAIP_HF_TOKEN', 'SAIP_R2_ACCESS_KEY_ID'] as const
