/**
 * The R2 / S3 REST client behind `StorageProvider` (#198).
 *
 * Four operations, no SDK. The alternative was `@aws-sdk/client-s3`, which #187 deleted from
 * this manifest precisely because it was declared and never imported; adding it back to serve
 * `put`/`get`/`list`/`delete` would make it the platform's first heavy runtime dependency for
 * ~200 lines of protocol. R2 speaks the S3 API, and S3's authentication is a documented
 * canonical-request format that `node:crypto` implements in a page.
 *
 * Two behaviours are load-bearing for the learning loop and are the reason this file is not a
 * one-line `fetch` wrapper:
 * - **`list()` must page.** R2 caps a `list-type=2` response at 1,000 keys. A provider that
 *   ignores `IsTruncated` returns a sorted, plausible, *short* listing — so a scope resolution
 *   silently trains on the first thousand sessions and reports success. The contract suite
 *   seeds 2,500 keys and truncates page 2 on purpose.
 * - **404 is a value, not an exception.** `get()` maps it to `undefined` because "no promoted
 *   version yet" is a normal state, while a transport failure is not.
 *
 * Signature correctness is checked against an independent verifier (not this code) in
 * `shared/tests/fixtures/fake-s3.ts`, including a canary where a corrupted signature must be
 * rejected — a detector that cannot fail is not a detector.
 */
import { createHmac, createHash } from 'node:crypto'

export interface R2StorageOptions {
  /** S3-compatible endpoint, e.g. `https://<account>.r2.cloudflarestorage.com`. No bucket. */
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  /** R2 accepts `auto`; S3 wants a real region. */
  region?: string
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /**
   * Test-only hook applied to the finished signature, so the suite can prove the server
   * rejects a wrong one. Production code never sets it.
   */
  signOverride?: (signature: string) => string
}

/** A storage failure with the HTTP/S3 detail attached, so callers can branch on `status`. */
export class R2StorageError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'R2StorageError'
  }
}

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

/** SigV4 URI-encoding: RFC 3986, unreserved set only, `/` preserved by the caller. */
const uriEncode = (s: string): string =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())

const sha256Hex = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')
const hmac = (key: Buffer | string, data: string): Buffer => createHmac('sha256', key).update(data).digest()

/** Keys are opaque strings; each `/`-separated segment is encoded, the separator is not. */
function encodeKeyPath(key: string): string {
  return key.split('/').map(uriEncode).join('/')
}

function canonicalQuery(params: Array<[string, string]>): string {
  return params
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([a], [b]) => (a === b ? 0 : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
}

interface SignedRequest {
  url: string
  method: string
  headers: Record<string, string>
  /** Uint8Array, not Buffer: the declared BodyInit union does not accept Buffer's generic. */
  body?: Uint8Array
}

function sign(o: R2StorageOptions, method: string, path: string, params: Array<[string, string]>, payloadHash: string, body?: Buffer): SignedRequest {
  const base = new URL(o.endpoint)
  const host = base.port ? `${base.hostname}:${base.port}` : base.hostname
  // canonicalUri keeps its leading "/", so it is appended directly. Joining with another "/"
  // produced "//bucket/key", which the client normalizes away on the wire — dropping the bucket
  // from the request while signing the path that still contains it. SigV4 then matches nothing
  // and every call is a 403; the failure is silent unless the request bytes are inspected.
  const canonicalUri = encodeKeyPath(path)
  const url = `${base.protocol}//${host}${canonicalUri}${params.length ? `?${canonicalQuery(params)}` : ''}`

  const now = new Date()
  const stamp = now.toISOString().replace(/[:-]|\.\d{3}/g, '') // YYYYMMDDTHHMMSSZ
  const date = stamp.slice(0, 8)
  const region = o.region ?? 'auto'

  // SignedHeaders must be the exact set actually sent; `host` is included even though fetch
  // would derive it, because the signature commits to it.
  const headers: Record<string, string> = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': stamp,
  }
  const names = Object.keys(headers).sort()
  const canonicalHeaders = names.map((n) => `${n}:${headers[n].trim()}\n`).join('')

  const canonical = [method, canonicalUri, canonicalQuery(params), canonicalHeaders, names.join(';'), payloadHash].join('\n')
  const scope = [date, region, 's3', 'aws4_request'].join('/')
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256Hex(canonical)].join('\n')

  const kSigning = hmac(hmac(hmac(hmac(`AWS4${o.secretAccessKey}`, date), region), 's3'), 'aws4_request')
  let signature = hmac(kSigning, stringToSign).toString('hex')
  if (o.signOverride) signature = o.signOverride(signature)

  return {
    url,
    method,
    headers: { ...headers, Authorization: `AWS4-HMAC-SHA256 Credential=${o.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` },
    body: body ? new Uint8Array(body) : undefined,
  }
}

/** Pull the `<Code>` out of an S3 XML error body; the code, not the prose, is what callers branch on. */
function errorCode(xml: string): string | undefined {
  return xml.match(/<Code>([^<]*)<\/Code>/)?.[1]
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

interface ListPage { keys: string[]; truncated: boolean; token?: string }

/** Minimal `ListBucketResult` reader. A real XML parser is not justified by three fields. */
function parseList(xml: string): ListPage {
  const keys = [...xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((m) => decodeXml(m[1]))
  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/.test(xml)
  const token = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)
  return { keys, truncated, token: token ? decodeXml(token[1]) : undefined }
}

export class R2StorageProvider {
  private readonly opts: R2StorageOptions
  private readonly doFetch: typeof fetch

  constructor(options: R2StorageOptions) {
    if (!options.bucket) throw new R2StorageError('R2StorageProvider requires a bucket', 0, 'empty_bucket')
    if (!options.endpoint) throw new R2StorageError('R2StorageProvider requires an endpoint', 0, 'empty_endpoint')
    if (!options.accessKeyId || !options.secretAccessKey) {
      throw new R2StorageError('R2StorageProvider requires both credentials', 0, 'missing_credentials')
    }
    this.opts = options
    this.doFetch = options.fetchImpl ?? fetch
  }

  get endpoint(): string { return this.opts.endpoint }
  get bucket(): string { return this.opts.bucket }

  private async send(method: string, path: string, params: Array<[string, string]> = [], body?: Buffer): Promise<Response> {
    const payloadHash = body ? sha256Hex(body) : EMPTY_SHA256
    const req = sign(this.opts, method, path, params, payloadHash, body)
    let res: Response
    try {
      // The cast is typing only. TypeScript 5.7 types a view over a pooled ArrayBuffer as
      // Uint8Array<ArrayBufferLike>, which does not narrow into BodyInit; undici accepts it.
      const payload = method === 'PUT' ? (req.body as unknown as BodyInit) : undefined
      res = await this.doFetch(req.url, { method: req.method, headers: req.headers, body: payload })
    } catch (e) {
      // A transport failure must not look like a missing object: that is how a dead endpoint
      // becomes an empty corpus, and an empty corpus becomes a silent no-op training job.
      throw new R2StorageError(`storage request failed: ${(e as Error).message}`, 0, 'network')
    }
    if (res.status === 404) return res
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const code = errorCode(text)
      throw new R2StorageError(`storage ${method} ${path} → ${res.status}${code ? ` ${code}` : ''}`, res.status, code)
    }
    return res
  }

  private keyPath(key: string): string { return `/${this.opts.bucket}/${key}` }

  async put(key: string, body: string | Uint8Array): Promise<void> {
    const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body)
    const res = await this.send('PUT', this.keyPath(key), [], buf)
    // S3 reports success for an overwritten object; nothing else to check.
    void res
  }

  async get(key: string): Promise<string | undefined> {
    const res = await this.send('GET', this.keyPath(key))
    // 404 is the only failure that means "absent". Everything else is a fault, and mapping a
    // fault to undefined is how a bucket outage reads as an empty corpus.
    if (res.status === 404) return undefined
    return await res.text()
  }

  /**
   * Every key under `prefix`, sorted.
   *
   * Pages until `IsTruncated` is false. The loop is bounded by a hard iteration ceiling so a
   * server that keeps answering "truncated" with the same token fails loudly instead of
   * spinning forever inside what looks like a slow listing.
   */
  async list(prefix: string): Promise<string[]> {
    const seen = new Set<string>()
    let token: string | undefined
    let pages = 0
    do {
      const params: Array<[string, string]> = [['list-type', '2'], ['max-keys', '1000']]
      if (prefix) params.push(['prefix', prefix])
      if (token) params.push(['continuation-token', token])
      const res = await this.send('GET', `/${this.opts.bucket}`, params)
      const page = parseList(await res.text())
      for (const k of page.keys) seen.add(k)
      // A repeated token means the server is not advancing; refuse rather than loop.
      if (page.truncated && page.token && page.token === token) {
        throw new R2StorageError(`storage list("${prefix}") returned the same continuation token twice`, 0, 'pagination_stall')
      }
      // Only a truncated page continues. Stopping here on the first short answer is the
      // single worst failure this provider could have: the list looks complete.
      token = page.truncated ? page.token : undefined
      if (++pages > 10_000) {
        throw new R2StorageError(`storage list("${prefix}") exceeded ${pages} pages`, 0, 'pagination_runaway')
      }
    } while (token)
    return [...seen].sort()
  }

  async delete(key: string): Promise<boolean> {
    const res = await this.send('DELETE', this.keyPath(key))
    if (res.status === 404) return false
    return true
  }
}
