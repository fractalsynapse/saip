# Changelog — @saip/training

## [Unreleased]
### Added
- `lib/axolotl-config.ts`, `lib/secret-scan.ts`, `plugins/axolotl-runner.ts`: P4–P6 of the pipeline — config materialization with documented precedence, a single-flight runner over `docker exec` with `worker_unavailable` / `training_failed` / `no_artifact`, and a scan of dataset/config/record bytes against real secret values. Installed by `createApp()`; the runner does not start itself, because awake/sleep decides when the card is theirs (#197b).

- `corrective_sft` strategy plugin (`plugins/strategy-corrective-sft.ts`), the strategy contract (`lib/strategy.ts`), and `exportDataset()` (`lib/dataset-export.ts`) with byte-determinism plus a canary that proves the comparison bites. The composition root installs the plugin, and the API's accepted strategy list is derived from what is installed (#196b).

- `POST /v1/learning/jobs` resolves the job's scopes before accepting, refusing with a structured `422` (`empty_scope` / `unknown_scope` / `library_not_found`) and writing the refusal as a `failed` record — no event, no materialized config, no silent zero-record dataset (#196).

### Changed
- **`POST /v1/learning/jobs` returns the record, not a summary**: `job_id` is now `id`, and `inherited` carries the `{ strategy, data_scopes }` booleans from `ResolvedJob` instead of re-listing the scopes. No in-repo consumer read the old body; `api-training.mdx` and the training tutorial were updated in the same commit (#197a).

### Added
- `lib/job-store.ts`: the `jobs/<id>.json` + `jobs/_index.json` store — write-ahead `create()`, append-only `history` via `transition()`, index-filtered `list()` that reads objects rather than trusting the index, `sweepInterrupted()` at boot, and `findSecretParam()` enforcing the params rule (#197a).
- `GET /v1/learning/jobs/:id` (typed `404 job_not_found`) and `GET /v1/learning/jobs` with `adapter`/`status`/`limit`/`offset`, mirroring the Data API list shape (#197a).
- Auth now mounts on `/v1/learning/jobs/*`. The previous exact-path mount did not cover the new read route, which would have served every persisted job to anonymous readers — the route-level 401 test was written before the route and fails against the old pattern (#197a, design record §2.5).

- Storage selection at the training root, fail-closed like inference, with the chosen provider named in boot output — the `jobs/` store (#197) and `r2Sync` (#198) are the consumers (#198).
- `SecretsService` now gets `defaultSecretsProvider(env)` instead of a bare `EnvSecrets`: the gateway could not read `SAIP_R2_ACCESS_KEY_ID` from the encrypted store, which the design record assumed it already could (#198).

- Service documentation and Docker Compose scaffold (#1)
