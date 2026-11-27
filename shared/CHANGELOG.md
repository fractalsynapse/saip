# Changelog — @saip/shared

## [Unreleased]
### Added
- `testing/namespaced.ts` (subpath `./testing`): `NamespacedStorage`, a prefix-scoped view over any provider — reads, deletes and listings translate in both directions, plus `clear()` for teardown. Written because the first draft of the live tier wrapped only `put()`, so every read addressed an un-namespaced key and the suite could not pass when enabled (#198).
- `tests/live-r2.test.ts`: the design record §1.5 live tier. Runs the same contract suite as the fakes against a real bucket, opt-in via `LIVE_R2_*`, and reports **skipped with the missing variable names** rather than passing silently. Those variables are deliberately not `SAIP_*` prefixed: `tools/vitest/env-isolation.ts` deletes every `SAIP_` variable so suites stay hermetic (#138), which a credential tier must opt out of explicitly (#198).

- `AdapterIndex` now describes the promoted-lineage shape (`{ adapters: { name: { latest, versions } } }`) with `AdapterLineage` and `AdapterVersionEntry`; the `aliases` field is gone because `@latest` is derived (#198b).

- `scopes.ts`: `resolveScopes()` turning `data_scopes` into concrete member keys over the storage seam, with `selectKnowledgeObject()` as the single object-preference rule both gateways use (#196).
- `LibraryDefinition`, `LibraryFilter`, `LibraryManifest`, `LibraryIndex` types for the `libraries:` config section (#196).

- `LearningJobRecord`, `LearningJobStatus`, `LearningJobSummary` and `LearningJobIndex` in `types.ts` — the persisted job shape from design record §2.2, so training, the runner and `r2Sync` read and write one shape rather than three (#197a).

- `storage.ts`: `StorageProvider`, `MemoryStorage`, `storageProviderFor()` and the selection policy (design record §1.3) — previously declared inside `@saip/inference`, where training could not use it without duplicating it (#198).
- `r2-client.ts`: R2/S3 client with SigV4 signing via `node:crypto`, `list()` paging past the 1,000-key cap, and typed 404 → `undefined`. No new runtime dependency (#198).
- `testing/fake-s3.ts` (subpath `./testing`): in-process S3 fake with an **independent** signature verifier, plus truncation/shuffle/fault hooks, so the contract suite can prove its own detectors fail. Shared by both gateways and the loop e2e rather than copied (#198).

- `vitest.config.ts` loads the shared `tools/vitest/env-isolation.ts`, so this package's suite cannot pass by depending on an empty CI environment (#138)
### Added
- `SshConfig.port` (1–65535, optional) plus `sshConnectionArgs()` / `sshDestination()`, the single builders every SAIP→host connection uses (#98). Validation gained `invalid_ssh_port`, `unknown_host_key` and `unknown_ssh_key`, so a `hosts.yaml` key with no field behind it is an error instead of a silent no-op
- `hosts.example.yaml` is now asserted to validate clean, which keeps the allowed-key lists in `validateHostRegistry` honest against the file users copy
- *(nothing changed in `shared` for #156, recorded deliberately.)* The issue said the profile report's prose was assembled in `shared/src/profiles.ts`. It was not — `shared` returned data, and the string was built in `cli/src/commands/profiles.ts`. Checked by reading the file rather than editing the place the ticket named, because "fix what the issue says" and "fix what the code does" are different changes
- `SecretAccess.write()` and `storedNames()` (#169): writes have a route through the gateway, are recorded in the access audit like reads, and share its cached key — a store that exists but cannot be unlocked refuses the write instead of half-writing, and an absent store is not an error because creating it is the one legitimate moment the passphrase belongs. Forwarded on the `SecretAccessService` plugin alongside `readStored()`
- Creating a secret store is now its own unlock: `SecretStore.persist()` seeds `kekCache` from the file it just wrote (#169). Before, the KEK derived during provisioning was discarded, so the next read re-derived it — `saip config init` asked for the passphrase twice in one command, and anything the creating instance was asked afterwards (`storedNames()`, `activeWrap()`) cost a second unlock. The seeded signature is taken from the object that reached disk, so the cache cannot claim validity against a wrap set the file does not contain
- Shared type definitions (AdapterManifest, SessionManifest, FeedbackRecord, etc.) (#1)
### Fixed
- **the declared-exports rule from #187 was honoured, not repeated**: `./storage`, `./r2-client` and `./testing` were added to `package.json` in the same commit as the files they point at (#198).

- **five declared subpath exports pointed at files that never existed** (#187). `package.json` listed `./config-schema`, `./r2-client`, `./hf-client`, `./adapter-manifest` and `./user-manifest` — no source file, no built output, nothing in `dist`. `pnpm pack`-style consumers would have received a manifest that lies, and nothing failed: the docs build checks that pages render and links resolve, and a manifest entry has no link to check. `tests/package-exports.test.ts` now reads the manifest the way Node does and requires every target to exist in the built output; the manifest itself was corrected to the eleven modules that actually ship (`config-source`, `profiles`, `secret-access`, `secret-catalog`, `secrets-store` added; the five phantoms removed)
- **three runtime dependencies declared with zero imports anywhere** (#187). `zod`, `@aws-sdk/client-s3` and `@huggingface/hub` were dependencies of `@saip/shared` while no `.ts`/`.tsx` file in the workspace imported any of them (0 hits, and 0 references in `shared/dist`). A declared dependency is an install cost and a supply-chain surface; the issues that would need them (#63, the R2 client) must earn them back in the change that uses them. 322 lines left the lockfile with them
- **a latent home-level resolution masked the first one.** `zod` resolves on this machine from `~/node_modules/zod` — outside this workspace entirely — so an example importing it builds green here and red in CI. Both pages that show `import { z } from 'zod'` (`explanation/cordis-plugin-model`, `reference/cordis-plugins`) now state that zod is not a workspace dependency and that the validator must be declared by the importing package
