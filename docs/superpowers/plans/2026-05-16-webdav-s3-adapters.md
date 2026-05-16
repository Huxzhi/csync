# WebDAV & S3 Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `createWebDAVAdapter` and `createS3Adapter` to csync, each implementing `RemoteRepositoryAdapter` using native browser APIs only.

**Architecture:** Two independent factory functions mirroring `createGitHubAdapter`. WebDAV uses `PROPFIND`+`DOMParser` for listing, Basic Auth, ETag as hash. S3 uses `ListObjectsV2`+`DOMParser` for listing, AWS SigV4 via `crypto.subtle`, ETag as hash.

**Tech Stack:** TypeScript 5, native fetch, DOMParser (browser), crypto.subtle (WebCrypto), Vitest + vi.stubGlobal

---

## File Map

| File | Responsibility |
|---|---|
| `src/adapters/webdav.ts` | WebDAV adapter — PROPFIND/PUT/GET/DELETE + Basic Auth |
| `src/adapters/webdav.test.ts` | Vitest tests for WebDAV adapter |
| `src/adapters/s3.ts` | S3 adapter — ListObjectsV2/PUT/GET/DELETE + SigV4 signing |
| `src/adapters/s3.test.ts` | Vitest tests for S3 adapter |
| `package.json` | Add `./adapters/webdav` and `./adapters/s3` export entries |
| `tsup.config.ts` | Add webdav and s3 build entry points |

---

## Task 1: Config — package.json + tsup.config.ts

**Files:**
- Modify: `package.json`
- Modify: `tsup.config.ts`

- [ ] **Step 1: Update package.json exports**

Replace the `exports` field with:

```json
"exports": {
  ".": {
    "import": "./dist/index.js",
    "types": "./dist/index.d.ts"
  },
  "./adapters/github": {
    "import": "./dist/adapters/github.js",
    "types": "./dist/adapters/github.d.ts"
  },
  "./adapters/webdav": {
    "import": "./dist/adapters/webdav.js",
    "types": "./dist/adapters/webdav.d.ts"
  },
  "./adapters/s3": {
    "import": "./dist/adapters/s3.js",
    "types": "./dist/adapters/s3.d.ts"
  }
}
```

- [ ] **Step 2: Update tsup.config.ts entry points**

Replace the `entry` object with:

```ts
entry: {
  index: 'src/index.ts',
  'adapters/github': 'src/adapters/github.ts',
  'adapters/webdav': 'src/adapters/webdav.ts',
  'adapters/s3': 'src/adapters/s3.ts',
},
```

- [ ] **Step 3: Commit**

```bash
git add package.json tsup.config.ts
git commit -m "chore: add webdav and s3 adapter export entries"
```

---

## Task 2: WebDAV Adapter

**Files:**
- Create: `src/adapters/webdav.ts`
- Create: `src/adapters/webdav.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/adapters/webdav.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWebDAVAdapter } from './webdav.js'

const OPTS = {
  baseUrl: 'https://cloud.example.com/remote.php/dav/files/user',
  username: 'alice',
  password: 'secret',
  basePath: 'data',
}

type FakeResponse = { status?: number; ok?: boolean; body?: string; headers?: Record<string, string> }

function mockFetch(handler: (url: string, init?: RequestInit) => FakeResponse) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const { status = 207, ok = true, body = '', headers = {} } = handler(url, init)
      return {
        ok,
        status,
        text: () => Promise.resolve(body),
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode(body).buffer as ArrayBuffer),
        headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      }
    }),
  )
}

beforeEach(() => { vi.unstubAllGlobals() })

describe('getRemoteManifest()', () => {
  it('returns SyncMetadata for files and skips collection (directory) entries', async () => {
    mockFetch(() => ({
      body: `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/remote.php/dav/files/user/data/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/></D:resourcetype>
        <D:getetag>"dir-etag"</D:getetag>
      </D:prop>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/remote.php/dav/files/user/data/notes/a.json</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype/>
        <D:getetag>"etag1"</D:getetag>
      </D:prop>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/remote.php/dav/files/user/data/notes/b.json</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype/>
        <D:getetag>"etag2"</D:getetag>
      </D:prop>
    </D:propstat>
  </D:response>
</D:multistatus>`,
    }))
    const adapter = createWebDAVAdapter(OPTS)
    const manifest = await adapter.getRemoteManifest()
    expect(manifest).toEqual([
      { path: 'notes/a.json', hash: 'etag1', updatedAt: 0 },
      { path: 'notes/b.json', hash: 'etag2', updatedAt: 0 },
    ])
  })

  it('returns empty array when directory does not exist (404)', async () => {
    mockFetch(() => ({ ok: false, status: 404, body: 'Not Found' }))
    const adapter = createWebDAVAdapter(OPTS)
    const manifest = await adapter.getRemoteManifest()
    expect(manifest).toEqual([])
  })

  it('sends correct PROPFIND method and Basic Auth header', async () => {
    let capturedMethod = ''
    let capturedAuth = ''
    mockFetch((_, init) => {
      capturedMethod = init?.method ?? ''
      capturedAuth = (init?.headers as Record<string, string>)?.authorization ?? ''
      return { body: '<D:multistatus xmlns:D="DAV:"/>' }
    })
    const adapter = createWebDAVAdapter(OPTS)
    await adapter.getRemoteManifest()
    expect(capturedMethod).toBe('PROPFIND')
    expect(capturedAuth).toBe(`Basic ${btoa('alice:secret')}`)
  })

  it('throws on non-404 error responses', async () => {
    mockFetch(() => ({ ok: false, status: 401, body: 'Unauthorized' }))
    const adapter = createWebDAVAdapter(OPTS)
    await expect(adapter.getRemoteManifest()).rejects.toThrow('401')
  })
})

describe('uploadFile()', () => {
  it('PUTs the file and returns ETag from HEAD response', async () => {
    mockFetch((_, init) => {
      if (init?.method === 'HEAD') return { ok: true, status: 200, headers: { etag: '"new-etag"' } }
      return { ok: true, status: 204 }
    })
    const adapter = createWebDAVAdapter(OPTS)
    const content = new TextEncoder().encode('hello').buffer as ArrayBuffer
    const result = await adapter.uploadFile('notes/a.json', content)
    expect(result).toEqual({ hash: 'new-etag' })
  })

  it('falls back to currentHash when HEAD returns no ETag', async () => {
    mockFetch(() => ({ ok: true, status: 200, headers: {} }))
    const adapter = createWebDAVAdapter(OPTS)
    const content = new ArrayBuffer(0)
    const result = await adapter.uploadFile('notes/a.json', content, 'fallback-hash')
    expect(result).toEqual({ hash: 'fallback-hash' })
  })
})

describe('downloadFile()', () => {
  it('GETs the file and returns an ArrayBuffer', async () => {
    const body = '{"hello":"world"}'
    mockFetch(() => ({ ok: true, status: 200, body }))
    const adapter = createWebDAVAdapter(OPTS)
    const result = await adapter.downloadFile('notes/a.json')
    expect(new TextDecoder().decode(result)).toBe(body)
  })
})

describe('deleteFile()', () => {
  it('sends DELETE to the correct URL', async () => {
    let capturedUrl = ''
    let capturedMethod = ''
    mockFetch((url, init) => {
      capturedUrl = url
      capturedMethod = init?.method ?? ''
      return { ok: true, status: 204 }
    })
    const adapter = createWebDAVAdapter(OPTS)
    await adapter.deleteFile('notes/a.json')
    expect(capturedMethod).toBe('DELETE')
    expect(capturedUrl).toBe(
      'https://cloud.example.com/remote.php/dav/files/user/data/notes/a.json',
    )
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/huxzhi/4-code/csync && npx vitest run src/adapters/webdav.test.ts
```

Expected: FAIL — `Cannot find module './webdav.js'`

- [ ] **Step 3: Implement `src/adapters/webdav.ts`**

```ts
import type { RemoteRepositoryAdapter, SyncMetadata } from '../types.js'

export interface WebDAVAdapterOptions {
  baseUrl: string
  username: string
  password: string
  basePath?: string
}

const DAV_NS = 'DAV:'

export function createWebDAVAdapter(options: WebDAVAdapterOptions): RemoteRepositoryAdapter {
  const { baseUrl, username, password, basePath = 'data' } = options

  const authHeader = `Basic ${btoa(`${username}:${password}`)}`
  const baseUrlPath = new URL(baseUrl).pathname
  const remoteBase = `${baseUrl}/${basePath}`
  const manifestPrefix = `${baseUrlPath}/${basePath}/`

  async function request(url: string, init: RequestInit = {}): Promise<Response> {
    return fetch(url, {
      ...init,
      headers: {
        authorization: authHeader,
        ...(init.headers as Record<string, string> | undefined),
      },
    })
  }

  function stripEtag(raw: string | null): string {
    return raw ? raw.replace(/^"|"$/g, '') : ''
  }

  return {
    async getRemoteManifest(): Promise<SyncMetadata[]> {
      const res = await request(`${remoteBase}/`, {
        method: 'PROPFIND',
        headers: {
          depth: 'infinity',
          'content-type': 'application/xml; charset=utf-8',
        },
        body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>',
      })

      if (res.status === 404) return []
      if (!res.ok) throw new Error(`WebDAV ${res.status}: ${await res.text().catch(() => '')}`)

      const doc = new DOMParser().parseFromString(await res.text(), 'text/xml')
      const responses = Array.from(doc.getElementsByTagNameNS(DAV_NS, 'response'))
      const result: SyncMetadata[] = []

      for (const response of responses) {
        if (response.getElementsByTagNameNS(DAV_NS, 'collection').length > 0) continue

        const href = decodeURIComponent(
          response.getElementsByTagNameNS(DAV_NS, 'href')[0]?.textContent ?? '',
        )
        const hash = stripEtag(
          response.getElementsByTagNameNS(DAV_NS, 'getetag')[0]?.textContent ?? null,
        )
        if (!href.startsWith(manifestPrefix) || !hash) continue

        result.push({ path: href.slice(manifestPrefix.length), hash, updatedAt: 0 })
      }

      return result
    },

    async uploadFile(path: string, content: ArrayBuffer, currentHash?: string): Promise<{ hash: string }> {
      const url = `${remoteBase}/${path}`

      const putRes = await request(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: content,
      })
      if (!putRes.ok) throw new Error(`WebDAV ${putRes.status}: ${await putRes.text().catch(() => '')}`)

      const headRes = await request(url, { method: 'HEAD' })
      const etag = stripEtag(headRes.headers.get('etag'))
      if (etag) return { hash: etag }
      if (currentHash) return { hash: currentHash }
      throw new Error(`WebDAV: server did not return ETag for ${path}`)
    },

    async downloadFile(path: string): Promise<ArrayBuffer> {
      const res = await request(`${remoteBase}/${path}`)
      if (!res.ok) throw new Error(`WebDAV ${res.status}: ${await res.text().catch(() => '')}`)
      return res.arrayBuffer()
    },

    async deleteFile(path: string): Promise<void> {
      const res = await request(`${remoteBase}/${path}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`WebDAV ${res.status}: ${await res.text().catch(() => '')}`)
    },
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/huxzhi/4-code/csync && npx vitest run src/adapters/webdav.test.ts
```

Expected: PASS — all 8 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/webdav.ts src/adapters/webdav.test.ts
git commit -m "feat: WebDAV remote adapter with PROPFIND listing and Basic Auth"
```

---

## Task 3: S3 Adapter

**Files:**
- Create: `src/adapters/s3.ts`
- Create: `src/adapters/s3.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/adapters/s3.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createS3Adapter } from './s3.js'

const OPTS = {
  bucket: 'my-bucket',
  region: 'us-east-1',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  endpoint: 'https://my-bucket.s3.us-east-1.amazonaws.com',
  basePath: 'data',
}

type FakeResponse = { status?: number; ok?: boolean; body?: string; headers?: Record<string, string> }

function mockFetch(handler: (url: string, init?: RequestInit) => FakeResponse) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const { status = 200, ok = true, body = '', headers = {} } = handler(url, init)
      return {
        ok,
        status,
        text: () => Promise.resolve(body),
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode(body).buffer as ArrayBuffer),
        headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      }
    }),
  )
}

beforeEach(() => { vi.unstubAllGlobals() })

describe('getRemoteManifest()', () => {
  it('parses ListObjectsV2 XML and strips basePath prefix', async () => {
    mockFetch(() => ({
      body: `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Contents>
    <Key>data/notes/a.json</Key>
    <ETag>&quot;md5hash1&quot;</ETag>
  </Contents>
  <Contents>
    <Key>data/notes/b.json</Key>
    <ETag>&quot;md5hash2&quot;</ETag>
  </Contents>
  <IsTruncated>false</IsTruncated>
</ListBucketResult>`,
    }))
    const adapter = createS3Adapter(OPTS)
    const manifest = await adapter.getRemoteManifest()
    expect(manifest).toEqual([
      { path: 'notes/a.json', hash: 'md5hash1', updatedAt: 0 },
      { path: 'notes/b.json', hash: 'md5hash2', updatedAt: 0 },
    ])
  })

  it('follows NextContinuationToken for pagination', async () => {
    let callCount = 0
    mockFetch((url) => {
      callCount++
      if (callCount === 1) {
        return {
          body: `<ListBucketResult>
  <Contents><Key>data/a.json</Key><ETag>&quot;h1&quot;</ETag></Contents>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>token123</NextContinuationToken>
</ListBucketResult>`,
        }
      }
      expect(url).toContain('continuation-token=token123')
      return {
        body: `<ListBucketResult>
  <Contents><Key>data/b.json</Key><ETag>&quot;h2&quot;</ETag></Contents>
  <IsTruncated>false</IsTruncated>
</ListBucketResult>`,
      }
    })
    const adapter = createS3Adapter(OPTS)
    const manifest = await adapter.getRemoteManifest()
    expect(manifest).toHaveLength(2)
    expect(callCount).toBe(2)
  })

  it('includes SigV4 Authorization header with correct credential scope', async () => {
    let capturedAuth = ''
    mockFetch((_, init) => {
      capturedAuth = (init?.headers as Record<string, string>)?.authorization ?? ''
      return { body: '<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>' }
    })
    const adapter = createS3Adapter(OPTS)
    await adapter.getRemoteManifest()
    expect(capturedAuth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\//)
    expect(capturedAuth).toContain('/us-east-1/s3/aws4_request')
    expect(capturedAuth).toContain('SignedHeaders=')
    expect(capturedAuth).toContain('Signature=')
  })
})

describe('uploadFile()', () => {
  it('PUTs the file and returns ETag from response header', async () => {
    mockFetch(() => ({ ok: true, status: 200, headers: { etag: '"upload-etag"' } }))
    const adapter = createS3Adapter(OPTS)
    const content = new TextEncoder().encode('{"key":"val"}').buffer as ArrayBuffer
    const result = await adapter.uploadFile('notes/a.json', content)
    expect(result).toEqual({ hash: 'upload-etag' })
  })

  it('sends PUT with SigV4 Authorization header', async () => {
    let capturedAuth = ''
    let capturedMethod = ''
    mockFetch((_, init) => {
      capturedAuth = (init?.headers as Record<string, string>)?.authorization ?? ''
      capturedMethod = init?.method ?? ''
      return { headers: { etag: '"e"' } }
    })
    const adapter = createS3Adapter(OPTS)
    await adapter.uploadFile('notes/a.json', new ArrayBuffer(0))
    expect(capturedMethod).toBe('PUT')
    expect(capturedAuth).toMatch(/^AWS4-HMAC-SHA256/)
  })
})

describe('downloadFile()', () => {
  it('GETs the file and returns an ArrayBuffer', async () => {
    const body = 'binary content'
    mockFetch(() => ({ ok: true, status: 200, body }))
    const adapter = createS3Adapter(OPTS)
    const result = await adapter.downloadFile('notes/a.json')
    expect(new TextDecoder().decode(result)).toBe(body)
  })
})

describe('deleteFile()', () => {
  it('sends DELETE with SigV4 auth to the correct path', async () => {
    let capturedUrl = ''
    let capturedMethod = ''
    let capturedAuth = ''
    mockFetch((url, init) => {
      capturedUrl = url
      capturedMethod = init?.method ?? ''
      capturedAuth = (init?.headers as Record<string, string>)?.authorization ?? ''
      return { ok: true, status: 204 }
    })
    const adapter = createS3Adapter(OPTS)
    await adapter.deleteFile('notes/a.json')
    expect(capturedMethod).toBe('DELETE')
    expect(capturedUrl).toContain('/data/notes/a.json')
    expect(capturedAuth).toMatch(/^AWS4-HMAC-SHA256/)
  })
})

describe('error handling', () => {
  it('throws on non-2xx responses', async () => {
    mockFetch(() => ({
      ok: false,
      status: 403,
      body: '<Error><Code>AccessDenied</Code></Error>',
    }))
    const adapter = createS3Adapter(OPTS)
    await expect(adapter.getRemoteManifest()).rejects.toThrow('403')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/huxzhi/4-code/csync && npx vitest run src/adapters/s3.test.ts
```

Expected: FAIL — `Cannot find module './s3.js'`

- [ ] **Step 3: Implement `src/adapters/s3.ts`**

```ts
import type { RemoteRepositoryAdapter, SyncMetadata } from '../types.js'

export interface S3AdapterOptions {
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  endpoint?: string
  basePath?: string
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

async function sha256(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  const bytes =
    typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)
  return toHex(await crypto.subtle.digest('SHA-256', bytes))
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data))
}

function getDatetime(): { datetime: string; date: string } {
  const datetime = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z'
  return { datetime, date: datetime.slice(0, 8) }
}

function encodeUriPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

function stripEtag(raw: string | null): string {
  return raw ? raw.replace(/^"|"$/g, '') : ''
}

async function buildAuthHeaders(
  method: string,
  url: URL,
  body: ArrayBuffer | string,
  region: string,
  accessKeyId: string,
  secretAccessKey: string,
): Promise<Record<string, string>> {
  const { datetime, date } = getDatetime()
  const payloadHash = await sha256(body)

  const baseHeaders: Record<string, string> = {
    host: url.host,
    'x-amz-date': datetime,
    'x-amz-content-sha256': payloadHash,
  }

  const sortedNames = Object.keys(baseHeaders).sort()
  const canonicalHeaders = sortedNames.map(k => `${k}:${baseHeaders[k]}`).join('\n') + '\n'
  const signedHeaders = sortedNames.join(';')

  const canonicalUri = encodeUriPath(url.pathname || '/')
  const canonicalQueryString = [...url.searchParams.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')

  const canonicalRequest = [
    method, canonicalUri, canonicalQueryString,
    canonicalHeaders, signedHeaders, payloadHash,
  ].join('\n')

  const credentialScope = `${date}/${region}/s3/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256', datetime, credentialScope, await sha256(canonicalRequest),
  ].join('\n')

  const kDate = await hmac(new TextEncoder().encode(`AWS4${secretAccessKey}`), date)
  const kRegion = await hmac(kDate, region)
  const kService = await hmac(kRegion, 's3')
  const kSigning = await hmac(kService, 'aws4_request')
  const signature = toHex(await hmac(kSigning, stringToSign))

  return {
    ...baseHeaders,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }
}

function parseListXml(xml: string, prefix: string): { items: SyncMetadata[]; nextToken: string | null } {
  const doc = new DOMParser().parseFromString(xml, 'text/xml')
  const contents = Array.from(doc.getElementsByTagName('Contents'))
  const items: SyncMetadata[] = contents.flatMap(c => {
    const key = c.getElementsByTagName('Key')[0]?.textContent ?? ''
    const etag = c.getElementsByTagName('ETag')[0]?.textContent ?? ''
    if (!key.startsWith(prefix)) return []
    return [{ path: key.slice(prefix.length), hash: stripEtag(etag), updatedAt: 0 }]
  })
  const nextToken = doc.getElementsByTagName('NextContinuationToken')[0]?.textContent ?? null
  return { items, nextToken }
}

export function createS3Adapter(options: S3AdapterOptions): RemoteRepositoryAdapter {
  const { region, accessKeyId, secretAccessKey, basePath = 'data' } = options
  const endpoint = (options.endpoint ?? `https://${options.bucket}.s3.${region}.amazonaws.com`).replace(/\/$/, '')
  const keyPrefix = `${basePath}/`

  async function s3Fetch(
    method: string,
    key: string,
    params: Record<string, string> = {},
    body: ArrayBuffer | string = '',
  ): Promise<Response> {
    const url = new URL(key ? `${endpoint}/${key}` : `${endpoint}/`)
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)

    const headers = await buildAuthHeaders(method, url, body, region, accessKeyId, secretAccessKey)

    return fetch(url.toString(), {
      method,
      headers,
      ...(method === 'PUT' ? { body } : {}),
    })
  }

  return {
    async getRemoteManifest(): Promise<SyncMetadata[]> {
      const all: SyncMetadata[] = []
      let continuationToken: string | null = null

      do {
        const params: Record<string, string> = { 'list-type': '2', prefix: keyPrefix }
        if (continuationToken) params['continuation-token'] = continuationToken

        const res = await s3Fetch('GET', '', params)
        if (!res.ok) throw new Error(`S3 ${res.status}: ${await res.text().catch(() => '')}`)

        const { items, nextToken } = parseListXml(await res.text(), keyPrefix)
        all.push(...items)
        continuationToken = nextToken
      } while (continuationToken)

      return all
    },

    async uploadFile(path: string, content: ArrayBuffer): Promise<{ hash: string }> {
      const res = await s3Fetch('PUT', `${basePath}/${path}`, {}, content)
      if (!res.ok) throw new Error(`S3 ${res.status}: ${await res.text().catch(() => '')}`)
      return { hash: stripEtag(res.headers.get('etag')) }
    },

    async downloadFile(path: string): Promise<ArrayBuffer> {
      const res = await s3Fetch('GET', `${basePath}/${path}`)
      if (!res.ok) throw new Error(`S3 ${res.status}: ${await res.text().catch(() => '')}`)
      return res.arrayBuffer()
    },

    async deleteFile(path: string): Promise<void> {
      const res = await s3Fetch('DELETE', `${basePath}/${path}`)
      if (!res.ok) throw new Error(`S3 ${res.status}: ${await res.text().catch(() => '')}`)
    },
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/huxzhi/4-code/csync && npx vitest run src/adapters/s3.test.ts
```

Expected: PASS — all 8 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/s3.ts src/adapters/s3.test.ts
git commit -m "feat: S3 remote adapter with SigV4 signing via WebCrypto"
```

---

## Task 4: Build Verification

- [ ] **Step 1: Run full test suite**

```bash
cd /home/huxzhi/4-code/csync && npx vitest run
```

Expected: all tests pass across all test files, 0 failures.

- [ ] **Step 2: Type check**

```bash
cd /home/huxzhi/4-code/csync && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Build**

```bash
cd /home/huxzhi/4-code/csync && npm run build
```

Expected: exits without error.

- [ ] **Step 4: Verify dist output**

```bash
ls /home/huxzhi/4-code/csync/dist/adapters/
```

Expected output includes:
```
github.d.ts  github.js  github.js.map
s3.d.ts      s3.js      s3.js.map
webdav.d.ts  webdav.js  webdav.js.map
```
