# Goal — Close the Loop, End-to-End, Driven by DeepSeek Harness

**Status:** DRAFT for discussion (2026-11-25). Binding contract: `docs/superpowers/plans/2026-11-05-close-the-loop.md`
— where this file and that record disagree, the record wins. Epics #63/#64; tasks #196–#198 (critical),
#199–#200 explicitly out (Non-goals). Closure criterion: Epic #64 **B4**.

## End state

A person chats with an agent running in **DeepSeek Harness** whose model is served by SAIP (vLLM, named
adapter per caller). Corrections enter the platform as feedback records; a `corrective_sft` job exports a
deterministic dataset, trains on a **real GPU** (this machine's RTX 3080 16 GB), validates the artifact,
promotes a new adapter version to **Cloudflare R2**, and the gateway serves it. The same task, run again in
dsh, is measurably better. Nothing essential lives in process memory: a cloud GPU instance can be killed
and a fresh one resumes from R2 + job records. dsh replaces Hermes as the experience producer — the
harness that already drives real work is the source of the experience the platform learns from.

## Acceptance

### A. The nine stages execute (design record §3, tasks R1–R7)

- [ ] **Storage** — `R2StorageProvider` is the default in both composition roots; empty bucket config fails
      startup naming `SAIP_R2_BUCKET`; memory storage only by explicit opt-in, announced loudly at boot.
      Contract suite green against Memory, FakeS3 (SigV4 canonical-request asserts, 2,500-key pagination
      canary), and live R2 behind an opt-in tag. (#198)
- [ ] **Jobs** — `jobs/<id>.json` persisted before the queued event fires; boot-time `running` records become
      `failed { code: 'interrupted' }`; ids collision-free across restarts; `GET /v1/learning/jobs/:id`
      refuses unauthenticated reads (route-level 401 test lands BEFORE the route). (#197)
- [ ] **Dataset** — `corrective_sft` plugin joins sessions × feedback on the real keys (`session_id`,
      `message_id`, reward ∈ [-3,3], confidence); no-feedback messages are context only, never weighted.
      Two exports over identical storage are **byte-identical**; an unordered-export canary proves the check. (#196)
- [ ] **Runner** — `docker exec axolotl-worker axolotl train …/axolotl.yaml`; exit 0 with an empty output
      directory is `failed { no_artifact }`; lifecycle transitions append to `history`. Secret-value scan
      over dataset + config + job record passes. (#197)
- [ ] **Promotion** — `r2Sync` uploads `adapters/<name>/v<N>/`, verifies each object by read-back, writes
      `adapters/_index.json` **last**; mid-upload failure leaves `latest` pointing at valid bytes only. (#198)
- [ ] **Serve** — production `VersionSource` reads the R2 index; `@latest` resolves the promoted version;
      composites recompile; vLLM serves through the existing multi-LoRA slots. (#196/#197/#198 consumers)
- [ ] **Loop e2e** — hermetic test (seed → queue → export → stub-train → promote → serve @latest) green in
      CI with no GPU, no network sidecar, no cloud credentials. Epic #64 B4 ticked. (R7)

### B. Real hardware on this machine

- [ ] The full loop executes a **real** `corrective_sft` training on the RTX 3080 16 GB: dataset → Axolotl
      → adapter → R2 → served, with measured peak VRAM recorded (a #53-style profile row, written down,
      not recalled).
- [ ] **12 GB fit attempt:** either a profile (sequence or split train/serve phases) demonstrably completes
      within 12 GB, or a written finding states the measured floor with numbers and what must be excluded
      to reach it. Either outcome closes this line — silence closes nothing.

### C. Cloud durability (real R2)

- [ ] **Kill/resume proof:** with a job running and adapters promoted, `docker compose down` (full stop),
      then up: job truth survives in R2 (`interrupted` recorded, re-run = new job), datasets and adapter
      versions read back intact, no dangling index entries. The same procedure documented for a fresh cloud
      instance (host file, secrets by name, `saip` CLI bring-up steps).
- [ ] Committed bytes contain zero secret values (names only) — the scan test from A stays green at this step.

### D. dsh as the experience producer (Hermes replaced)

- [ ] dsh profile patch declares a provider whose models are the gateway's **adapter aliases**; one dsh
      session completes a real SAIP-repo task served by the `coding` adapter through the gateway.
- [ ] **Bridge:** one command exports a finished dsh session — messages, tool activity, artifacts summary,
      the human's corrections as feedback records (reward/confidence) — into the Data API, producing valid
      `sessions/<id>/` + `feedback/` records. Raw experience preserved unchanged; the trainer decides what
      becomes training data, the bridge never does.
- [ ] **Closed-loop demo, harness-side:** one iteration end-to-end from dsh-originated experience:
      correction → job → real train → promote → serve → the same task re-run in dsh against the new adapter.
      A written report shows both transcripts' relevant turns and the feedback delta. (Operator-observed
      validation is the design record's honest MVP — no automated eval gate.)

## Non-goals (deliberately, recorded not silent)

- `weighted_kto` and `knowledge_embedding` strategy plugins (P2's contract admits them later).
- Automated post-training evaluation and rollback policy.
- Multi-tenant / per-user data scoping; #63 A4 concurrent-writer safety beyond single-writer.
- OCR / binary knowledge ingestion (#199/#200 remain open, off the critical path).
- Renting automation (Hyperstack keys exist; provisioning stays manual for this phase).
- Fixing the legacy `doc-`/`fb-`/`sess-` id counters (design record's Deferred — a hygiene issue may absorb it).

## Constraints (binding, from AGENTS.md and the design record)

Every capability is a Cordis plugin or injectable seam; documentation-first with a failing user-observable
test before implementation; composition-root default paths tested without fakes; CI green with no GPU,
network sidecar, or cloud credentials (live tiers are opt-in tags); fail-closed everywhere (storage, auth,
scopes, artifacts); conventional commits referencing issues, staging PRs marked `Part of #N`; changelog per
PR; no secret values in committed bytes, job records, datasets, or generated configs.

## Verification

A closing session demonstrates: the hermetic R7 e2e passing in CI; the hardware lines with measured numbers
in a report file; the kill/resume transcript; the dsh before/after pair; issues #196/#197/#198 closed by
their PRs with Epic #64 B4 ticked; this file checked against the design record one final time, discrepancies
resolved **in the open** (issue or record edited explicitly, never silently).

## One-line goal for the dsh session

> Close the SAIP learning loop per `docs/superpowers/plans/2026-11-05-close-the-loop.md` and
> `docs/goals/2026-11-25-close-the-loop-end-state.md` — read both fully before the first code action; the
> goal file's acceptance list is the definition of done; the design record outranks it on conflict.
