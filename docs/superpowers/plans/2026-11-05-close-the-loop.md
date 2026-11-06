# Close the Loop — Design Record: Real Storage, Persisted Jobs, and the Training Pipeline

> **For agentic workers:** This is a contract document, not a task list. The implementable tasks already have
> issues — #196–#200 — each with its own acceptance criteria. What this record binds them to is **one shared
> shape** for three interfaces the loop cannot close without: the real `StorageProvider`, the persisted
> learning-job record, and the dataset → Axolotl → promotion pipeline. Where a task's issue body and this
> document disagree, this document wins and the issue gets edited — never the reverse in silence.
> Verified against `staging` @ `0e6a5b7` (2026-11-05); every `file:line` citation was read, not recalled.

**Goal:** Make the learning loop execute, not just enqueue. A user chats, corrects the model via feedback, a
`corrective_sft` job trains on their own sessions + feedback, the resulting adapter is promoted to storage,
and the inference gateway serves it — the closure criterion is Epic [#64](https://github.com/fractalsynapse/saip/issues/64)
B4, measured on the `full-loop-12gb` profile tier (#53).

**Architecture:** Three additions, each behind an existing seam, none touching feature code that already works:
(1) an **R2-backed `StorageProvider`** in `@saip/shared` with fail-closed selection — the corpus stops being a
process-lifetime Map; (2) a **persisted learning-job record** under `jobs/` following the established
`<prefix>/<id>.json + <prefix>/_index.json` pattern — the lifecycle becomes queryable instead of ephemeral;
(3) a **nine-stage pipeline** — scope resolution → strategy plugin → dataset export → config materialization →
worker execution → artifact validation → promotion → serve resolution → loop re-entry — where every stage is a
producer/consumer pair communicating through storage keys, never in-process memory.

**Tech Stack:** TypeScript ESNext, Node ≥ 22, Cordis 4, Hono 4, vitest 3, Docker Compose v2, S3-compatible
REST (Cloudflare R2) with SigV4 via `node:crypto` — **no new runtime dependency**. Training execution reuses
the existing `axolotl-worker` service (`training/docker-compose.yml:21-42`, image `winglian/axolotl:main-latest`).

**Spec / prior art:**
- Epics: #63 (A3/A3b — this doc's §1), #64 (B3/B4 — §2–§3). Tasks: #196 (export), #197 (runner/jobs), #198 (R2), #199–#200 (knowledge path, off the critical loop).
- Contracts built on: `training/src/lib/job-linkage.ts` (resolved-job shape this doc persists), `inference/src/plugins/data-documents.ts`/`data-sessions.ts`/`data-feedback.ts` (key layout precedent), `inference/src/lib/adapter-compiler.ts` + `serve-resolver.ts` (promotion consumers), `training/README.md` (pipeline design), `explanation/learning-loop.mdx` (phase semantics).
- House-style precedents: `docs/superpowers/plans/2026-10-18-*.md`, `docs/spike-154-ink-input-engine.md`.

## Global Constraints (inherited, non-negotiable)

- Every new capability is a Cordis plugin or an injectable shared service — no core edits.
- Documentation-first per PR; failing test at the user-observable level before implementation.
- Composition-root tier: each new seam gets at least one test of the **default construction path**, no fakes injected.
- CI green with no GPU, no network sidecar, no cloud credentials; credential/GPU tests are opt-in and tagged.
- No secret **values** in committed files, in job records, in datasets, or in generated Axolotl configs — names only, resolved via `SecretsProvider`.
- Conventional commits `(#issue)`; staging PRs say `Part of #issue`; changelog entry per PR; branch deleted after merge; HTTPS remote.

---

## 1. `StorageProvider`, for real — R2 (#198)

### 1.1 The contract moves to `@saip/shared`

The interface exists today only inside the inference gateway (`inference/src/lib/backends.ts:12-17`). Training
needs the *same* contract; two independently-declared interfaces drift — which is exactly the bug class #187
just cleaned out of `shared/package.json`. So:

```ts
// shared/src/storage.ts — the four operations move VERBATIM (list stays lexicographically sorted)
export interface StorageProvider {
  put(key: string, body: string | Uint8Array): Promise<void>
  get(key: string): Promise<string | undefined>
  list(prefix: string): Promise<string[]>
  delete(key: string): Promise<boolean>
}
export interface StorageSelectionConfig { /* storage.r2.* from saip.yaml + SAIP_STORAGE + env */ }
export function storageProviderFor(cfg, secrets, env?): Promise<StorageProvider>  // fail-closed factory
```

`inference/src/lib/backends.ts` re-exports the type (`export type { StorageProvider } from '@saip/shared/storage'`)
so no existing import site changes; `MemoryStorage` moves to shared beside the contract. New subpath export
`./storage` is added to `shared/package.json` **only when the file exists** — the #187 manifest rule.

### 1.2 R2 implementation — S3 REST + SigV4, no SDK

Cloudflare R2 speaks the S3 API. `R2StorageProvider` implements the four operations against
`${SAIP_R2_ENDPOINT}/bucket/key` with AWS Signature v4 computed via `node:crypto`
(`createHmac('sha256')` chain; `x-amz-content-sha256` is required by SigV4-for-S3). Decision rationale:
an SDK (`@aws-sdk/client-s3`) would add the repo's first heavy runtime dependency for four functions; the
signer is ~80 lines and fully coverable by a contract fake. Risk: signature bugs. Mitigation is 1.5 — the
fake asserts the canonical request and a deliberately-corrupted signature **must** be rejected (a detector
that cannot fail is not a detector).

`list(prefix)` pages: `GET /?list-type=2&prefix=…&continuation-token=…`, 1000 keys per page (R2/S3 default cap —
the current `MemoryStorage.list` is correct only because the Map is small), merge pages, sort before returning.

### 1.3 Selection is fail-closed, never silent

`saip.yaml:90-99` already declares `bucket: "${SAIP_R2_BUCKET:-}"` with a comment promising a provider that
"refuses to initialise on an empty value and names the variable." Nothing implements that promise today — a
docs-claim with no artifact behind it (#179's class). This section makes it true. The selection table is the
entire policy:

| `SAIP_STORAGE` | `storage.r2.bucket` | Result |
|---|---|---|
| unset | non-empty | `R2StorageProvider` (credentials by name: `SAIP_R2_ACCESS_KEY_ID`, `SAIP_R2_SECRET_ACCESS_KEY`) |
| unset | empty/unset | **startup error** naming `SAIP_R2_BUCKET` — never a fallback |
| `memory` | any | `MemoryStorage` + one loud startup log line (`storage: EXPLICIT MEMORY — data dies at restart`) |

The silent `opts.storage ?? new MemoryStorage()` default at `inference/src/index.ts:104` is deleted; both
composition roots resolve through `storageProviderFor()`. Tests keep the injectable `storage` opt — that is the
seam — but the **default path reads config + env**, per the composition-root rule.

### 1.4 Key layout, retention, write ordering

| Prefix | Writer (single-writer invariant) | Contents | Status |
|---|---|---|---|
| `knowledge/<id>/` | inference | documents | exists (`data-documents.ts:97-100`) |
| `sessions/<id>/` | inference | `conversation.jsonl`, `manifest.json` | exists (`data-sessions.ts:48-49`) |
| `feedback/` | inference | `<id>.json` records | exists (`data-feedback.ts:51`) |
| `jobs/<id>/` | **training** | job record, dataset, axolotl config | new (§2–§3) |
| `adapters/<name>/v<N>/` | **training** | trained adapter artifacts | new (§3 P7) |

Retention upgrade (pairs with #199): `knowledge/<id>/` splits into `source<ext>` (original bytes) and
`processed.md` (intermediate). Today `content<ext>` stores the *processed* text and the raw upload is discarded
(`data-documents.ts:97` puts `processed.intermediate`). New index entries carry both keys; readers fall back to
`content<ext>` for pre-existing entries — additive, no re-ingestion migration.

Write order is the commit point: **bytes → manifest → index**. Deletes reverse it (**index first**). A crash
between a write and its index update leaves an orphan object, never a dangling index entry. Full
list-authoritative reads, index rebuild, and concurrent-writer safety remain Epic #63 A4 — deliberately out of
scope; the single-writer-per-prefix invariant above is what makes the MVP safe.

### 1.5 Test tiers

One contract suite (`shared/tests/storage-contract.test.ts`) run against three implementations: `MemoryStorage`;
an in-process **FakeS3** (`node:http`, asserts SigV4 canonical form, paginates at >1,000 seeded keys, returns
typed 404 → `undefined`); and live R2 behind an opt-in tag. The pagination test must fail if the provider
silently drops a truncated page — prove it with a 2,500-key fixture and a canary that truncates page 2.

---

## 2. The persisted learning-job record (#197)

### 2.1 Where it lives

`jobs/<id>.json` plus a `jobs/_index.json` map — the same pattern documents, sessions, and feedback already use.
No database is introduced; the job store is a `StorageProvider` consumer, so it inherits §1's durability and
test tiers for free. Only the training gateway writes here.

### 2.2 Record shape

```ts
export interface LearningJobRecord {
  id: string                                  // see 2.3 — not today's counter-based id
  caller?: string                             // authenticated principal, from the existing x-saip-caller/principal path
  adapter: string                             // ↓ five fields copied verbatim from ResolvedJob
  strategy: string                            //   (training/src/lib/job-linkage.ts:19-27) — the API response
  data_scopes: string[]                       //   already returns these; persistence must not invent a second shape
  data_ids?: string[]
  params: Record<string, unknown>
  inherited: { strategy: boolean; data_scopes: boolean }
  status: 'queued' | 'running' | 'succeeded' | 'failed'
  error?: { code: string; message: string }   // structured, like resolveJobLinkage's error union
  dataset?: { key: string; sha256: string; records: number; format: string }   // P3 output; sha256 is the determinism proof
  config?: { key: string; sha256: string }    // P4 output (axolotl.yaml)
  artifact?: { prefix: string; base_model: string }                            // P6 output (local output dir)
  version?: number                            // P7 — assigned at promotion ONLY; links back via adapters index
  history: Array<{ at: string; status: string; detail?: string }>              // append-only transitions
  created_at: string
  updated_at: string
}
```

Every field has a named consumer; nothing decorative. `params` is rejected **at the API** (422) when any key
matches `/token|secret|key|passw/i` — the job record is written to cloud storage, so a wizard-passed secret must
not ride in as "training parameters." Same redaction stance `saip deploy` already takes.

### 2.3 Id derivation is fixed while we're here

`learning-api.ts:33-34` mints `train-<date>-NNN` from a **process-local counter** that resets on restart — two
boot runs mint the same id. Jobs adopt `train-<YYYYMMDD>-<base36-ms>-<base36-rand4>`. The identical flaw exists
on `doc-`/`fb-`/`sess-` ids (`data-documents.ts:93`, `data-feedback.ts:49`); fixing storage does not fix those
counters — recorded under Deferred, not silently.

### 2.4 Lifecycle rules

- **Write-ahead.** `POST /v1/learning/jobs` persists `queued` **before** emitting `learning/job-queued`; the event is a notification, the record is the truth. (Today the event fires and the job exists only in the HTTP response body — `learning-api.ts:79-89`.)
- **Single-flight.** One `running` job at a time (the GPU is one card); `queued` jobs are claimed oldest-`created_at` first.
- **Interrupted, not resurrected.** At gateway boot every `running` record becomes `failed` with `error.code = 'interrupted'`. The runner does not resume unknown worker state; a re-run is a new job. Documented, asserted, not clever.
- **Transitions append to `history`** and rewrite the record (put-after-mutate; ordering per §1.4).

### 2.5 API surface — and the auth hole the new routes would open

```
GET /v1/learning/jobs/:id    → record or 404 {code:'job_not_found'}
GET /v1/learning/jobs?adapter=&status=&limit=&offset=   → list shape mirrors data-documents list
```

**Review item:** the auth middleware is currently attached as `app.use('/v1/learning/jobs', authMiddleware)`
(`learning-api.ts:59`). An exact path in Hono does **not** cover subpaths — the moment `GET /:id` exists, an
unauthenticated read path exists. R2's PR changes the pattern to `/v1/learning/jobs/*` and lands a failing
route-level test first: `GET /v1/learning/jobs/<id>` without a bearer token → 401. Fail-closed authentication is
a stated project invariant; this is the loop's one live risk of quietly widening it.

---

## 3. The pipeline, stage by stage

```
sessions/ + feedback/ (+ knowledge/, + library:<name> filters)          [inference writes, §1]
        │ P1 resolve scopes → member keys
        ▼
strategy plugin corrective_sft                                           [P2]
        │ per-turn weighted messages, deterministic order
        ▼
jobs/<id>/dataset/<strategy>.jsonl + manifest {sha256}                   [P3 export]
        │ mirrored into training-data volume at jobs/<id>/
        ▼
jobs/<id>/axolotl.yaml  (saip.yaml training+adapter ⊕ base ⊕ dataset)    [P4 materialize]
        ▼
docker exec axolotl-worker axolotl train /app/data/jobs/<id>/axolotl.yaml [P5 run — exit code is the verdict]
        ▼
adapter-output/<id>/ → adapter_config.json + adapter_model.safetensors    [P6 validate]
        │ emit learning/adapter-trained { adapter, job_id, path }
        ▼
adapters/<name>/v<N>/  ⊕  adapters/_index.json   (index LAST = commit)    [P7 promote — r2Sync]
        ▼
VersionSource.latestVersion(name) → serve-resolver @latest → compiler    [P8 serve]
        ▼
conversations under the improved adapter → new sessions/feedback          [P9 loop re-entry]
```

**P1 Scope resolution (#196).** `data_scopes: [sessions, feedback]` (the `coding` adapter's declaration,
`saip.yaml:119-120`) read the corresponding `_index.json` maps; `library:<name>` scopes read their materialized
manifest (Epic #64 B3). Failure mode owned here: an empty or unresolvable scope fails the job with a structured
error **before** any config is materialized — never a silent zero-record dataset that trains the model into
amnesia.

**P2 Strategy plugin `corrective_sft` (#196).** A Cordis plugin declaring it consumes processed session +
feedback formats. Join key is real, not invented: feedback records carry `session_id`, `message_id`, `reward ∈
[-3, 3]`, `confidence`, `dimensions` (`data-feedback.ts:15`, range enforced at `:46`). Each session message with
feedback becomes `{ role, content, weight: |reward|/3, label: reward > 0 ? 'correct' : 'corrected', provenance:
{ session_id, message_id } }`. Messages without feedback enter only as context, never as weighted signal — the
learning-loop doc's "situated experience carries the ground truth" rule, in code.

**P3 Dataset export (#196).** Canonical JSONL, records sorted by `(created_at, id)`, written to
`jobs/<id>/dataset/corrective_sft.jsonl` **and** mirrored to the `training-data` volume at `jobs/<id>/` — the
volume is the handoff that `training/docker-compose.yml:31`'s comment has been promising since it was written
("the API triggers jobs via shared volume"). The manifest carries `sha256` + record count; **the determinism
contract is two consecutive exports over identical storage produce byte-identical JSONL.** That test must be
shown to fail on an intentionally unordered export — a hash that can never differ is not a check.

**P4 Config materialization (#197).** Merge, in precedence order: `saip.yaml` `training:` block (precision
bf16, sequence_len 2048, gradient_checkpointing, adamw_bnb_8bit — `saip.yaml:71-74`), `adapter:` block (rank 16,
alpha 32, the 7 target modules — `saip.yaml:78-87`), the leaf adapter's `base` model, then job `params`
overrides last. Output paths point at the volume mirror; the Hugging Face token is referenced by **name**
(`storage.huggingface.token_env: SAIP_HF_TOKEN`, `saip.yaml:100-101`) and injected as env at execution — it
never appears in the yaml bytes stored under `jobs/`. A scan test asserts no value matching any configured
secret appears in dataset bytes, axolotl.yaml, or the job record.

**P5 Execution (#197).** The runner executes `axolotl train` in the existing worker container via
`docker exec axolotl-worker axolotl train /app/data/jobs/<id>/axolotl.yaml` and owns the job lifecycle: capture
exit code + log tail into `history`, transition `running → succeeded|failed`. Rejected alternative: a file
marker the tailing worker polls — a second, invisible state machine between the two processes. Decision rationale
goes in the docs PR. The API process never holds the GPU; the worker's reservation
(`training/docker-compose.yml:33-39`) is the only one.

**P6 Artifact validation (#197).** Success requires `adapter_config.json` and `adapter_model.safetensors` in
the job's output directory — validated by file presence + non-zero size, then `learning/adapter-trained
{ adapter, job_id, path }` is emitted. A worker exiting 0 on an empty directory is `failed { code:
'no_artifact' }`.

**P7 Promotion (#198, the `r2Sync` plugin).** Consumes `learning/adapter-trained`. Assigns
`version = max(adapters/_index.json versions for name) + 1`; uploads the directory to `adapters/<name>/v<N>/`;
**verifies each object with `get()` before touching the index**; updates the index last (the §1.4 commit-point
rule). Index shape:

```json
{ "adapters": { "coding": { "latest": 3, "versions": {
    "3": { "job_id": "train-…", "base_model": "…", "trained_at": "…", "records": 412 } } } } }
```

Failed promotion leaves the previous `latest` valid — an upload that dies mid-way strands objects, never a
version that points at missing bytes. Rollback = re-point `latest`; artifacts are immutable per version.

**P8 Serve resolution (#197/#198 consumer; no new code beyond the VersionSource).** `VersionSource`
(`inference/src/lib/adapter-compiler.ts:14-16`) and the chat path (`api-chat.ts:23` — "Latest promoted version
per adapter name (from R2 index in prod)") already define this slot: production supplies an implementation
backed by `adapters/_index.json` reads. The resolver's `no promoted version for "…"` error path
(`serve-resolver.ts:25`) becomes reachable in production rather than fixture-only. When a leaf version lands,
the compile plugin (#23) produces a `CompilePlan` for composites whose components changed, the merge backend
produces the compiled artifact, and `default-agent@latest` (`saip.yaml:137-140`) picks it up through the engine's
multi-LoRA slots (`max_loras: 4`, `saip.yaml:67-69`).

**P9 Re-entry.** Conversations continue against the improved adapter; the Data API keeps writing sessions and
feedback; the next `corrective_sft` job's P1 reads them. No automated eval gate in the MVP: promotion is
operator-observed (feedback deltas on new sessions), and the eval harness is Deferred. This is the honest shape
of "validation" from `explanation/learning-loop.mdx` at this stage — the loop closes before it self-grades.

---

## Review Focus — failure modes the spec implies but must have pinned tests

| # | Failure mode | Pinned test at | Owning task |
|---|---|---|---|
| 1 | Silent memory default loses the corpus at restart | boot: empty bucket → startup error names `SAIP_R2_BUCKET` | R1 (#198) |
| 2 | `list()` drops a truncated page | 2,500-key fake + truncation canary | R1 (#198) |
| 3 | Job-id collision across restarts | two boots mint distinct ids | R2 (#197) |
| 4 | New `GET /v1/learning/jobs/:id` reachable unauthenticated | route-level 401 test, wildcard pattern | R2 (#197) |
| 5 | Empty/unknown scope trains on nothing | job fails structured before P4 | R3/R4 (#196) |
| 6 | Dataset "determinism" never actually compared | two-run byte-equality + unordered-canary must fail | R4 (#196) |
| 7 | Secret values leak into `jobs/` artifacts | scan test over dataset/config/record | R4/R5 (#196/#197) |
| 8 | Worker exits 0 on empty output dir marked succeeded | `no_artifact` failure path | R5 (#197) |
| 9 | Index promoted to a version with missing bytes | mid-upload failure injection → `latest` unchanged | R6 (#198) |
| 10 | Strategy name drifts kebab↔snake across surfaces | registry validator + the three doc sites canonicalized first | R3 (#196) |
| 11 | Composite targeted for training | keep existing 422 `composite_not_trainable` regression | R3 (#196) |

## Decomposition — stacked PRs to staging

Order matters only where a later stage reads an earlier stage's storage; #199/#200 run in parallel, off the
critical path (the corrective-SFT loop is text-only and needs no OCR).

| Task | Issue slice | Delivers | Done means |
|---|---|---|---|
| R1 | #198a | contract in shared, R2 provider + FakeS3 contract suite, fail-closed selection, source/processed retention | §1.1–§1.5 AC green; inference runs durable in CI fakes |
| R2 | #197a | `jobs/` store, `LearningJobRecord`, GET routes + auth wildcard fix, id scheme, write-ahead + interruption policy | §2 AC green against R1's suite |
| R3 | #196a | `libraries:` config + schema, `library:<name>` scopes, canonical strategy names (docs PR: `training/README.md` table + `submit-feedback.mdx` + `api-training.mdx`), registry validator | Epic #64 B3 ticked |
| R4 | #196b | P1–P3: scope resolution, `corrective_sft` plugin, deterministic export | §3 P2–P3 green incl. canary #6 |
| R5 | #197b | P4–P6: config materialization, runner over `docker exec`, lifecycle states, stub-axolotl acceptance tier | §3 P4–P6 + Review #7/#8 |
| R6 | #198b | P7–P8: `r2Sync`, `adapters/_index.json`, production `VersionSource`, composite recompile trigger | Review #9; @latest resolves promoted versions end-to-end |
| R7 | #196/#197/#198 joint | **Loop e2e**: seed sessions+feedback via Data API → queue → dataset → stub train → promote → serve @latest, hermetic; tagged `full-loop-12gb` GPU variant closes #53's open rows | Epic #64 **B4 ticked** — the phase's definition of done |
| R8 | #199, #200 | knowledge path (binary/OCR) for `knowledge_embedding` | parallel; unblocks the second strategy, not the loop |

Final: RC to `main` is maintainer-gated per the release workflow; closing `Closes #N` lines are derived
mechanically from merged PRs at that RC, not from memory.

## Deliberately deferred (recorded, not silent)

- Epic #63 **A4** — list-authoritative reads, index rebuild, concurrent-writer safety (§1.4's boundary).
- Per-user data scoping: session/feedback records have no user id yet; MVP is single-tenant. `library:<name>` filters are the extension point.
- The `doc-`/`fb-`/`sess-` id counter flaw (§2.3) — same class as the fixed job-id bug; a small hygiene issue should absorb it.
- Automated post-training evaluation / rollback policy (P9's honest gap).
- `weighted_kto` and `knowledge_embedding` strategy plugins — P2's contract admits them; only `corrective_sft` closes the MVP loop.
- QLoRA 4-bit training: MVP trains bf16 per the committed `training:` block; quantized tiers need a measured #53-style pass first.
- Job status surfacing in MCP/UI surfaces.

---
*Authored 2026-11-05 for #201. Binding for #196–#200; where an issue and this record disagree, update the issue in the open — this file is the one both sides check against.*
