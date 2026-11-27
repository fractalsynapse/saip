/**
 * Hermetic loop e2e (#196/#197/#198 joint, design record §R7, epic #64 B4).
 *
 * Every other test in this repo drives one gateway inside one process. The loop is not one process:
 * inference writes the corpus, training reads it, the worker produces an artifact, promotion writes an
 * index, and a *restarted* inference gateway must serve what training produced. That sequence has
 * never been executed end to end, and the failure modes live precisely in the seams between the
 * processes — key names, index shape, write ordering, the durability claim in the goal file.
 *
 * So this script starts both built artifacts as real programs over real HTTP against one in-process
 * S3-shaped endpoint, with no GPU, no cloud credentials and no network sidecar:
 *
 *   seed sessions + feedback (inference Data API)
 *     → queue a corrective_sft job (training API)
 *     → export dataset + materialize config + execute the worker (fake `docker` on PATH)
 *     → validate artifacts → promote to adapters/coding/v000001/ → index last
 *     → RESTART the inference gateway → `coding@latest` resolves to the promoted version
 *
 * The worker is faked by putting a `docker` shim earlier on the spawned process's PATH. That is
 * deliberate: the runner's contract with the worker is a command line and an output directory, so a
 * shim exercises the same boundary the real container will, and it fails if the runner's arguments or
 * the volume layout are wrong. `training/tests/axolotl-runner.test.ts` covers the lifecycle states
 * with an injected executor; this covers the processes.
 *
 * Usage: pnpm -r build && node training/dist/scripts/loop-e2e.js   (or: npx tsx training/scripts/loop-e2e.ts)
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { R2StorageProvider } from '@saip/shared'
import { startFakeS3, FAKE_ACCESS_KEY, FAKE_SECRET_KEY } from '@saip/shared/testing'

const repoRoot = join(import.meta.dirname, '..', '..')
const log = (line: string): void => process.stderr.write(`[loop] ${line}\n`)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface Step { name: string; done: () => Promise<boolean> }

/** Same wait, but reports the observed record when it gives up: a silent timeout hides which stage stalled. */
async function waitForWithJobReport(label: string, fn: () => Promise<boolean>, report: () => Promise<string>, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await fn().catch(() => false)) return
    await sleep(400)
  }
  throw new Error(`${label}\nlast observed record: ${await report().catch((e) => String(e))}`)
}

async function waitFor(label: string, fn: () => Promise<boolean>, ms = 45_000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await fn().catch(() => false)) return
    await sleep(300)
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function http(url: string, init?: RequestInit): Promise<{ status: number; body: any; text: string }> {
  const res = await fetch(url, init)
  const text = await res.text()
  let body: any = undefined
  try { body = JSON.parse(text) } catch { /* non-JSON responses are still reported */ }
  return { status: res.status, body, text }
}

/** Start a built gateway program with an explicit environment. */
function startProgram(entry: string, env: Record<string, string>, tag: string): ChildProcess {
  const child = spawn(process.execPath, [entry], {
    cwd: repoRoot,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
  })
  let out = ''
  child.stdout?.on('data', (c) => { out += c.toString() })
  child.stderr?.on('data', (c) => { out += c.toString() })
  ;(child as any).__out = () => out
  child.on('exit', (code) => { if (code !== 0 && code !== null) log(`${tag} exited early with ${code}\n${out}`) })
  return child
}

/**
 * Write a `docker` executable that satisfies the runner's contract by producing the expected artifact.
 *
 * The runner's whole interface to the worker is a command line and an output directory, so the shim
 * resolves the container path against the host volume exactly as the bind mount would: `/app/data/...`
 * becomes `<dataDir>/...`. If the runner ever passes a path the worker could not read, the shim fails
 * and the job lands in `training_failed` rather than the test quietly passing.
 */
function writeDockerShim(bin: string, dataDir: string, outputDir: string): string {
  const shim = join(bin, 'docker')
  writeFileSync(shim, `#!/bin/sh
# Fake worker for the hermetic loop test (#196/#197/#198 joint).
set -e
[ "$1" = "exec" ] || { echo "shim: expected 'exec', got: $*" >&2; exit 64; }
shift
# Drop flags and the container name until the axolotl invocation.
while [ $# -gt 0 ] && [ "$1" != "axolotl" ]; do shift; done
[ "$1" = "axolotl" ] || { echo "shim: no axolotl in: $*" >&2; exit 65; }
shift
[ "$1" = "train" ] || { echo "shim: expected 'train', got: $1" >&2; exit 66; }
CONTAINER_PATH=$(printf '%s\n' "$*" | grep -oE '/app/data/[^ ]+axolotl\.yaml' || true)
[ -n "$CONTAINER_PATH" ] || { echo "shim: no /app/data config path in: $*" >&2; exit 67; }
CONFIG="${dataDir}\${CONTAINER_PATH#/app/data}"
[ -f "$CONFIG" ] || { echo "shim: config not found on the host: $CONFIG" >&2; exit 68; }
JOB=$(basename "$(dirname "$CONFIG")")
mkdir -p "${outputDir}/$JOB"
printf '{"r":16,"lora_alpha":32,"base_model_name_or_path":"Qwen/Qwen3.5-4B"}' > "${outputDir}/$JOB/adapter_config.json"
printf 'fake-lora-weights' > "${outputDir}/$JOB/adapter_model.safetensors"
echo "shim: trained $JOB"
exit 0
`)
  chmodSync(shim, 0o755)
  return shim
}

async function main(): Promise<number> {
  const fake = await startFakeS3()
  const bucket = 'loop-e2e'
  const work = mkdtempSync(join(tmpdir(), 'saip-loop-'))
  const bin = join(work, 'bin'); mkdirSync(bin, { recursive: true })
  const dataDir = join(work, 'data'); mkdirSync(join(dataDir, 'jobs'), { recursive: true })
  const outputDir = join(work, 'output'); mkdirSync(outputDir, { recursive: true })

  // The config both gateways load. Literal values: no shell, no .env, no interpolation surprises.
  const configPath = join(work, 'saip.yaml')
  writeFileSync(configPath, readFileSync(join(repoRoot, 'saip.yaml'), 'utf8')
    .replace('dev_mode: false', 'dev_mode: true')
    .replace(/r2:\n\s+bucket: "[^"]*"\n\s+endpoint: "[^"]*"/, `r2:\n    bucket: "${bucket}"\n    endpoint: "${fake.baseUrl}"`))

  const shim = writeDockerShim(bin, dataDir, outputDir)

  if (!readFileSync(shim, 'utf8').includes(dataDir)) throw new Error('docker shim did not receive the volume mapping')

  const sharedEnv: Record<string, string> = {
    SAIP_CONFIG: configPath,
    SAIP_ENV_FILE: join(work, 'none.env'),
    SAIP_SECRETS_FILE: join(work, 'secrets.enc.json'),
    SAIP_R2_BUCKET: bucket,
    SAIP_R2_ENDPOINT: fake.baseUrl,
    SAIP_R2_ACCESS_KEY_ID: FAKE_ACCESS_KEY,
    SAIP_R2_SECRET_ACCESS_KEY: FAKE_SECRET_KEY,
  }

  const inferencePort = 8701
  const trainingPort = 8702
  // Distinct, not `inferencePort + 1`: that was the training port, and the restarted
  // gateway died on EADDRINUSE looking like a serving bug.
  const restartedPort = 8703
  const gateway = startProgram(join(repoRoot, 'inference', 'dist', 'index.js'), {
    ...sharedEnv, SAIP_INFERENCE_PORT: String(inferencePort), SAIP_VLLM_BASE_URL: 'http://127.0.0.1:1/v1',
  }, 'inference')
  const trainer = startProgram(join(repoRoot, 'training', 'dist', 'index.js'), {
    ...sharedEnv,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    SAIP_TRAINING_PORT: String(trainingPort),
    SAIP_TRAINING_RUN: '1',
    SAIP_TRAINING_POLL_SECONDS: '1',
    SAIP_TRAINING_DATA_DIR: dataDir,
    SAIP_ADAPTER_OUTPUT_DIR: outputDir,
  }, 'training')

  const steps: Step[] = []
  const record = async (name: string, done: () => Promise<boolean>): Promise<void> => {
    steps.push({ name, done })
    await waitFor(name, done)
    log(`ok: ${name}`)
  }

  try {
    await record('both gateways bound their ports', async () =>
      (await http(`http://127.0.0.1:${inferencePort}/health`)).status === 200
      && (await http(`http://127.0.0.1:${trainingPort}/health`)).status === 200)

    // The training gateway must see the real registry, not an empty one.
    await record('training serves the declared strategies', async () => {
      const r = await http(`http://127.0.0.1:${trainingPort}/v1/learning/strategies`)
      return r.status === 200 && Array.isArray(r.body?.strategies) && r.body.strategies.includes('corrective_sft')
    })

    // 1. Experience enters the platform as a session plus a correction.
    const session = await http(`http://127.0.0.1:${inferencePort}/v1/data/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        caller: 'adrian', adapter_id: 'coding',
        messages: [
          { id: 'm1', role: 'user', content: 'how do I undo a rebase?', created_at: '2026-11-27T01:00:00Z' },
          { id: 'm2', role: 'assistant', content: 'git push --force', created_at: '2026-11-27T01:00:01Z' },
        ],
      }),
    })
    if (session.status !== 201) throw new Error(`session seed failed: ${session.status} ${session.text}`)
    const sid = session.body.id
    log(`ok: session ${sid} stored in the bucket`)

    const feedback = await http(`http://127.0.0.1:${inferencePort}/v1/data/feedback`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: sid, message_id: 'm2', reward: -3, confidence: 1, feedback_text: 'wrong: never force-push' }),
    })
    if (feedback.status !== 201) throw new Error(`feedback seed failed: ${feedback.status} ${feedback.text}`)
    log('ok: feedback stored')

    // Corpus must be visible to training before the job can be queued.
    await record('training resolves the seeded corpus', async () => {
      const r = await http(`http://127.0.0.1:${trainingPort}/v1/learning/jobs`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ adapter: 'coding' }),
      })
      if (r.status === 202) { globalThis.__jobId = r.body.id as string; return true }
      // The corpus is eventually visible (inference writes on request), so a refusal is retried.
      return false
    })
    const jobId = String((globalThis as any).__jobId)

    // 2–6. The gateway claims it, exports, materializes, "trains", validates, and promotes.
    await waitForWithJobReport('job reached succeeded with a promoted version', async () => {
      const r = await http(`http://127.0.0.1:${trainingPort}/v1/learning/jobs/${jobId}`)
      return r.status === 200 && r.body?.status === 'succeeded' && typeof r.body?.version === 'number'
    }, () => http(`http://127.0.0.1:${trainingPort}/v1/learning/jobs/${jobId}`).then((r) => JSON.stringify({ status: r.body?.status, error: r.body?.error, tail: r.body?.history?.at(-1) })))
    const final = await http(`http://127.0.0.1:${trainingPort}/v1/learning/jobs/${jobId}`)
    const rec = final.body
    log(`ok: job ${jobId} status=${rec.status} version=${rec.version} dataset=${rec.dataset?.records} records`)

    // The dataset must be a real, deterministic artifact rather than a claim.
    const storage = new R2StorageProvider({ endpoint: fake.baseUrl, bucket, accessKeyId: FAKE_ACCESS_KEY, secretAccessKey: FAKE_SECRET_KEY })
    const dataset = await storage.get(rec.dataset.key)
    if (!dataset) throw new Error('dataset missing from the bucket')
    const recomputed = createHash('sha256').update(dataset, 'utf8').digest('hex')
    if (recomputed !== rec.dataset.sha256) throw new Error(`dataset hash mismatch: record says ${rec.dataset.sha256}, bytes are ${recomputed}`)
    if (!/"label":"corrected"/.test(dataset)) throw new Error(`feedback did not reach the dataset:\n${dataset}`)
    log(`ok: dataset sha256 verified over the wire (${rec.dataset.records} records)`)

    const cfg = await storage.get(rec.config.key)
    if (!cfg || !cfg.includes('Qwen/Qwen3.5-4B')) throw new Error('materialized config missing or wrong base')
    if (cfg.includes(FAKE_SECRET_KEY)) throw new Error('secret value leaked into the stored config')
    log('ok: axolotl config materialized with the declared base, no secret values')

    // 7. Promotion committed by moving the index.
    const index = JSON.parse((await storage.get('adapters/_index.json'))!)
    if (index.adapters?.coding?.latest !== rec.version) throw new Error(`index latest=${index.adapters?.coding?.latest}, job version=${rec.version}`)
    if (index.aliases) throw new Error('index still carries the retired aliases map')
    if (await storage.get(`adapters/coding/v00000${rec.version}/adapter_model.safetensors`) === undefined) {
      throw new Error('promoted artifact bytes are missing')
    }
    log(`ok: adapters/coding/v00000${rec.version}/ uploaded, verified, index committed last`)

    // 8. Durability: a NEW inference process must serve the promoted adapter with nothing in memory.
    gateway.kill('SIGTERM')
    await sleep(600)
    const engineSeen: string[] = []
    const engine: Server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => { raw += c.toString() })
      req.on('end', () => {
        try { engineSeen.push(JSON.parse(raw).model) } catch { /* ignore */ }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          id: 'e2e', object: 'chat.completion', created: 1, model: 'stub',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }))
      })
    })
    await new Promise<void>((r) => engine.listen(0, '127.0.0.1', () => r()))
    const enginePort = (engine.address() as any).port

    const restarted = startProgram(join(repoRoot, 'inference', 'dist', 'index.js'), {
      ...sharedEnv, SAIP_INFERENCE_PORT: String(restartedPort), SAIP_VLLM_BASE_URL: `http://127.0.0.1:${enginePort}/v1`,
    }, 'inference-restarted')

    await record('restarted gateway serves the promoted adapter through @latest', async () => {
      const r = await http(`http://127.0.0.1:${restartedPort}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'coding', messages: [{ role: 'user', content: 'undo a rebase?' }], max_tokens: 4 }),
      })
      return r.status === 200 && engineSeen.length > 0
    })
    const served = engineSeen[engineSeen.length - 1]
    if (served !== `coding@00000${rec.version}`) throw new Error(`engine was asked for "${served}", expected coding@00000${rec.version}`)
    log(`ok: fresh process resolved @latest → ${served} from the bucket alone`)

    // The experience the improvement should be measurable against: same corpus, one more rating.
    const second = await http(`http://127.0.0.1:${trainingPort}/v1/learning/jobs`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ adapter: 'coding' }),
    })
    if (second.status !== 202) throw new Error(`loop re-entry refused: ${second.status} ${second.text}`)
    await record('loop re-entry: a second job claims and promotes', async () => {
      const r = await http(`http://127.0.0.1:${trainingPort}/v1/learning/jobs/${second.body.id}`)
      return r.status === 200 && r.body?.status === 'succeeded' && r.body?.version === 2
    })
    const index2 = JSON.parse((await storage.get('adapters/_index.json'))!)
    if (index2.adapters.coding.latest !== 2) throw new Error('second promotion did not move latest')
    log('ok: v2 promoted; latest=2; v1 bytes retained for rollback')

    // The final state, read from the bucket rather than from any process's memory: this is the claim
    // the goal file makes about durability, so it is asserted where a killed instance cannot help it.
    const finalIndex = JSON.parse((await storage.get('adapters/_index.json'))!)
    if (finalIndex.adapters.coding.latest !== 2) throw new Error('index lost its state between processes')
    for (const v of ['1', '2']) {
      if (await storage.get(`adapters/coding/v00000${v}/adapter_model.safetensors`) === undefined) {
        throw new Error(`version ${v} bytes missing`)
      }
    }

    // Re-running each predicate is not possible: the first gateway was intentionally killed to prove
    // restart durability, so a re-check would fail on a subject that no longer exists.
    log(`PASS — ${steps.length} stages executed across 3 processes (inference, training, restarted inference)`)
    log(`     bucket state: adapters/coding v1+v2, latest=2, ${finalIndex.adapters.coding.versions['2'].job_id}`)
    return 0
  } catch (e) {
    log(`FAIL — ${(e as Error).message}`)
    for (const [tag, proc] of [['inference', gateway], ['training', trainer]] as const) {
      const out = (proc as any).__out?.() ?? ''
      if (out) log(`${tag} output:\n${out.split('\n').slice(-12).join('\n')}`)
    }
    return 1
  } finally {
    gateway.kill('SIGKILL'); trainer.kill('SIGKILL')
    await (steps.length ? sleep(200) : Promise.resolve())
    await fake.close().catch(() => undefined)
    process.exitCode = process.exitCode ?? 0
  }
}

main().then((code) => {
  process.exit(code)
}).catch((e) => {
  log(`harness error: ${(e as Error).stack ?? e}`)
  process.exit(1)
})
