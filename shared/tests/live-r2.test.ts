/**
 * Live R2 tier (#198, design record §1.5) — the opt-in run against a real bucket.
 *
 * The in-process fake is written alongside the client, so it can be generous in ways R2 is not:
 * `list-type=2` paging, the exact 404 shape of a missing key, the consistency of a read immediately
 * after a write. §1.5 asks for the same suite against the real endpoint, and this is it.
 *
 * Why the variables are NOT `SAIP_R2_*`. Vitest's setup (`tools/vitest/env-isolation.ts`) deletes
 * every `SAIP_`-prefixed variable so no suite can depend on the developer's shell — the rule #138
 * established, and the reason `pnpm -r test` is hermetic. A credentials-bearing tier needs those
 * values by definition, so it reads `LIVE_R2_*` instead: the isolation rule stays intact for every
 * other test, and opting in is an explicit, differently-named act. The bucket, endpoint and access
 * key id are configuration; the secret is only ever read from the environment, never written to a
 * file, and never printed — the skip reason below lists names, not values.
 *
 * In CI this file skips, and skipped is reported as skipped rather than as a pass.
 */
import { describe } from 'vitest'
import { R2StorageProvider } from '../src/r2-client.js'
import { NamespacedStorage } from '../src/testing/namespaced.js'
import { contractSuite } from './helpers/storage-contract.js'

const NAMES = { bucket: 'LIVE_R2_BUCKET', endpoint: 'LIVE_R2_ENDPOINT', access: 'LIVE_R2_ACCESS_KEY_ID', secret: 'LIVE_R2_SECRET_ACCESS_KEY' } as const

const values = {
  bucket: process.env[NAMES.bucket]?.trim() ?? '',
  endpoint: process.env[NAMES.endpoint]?.trim() ?? '',
  access: process.env[NAMES.access]?.trim() ?? '',
  secret: process.env[NAMES.secret]?.trim() ?? '',
}

const absent = Object.entries(values).filter(([, v]) => !v).map(([k]) => NAMES[k as keyof typeof NAMES])

// Namespaced so a run against a bucket that also holds a real corpus cannot collide with it, and so
// teardown can enumerate exactly what this run created.
const prefix = `saip-acceptance/${new Date().toISOString().replace(/[:.]/g, '-')}`

const base = (): R2StorageProvider => new R2StorageProvider({
  endpoint: values.endpoint, bucket: values.bucket, accessKeyId: values.access, secretAccessKey: values.secret,
})

const enabled = absent.length === 0
const reason = `live R2 tier skipped: set ${absent.join(', ')} to run it (#198)`

describe('live R2 tier (#198)', () => {
  // `runIf` rather than a hand-rolled skip: the suite is registered under the same name in both
  // states, and the reporter shows `skipped` for the whole group with the reason printed once below.
  // A credential tier that quietly "passed" without credentials would be worse than one that says
  // it did not run.
  describe.runIf(enabled)('StorageProvider contract against the real endpoint', () => {
    contractSuite('live R2', async () => {
      const scoped = new NamespacedStorage(base(), prefix)
      return {
        provider: scoped,
        close: async () => {
          const removed = await new NamespacedStorage(base(), prefix).clear()
          process.stderr.write(`live-r2: removed ${removed} test object(s) under ${prefix}/\n`)
        },
      }
    })
  })
})

if (!enabled) {
  process.stderr.write(`[live-r2] SKIPPED — ${reason}\n`)
}
