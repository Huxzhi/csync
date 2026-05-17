// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createS3Adapter } from '../../src/adapters/s3.js'

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

beforeEach(() => {
  vi.unstubAllGlobals()
})

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
    const result = await adapter.uploadFile({ path: 'notes/a.json', hash: '', updatedAt: 0 }, content)
    expect(result.hash).toBe('upload-etag')
    expect(result.path).toBe('notes/a.json')
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
    await adapter.uploadFile({ path: 'notes/a.json', hash: '', updatedAt: 0 }, new ArrayBuffer(0))
    expect(capturedMethod).toBe('PUT')
    expect(capturedAuth).toMatch(/^AWS4-HMAC-SHA256/)
  })
})

describe('downloadFile()', () => {
  it('GETs the file and returns an ArrayBuffer', async () => {
    const body = 'binary content'
    mockFetch(() => ({ ok: true, status: 200, body }))
    const adapter = createS3Adapter(OPTS)
    const { content, meta } = await adapter.downloadFile('notes/a.json')
    expect(new TextDecoder().decode(content)).toBe(body)
    expect(meta.path).toBe('notes/a.json')
    expect(typeof meta.hash).toBe('string')
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
