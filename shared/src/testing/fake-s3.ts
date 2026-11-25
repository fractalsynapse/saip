/**
 * In-process fake S3/R2 endpoint (#198).
 *
 * The contract suite needs an S3-shaped peer, not a mock of `fetch`: what is under test is the
 * request the client *forms* — canonical request, SigV4 signature, `list-type=2` pagination,
 * typed 404 for a missing key. Mocking fetch would only prove the client calls fetch the way it
 * already calls it.
 *
 * The verifier is written **independently** of `src/r2-client.ts` and that duplication is
 * deliberate: if both sides shared one signer, every client signature would validate by
 * construction and the suite's central claim — a wrong canonical request is rejected — could
 * never fail. Two implementations agreeing is evidence; one agreeing with itself is not.
 *
 * Not S3-complete on purpose: no multipart, versioning, ACLs or range reads. Just the surface
 * `StorageProvider` needs, plus the failure modes the provider must handle.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash, createHmac } from 'node:crypto'

export const FAKE_SECRET_KEY = 'test-secret-access-key-value'
export const FAKE_ACCESS_KEY = 'AKIATESTTESTTESTTEST1'
export const PAGE_SIZE = 1000

export interface FakeRequest {
  method: string
  /** Decoded path, e.g. `/bucket/feedback/a.json`. */
  path: string
  query: Record<string, string>
  headers: Record<string, string>
  body: Buffer
}

export interface FakeS3 {
  baseUrl: string
  requests: FakeRequest[]
  close(): Promise<void>
  lastRequestFor(method: string, path: string): { headers: Record<string, string> }
  listRequestsFor(bucket: string, prefix: string): FakeRequest[]
  getObjectRaw(path: string): Buffer | undefined
  /** Next LIST for bucket+prefix returns only `count` keys, marked truncated. */
  truncateNextListPage(bucket: string, prefix: string, count: number): void
  /**
   * Seed objects without going through the client. Pagination tests need thousands of keys and
   * the client's PUT path is covered by the contract suite itself — re-driving it here would
   * only make the suite slow enough that nobody runs it.
   */
  /** Seed one object, bypassing the client. */
  putObject(bucket: string, key: string, body: string): void
  seed(bucket: string, keys: string[], body?: string): void
  keys(): string[]
  /** Drop every object, recorded request and pending fault. One clean bucket per test. */
  reset(): void
  /** Answer the next matching request with a status instead of the object. */
  failNext(method: string, path: string, status: number, code?: string): void
  /** Answer the next LIST for bucket+prefix with the page in deliberately wrong order. */
  shuffleNextList(bucket: string, prefix: string): void
}

const EMPTY_SHA256 = createHash('sha256').update(Buffer.alloc(0)).digest('hex')
const enc = (s: string): string =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
const canonicalUri = (p: string): string => p.split('/').map(enc).join('/')
const canonicalQuery = (q: Record<string, string>): string =>
  Object.entries(q).map(([k, v]) => [enc(k), enc(v)] as const)
    .sort(([a], [b]) => (a === b ? 0 : a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&')
const kdf = (key: Buffer | string, data: string): Buffer => createHmac('sha256', key).update(data).digest()

/** Verify SigV4 for service `s3`. Null authenticates; a string is the reason it did not. */
export function verifySigV4(req: FakeRequest): string | null {
  const head = (req.headers.authorization ?? '').match(/^AWS4-HMAC-SHA256\s+(.*)$/)
  if (!head) return 'Authorization is not AWS4-HMAC-SHA256'
  const parts: Record<string, string> = {}
  for (const piece of head[1].split(',')) {
    const i = piece.indexOf('=')
    if (i > 0) parts[piece.slice(0, i).trim()] = piece.slice(i + 1).trim()
  }
  if (!parts.Credential || !parts.SignedHeaders || !parts.Signature) return 'Authorization elements missing'
  const [accessKey, date, region, service, term] = parts.Credential.split('/')
  if (!accessKey) return 'empty access key in credential'
  if (service !== 's3' || term !== 'aws4_request') return `unexpected credential scope ${parts.Credential}`
  const amzDate = req.headers['x-amz-date']
  if (!amzDate) return 'x-amz-date missing'
  if (!amzDate.startsWith(date)) return 'credential date disagrees with x-amz-date'
  const declared = req.headers['x-amz-content-sha256']
  if (!declared) return 'x-amz-content-sha256 missing (required by SigV4-for-S3)'
  const actual = req.body.length === 0 ? EMPTY_SHA256 : createHash('sha256').update(req.body).digest('hex')
  if (declared !== actual) return 'payload hash does not match the bytes received'

  const names = parts.SignedHeaders.split(';')
  const canonicalHeaders = names.map((n) => `${n}:${(req.headers[n] ?? '').trim()}\n`).join('')
  const canonical = [req.method, canonicalUri(req.path), canonicalQuery(req.query), canonicalHeaders,
    parts.SignedHeaders, declared].join('\n')
  const scope = [date, region, service, 'aws4_request'].join('/')
  const sts = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonical).digest('hex')].join('\n')
  const signing = kdf(kdf(kdf(kdf(`AWS4${FAKE_SECRET_KEY}`, date), region), 's3'), 'aws4_request')
  return kdf(signing, sts).toString('hex') === parts.Signature ? null : 'signature mismatch'
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const errorXml = (code: string, message: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${esc(message)}</Message></Error>`

function listXml(bucket: string, prefix: string, page: string[], truncated: boolean, token?: string): string {
  const contents = page.map((k) => `<Contents><Key>${esc(k)}</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified>`
    + '<ETag>"0"</ETag><Size>1</Size><StorageClass>STANDARD</StorageClass></Contents>').join('')
  return '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
    + `<Name>${esc(bucket)}</Name><Prefix>${esc(prefix)}</Prefix><KeyCount>${page.length}</KeyCount>`
    + `<MaxKeys>${PAGE_SIZE}</MaxKeys><IsTruncated>${truncated}</IsTruncated>`
    + (token ? `<NextContinuationToken>${esc(token)}</NextContinuationToken>` : '') + contents + '</ListBucketResult>'
}

export async function startFakeS3(options: { enforceSignature?: boolean } = {}): Promise<FakeS3> {
  const enforce = options.enforceSignature ?? true
  const objects = new Map<string, Buffer>()
  const requests: FakeRequest[] = []
  const canary = new Map<string, number>()
  const failures = new Map<string, { status: number; code: string }>()
  const shuffles = new Set<string>()

  const server: Server = createServer((raw, res) => {
    const chunks: Buffer[] = []
    raw.on('data', (c: Buffer) => chunks.push(c))
    raw.on('end', () => {
      const body = Buffer.concat(chunks)
      const url = new URL(raw.url ?? '/', 'http://127.0.0.1')
      const headers: Record<string, string> = {}
      for (const [n, v] of Object.entries(raw.headers)) {
        headers[n.toLowerCase()] = Array.isArray(v) ? v.join(',') : String(v ?? '')
      }
      const query: Record<string, string> = {}
      for (const [k, v] of url.searchParams) query[k] = v

      const req: FakeRequest = { method: raw.method ?? 'GET', path: decodeURIComponent(url.pathname), query, headers, body }
      requests.push(req)
      const reply = (status: number, code: string, message: string): void => {
        res.writeHead(status, { 'content-type': 'application/xml' })
        res.end(errorXml(code, message))
      }

      if (enforce) {
        const problem = verifySigV4(req)
        if (problem) return reply(403, 'SignatureDoesNotMatch', problem)
      }

      // Fault injection is checked *after* authentication: a test that forces a 500 still has to
      // sign correctly, or it tests the wrong thing.
      const fault = failures.get(`${req.method} ${req.path}`)
      if (fault) {
        failures.delete(`${req.method} ${req.path}`)
        return reply(fault.status, fault.code, 'injected failure')
      }

      const segments = req.path.split('/').filter(Boolean)
      const bucket = segments[0] ?? ''
      const key = segments.slice(1).join('/')

      if (req.method === 'PUT') {
        objects.set(req.path, body)
        res.writeHead(200, { etag: `"${createHash('md5').update(body).digest('hex')}"` })
        return res.end()
      }
      if (req.method === 'DELETE') {
        if (!objects.has(req.path)) return reply(404, 'NoSuchKey', 'The specified key does not exist.')
        objects.delete(req.path)
        res.writeHead(204)
        return res.end()
      }
      if (req.method === 'GET' && key === '') {
        if (query['list-type'] !== '2') return reply(400, 'InvalidRequest', 'only list-type=2 is implemented')
        const prefix = query.prefix ?? ''
        const all = [...objects.keys()].filter((p) => p.startsWith(`/${bucket}/`))
          .map((p) => p.slice(bucket.length + 2)).filter((k) => k.startsWith(prefix)).sort()
        const token = query['continuation-token']
        const start = token ? all.indexOf(token) + 1 : 0
        const rest = all.slice(Math.max(start, 0))
        const limitKey = `${bucket}|${prefix}|${token ?? ''}`
        const forced = canary.get(limitKey)
        if (forced !== undefined) canary.delete(limitKey)
        const size = forced ?? Math.min(PAGE_SIZE, rest.length)
        let page = rest.slice(0, size)
        // A real S3 answers in lexicographic order. Shuffling here checks that the provider
        // honors its own documented contract (`list()` returns sorted) instead of inheriting the
        // server's good behaviour by luck.
        if (shuffles.has(`${bucket}|${prefix}`)) {
          shuffles.delete(`${bucket}|${prefix}`)
          page = [...page].reverse()
        }
        const truncated = page.length < rest.length
        res.writeHead(200, { 'content-type': 'application/xml' })
        return res.end(listXml(bucket, prefix, page, truncated, truncated ? page[page.length - 1] : undefined))
      }
      if (req.method === 'GET') {
        const found = objects.get(req.path)
        if (!found) return reply(404, 'NoSuchKey', 'The specified key does not exist.')
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        return res.end(found)
      }
      return reply(405, 'MethodNotAllowed', `unsupported method ${req.method}`)
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  return {
    baseUrl,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
    lastRequestFor: (method, path) => {
      const found = [...requests].reverse().find((r) => r.method === method && r.path === path)
      if (!found) throw new Error(`fake saw no ${method} ${path}; saw ${requests.map((r) => `${r.method} ${r.path}`).join(', ') || 'nothing'}`)
      return { headers: found.headers }
    },
    listRequestsFor: (bucket, prefix) => requests.filter((r) =>
      r.method === 'GET' && r.path === `/${bucket}` && r.query['list-type'] === '2' && (r.query.prefix ?? '') === prefix),
    getObjectRaw: (path) => objects.get(path),
    truncateNextListPage: (bucket, prefix, count) => void canary.set(`${bucket}|${prefix}|`, count),
    putObject: (bucket, key, body) => void objects.set(`/${bucket}/${key}`, Buffer.from(body, 'utf8')),
    seed: (bucket, keys, body = 'x') => {
      for (const k of keys) objects.set(`/${bucket}/${k}`, Buffer.from(body, 'utf8'))
    },
    keys: () => [...objects.keys()],
    reset: () => { objects.clear(); requests.length = 0; canary.clear(); failures.clear(); shuffles.clear() },
    failNext: (method, path, status, code = 'InternalError') => void failures.set(`${method} ${path}`, { status, code }),
    shuffleNextList: (bucket, prefix) => void shuffles.add(`${bucket}|${prefix}`),
  }
}
