// @vitest-environment happy-dom
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

beforeEach(() => {
  vi.unstubAllGlobals()
})

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
