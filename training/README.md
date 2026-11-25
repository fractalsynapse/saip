# SAIP Training Gateway

The training gateway runs Axolotl fine-tuning jobs using processed data read from R2 object storage.
The inference gateway handles all data ingestion and document processing, writing results to R2.
The training gateway reads from R2 and dedicates its GPU entirely to training. It is one of two
core SAIP services (see [root README](../README.md)).

## Design

### Training Pipeline

The training gateway reads processed data from R2 (written by the inference gateway) and converts
it into strategy-specific Axolotl dataset formats using registered training strategy plugins.

```
R2 (processed data from inference gateway)
                ↓
Training Strategy Plugins
├── Knowledge Embedding (completion datasets)
├── Corrective SFT (feedback-weighted messages)
├── Weighted KTO (scalar reward records)
└── ...extensible
                ↓
         Axolotl Runner
                ↓
          QLoRA Adapter
                ↓
  Upload to R2 + update index
```

No vector databases, chunking, or embeddings are involved. Training strategy plugins transform
processed intermediate formats from R2 into their specific Axolotl dataset format. They do not
split or chunk data — they transform formats based on rules.

### Single API Surface: Learning API

| API | Path Prefix | Responsibility |
|-----|-------------|----------------|
| **Learning API** | `/v1/learning/*` | Training strategy registration, learning job management, feedback, optimization |

The training gateway exposes only the Learning API. All data ingestion (document upload, session
history, feedback submission) is handled by the inference gateway's Data API (`/v1/data/*`). The
two services communicate through R2: the inference gateway writes processed data, and the training
gateway reads it as input for training jobs. This separation ensures the training GPU is 100%
dedicated to Axolotl fine-tuning.

### Training Strategy Plugin Registry

The training gateway maintains a registry of training strategy plugins. Each strategy declares which
processed data formats it can consume from R2 and produces Axolotl datasets in its required format.

**Training Strategy Plugins** — each implements one learning method:

| Plugin | Consumes (from R2) | Produces |
|--------|---------------------|----------|
| `knowledge_embedding` | Processed documents | Completion-format text sequences |
| `corrective_sft` | Feedback-weighted messages | SFT dataset with per-turn weights |
| `weighted_kto` | Scalar reward records | KTO dataset with magnitude weights |
| *(extensible)* | *(declared types)* | *(strategy-specific Axolotl format)* |

These are **Cordis plugins that register themselves at startup**. A training strategy plugin
implements: "read processed data from R2 → produce Axolotl dataset." Adding a new training method
requires only one new plugin — zero changes to existing code. Document processing is handled
entirely by the inference gateway.

#### The plugin contract, as implemented

A strategy declares three things, and the registry uses all three:

```ts
interface TrainingStrategyPlugin {
  readonly name: string            // canonical snake_case, matched against an adapter's `training.strategy`
  readonly consumes: ScopeKind[]   // which resolved scopes it reads: sessions | feedback | documents | library
  readonly format: string          // the Axolotl dataset format it emits, recorded in the job manifest
  build(input: StrategyInput): StrategyRow[]
}
```

`POST /v1/learning/jobs` accepts a strategy only if a plugin with that name is registered in this
gateway. The list is not a config value: `registeredStrategies` defaults to what `createApp()`
actually installs, so a strategy that resolves at the API but cannot produce a dataset is a test
failure rather than a job that fails at 3am on a rented GPU.

#### `corrective_sft`: what a row is, and what is not a row

Feedback records carry `session_id`, `message_id`, `reward ∈ [-3, 3]` and `confidence` — the join is
on those real keys, never on positions or timestamps:

```json
{ "role": "assistant", "content": "…", "weight": 0.667, "label": "corrected",
  "provenance": { "session_id": "sess-1", "message_id": "m-4" } }
```

- `weight = |reward| / 3`, so the strongest correction and the strongest confirmation carry the same
  magnitude and the label carries the sign.
- `confidence` is read but deliberately **not** applied to the weight. Scaling loss by a self-reported
  0–1 figure would make the dataset depend on an uncalibrated number, invisibly in the bytes; the
  determinism guarantee below is worth more than a plausible heuristic. A later strategy that earns
  it can use it.
- `label = reward > 0 ? "correct" : "corrected"`.
- **A message with no feedback is context only.** It may appear in the conversation window, but it is
  never weighted and never a target. This is the "situated experience carries the ground truth" rule
  from the learning-loop explanation, expressed as a join: without it, every sentence the model ever
  produced becomes training signal for whatever the user happened to reply to.

#### Determinism is a contract, not a hope

Two exports over identical storage must produce **byte-identical** JSONL. Concretely: rows sorted by
`(created_at, id)` before serialization, keys inside each row in a fixed order, no timestamps or
map-iteration order in the bytes, and the manifest recording `sha256` plus `records`. The suite proves
the comparison actually compares by exporting a deliberately unordered set and asserting the hashes
differ — a hash that can never differ is not a check.

The dataset lands at `jobs/<id>/dataset/corrective_sft.jsonl` in storage. The `training-data` volume
mirror (`/app/data/jobs/<id>/`) is written only when `SAIP_TRAINING_DATA_DIR` names a directory: the
worker sees a volume, the gateway sees whatever it mounted, and inventing a path in code would be a
claim with no artifact behind it.

### Adapter Registry Linkage

Every leaf adapter in the `saip.yaml` registry declares its training linkage — `strategy` plus
`data_scopes` (see [Adapter Definitions](https://adrianwebb.github.io/saip/reference/adapter-definitions/)).
A learning job targeting an adapter inherits that linkage, so the path from user experience to
updated weights is explicit and auditable:

```
user → users[].adapters.training → adapter definition → training.strategy + data_scopes
         → matching strategy plugin → Axolotl dataset → trained adapter version → R2
```

Composite adapters are **not trainable** — they are compiled by the inference gateway from their
components' promoted versions. Training always targets leaves.

**Gateway plugins** orchestrate training:

| Plugin | Responsibility |
|--------|---------------|
| `training-strategy-registry` | Track registered strategies, load processed data from R2 for matching consumers |
| `learning-api` | Hono HTTP server for strategy listing and job management |
| `axolotl-runner` | Queue and execute Axolotl training jobs, manage GPU allocation |

Plugins communicate through Cordis events:

```
r2/data-updated         — new processed data available in R2 from inference gateway
learning/job-queued     — learning job added to queue
learning/job-started    — Axolotl job running
learning/job-complete   — adapter produced, ready for evaluation
adapter/promoted        — adapter passed evaluation, uploaded to R2
```

### Training Strategies

| Strategy | Input | What it teaches | Axolotl config |
|----------|-------|----------------|----------------|
| Knowledge embedding | Processed documents → completion datasets | Domain familiarity, world model | `type: completion`, continued pretraining |
| Corrective SFT | Feedback-weighted messages | How to correct mistakes, avoid repeating them | Custom SFT with feedback-weighted loss |
| Weighted KTO | Scalar reward records (-3 to +3) + confidence | Behavioral policy shaping | Custom KTO with magnitude weighting |

All strategies consume processed data from R2 (written by the inference gateway) and produce QLoRA
adapters that are uploaded back to R2 for the inference gateway to serve.

### From job record to adapter: what runs, in order

`POST /v1/learning/jobs` only persists a record. Execution is claimed by the runner, and each stage
writes its output before the next one reads it, so a job can be resumed by hand and audited after the
fact:

| Stage | Output | Failure code |
|-------|--------|--------------|
| P1 scope resolution | member keys (at queue time, see the Learning API) | `empty_scope`, `unknown_scope`, `library_not_found` |
| P2–P3 dataset export | `jobs/<id>/dataset/<strategy>.jsonl` + manifest | `no_dataset_rows` |
| P4 config materialization | `jobs/<id>/axolotl.yaml`, mirrored to `<data-dir>/jobs/<id>/` | `no_base_model`, `config_failed` |
| P5 execution | `docker exec axolotl-worker axolotl train /app/data/jobs/<id>/axolotl.yaml` | `worker_unavailable`, `training_failed` |
| P6 validation | `adapter_config.json` + `adapter_model.safetensors` present and non-zero | `no_artifact` |
| P7 promotion | `adapters/<name>/v<N>/` + index (see #198b) | `promotion_failed` |

**Precedence for the generated Axolotl config** (later wins): the `training:` block of the active
service profile in `saip.yaml` → the `adapter:` block (rank, alpha, target modules) → the leaf
adapter's `base` checkpoint → the job's own `params`. The output paths point at the volume mirror, and
the Hugging Face token is referenced **by name** (`SAIP_HF_TOKEN`) and injected into the worker's
environment at execution — it never appears in the stored YAML bytes. A scan test asserts that no
configured secret value appears in the dataset, the config, or the job record.

**Why the runner shells out instead of polling a marker.** A previous design had the worker notice a
file and report back through another file. That is a second, invisible state machine between two
processes: the API would believe one thing while the worker believed another, and the disagreement
would surface as a job stuck in `running`. Here the API process owns the lifecycle, runs
`docker exec`, and treats the exit code as the verdict — a worker that exits 0 having written nothing
is `no_artifact`, not success.

**The API process never holds the GPU.** The worker's `deploy.resources.reservations` in
`docker-compose.yml` is the only reservation, and on a single card training and serving are
time-shared via `saip awake` / `saip sleep`, never run concurrently.

Because `docker exec` requires the daemon, the runner runs where the socket is reachable: a
host-run gateway in development (the supported MVP path). Inside the container it reports
`worker_unavailable` rather than guessing — mounting the Docker socket into the training API was
rejected, as it would hand that container root-equivalent control of the host.

### Background Processing

Training runs as a background process. The Learning API accepts job requests and manages the
training queue, while Axolotl executes asynchronously. The API remains responsive during
training. Training data is read from R2 — the training gateway never ingests data directly.

When operating in "sleep" mode on a single GPU, the inference gateway is stopped and the
training gateway has exclusive GPU access. On separate GPU nodes, both run simultaneously.
In either mode, processed data flows through R2 as the handoff boundary.

### Docker Compose Services

```yaml
services:
  training-api:         # Hono API server (Cordis app)
  axolotl-worker:       # Axolotl training process
  # Future: evaluation service, dataset preprocessing, etc.
```

## Configuration

Service-specific settings live under the `training:` key in `saip.yaml`. See
[`saip.schema.yaml`](../saip.schema.yaml) for the full schema.

## Development

```bash
cd training
pnpm install
pnpm dev          # Start development server
pnpm test         # Run tests
```
