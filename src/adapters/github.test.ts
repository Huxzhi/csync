import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createGitHubAdapter } from './github.js'

const OPTS = { owner: 'alice', repo: 'vault', branch: 'main', token: 'tok', basePath: 'data' }

function mockFetch(handler: (url: string, init?: RequestInit) => unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = handler(url, init)
      return {
        ok: true,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body)),
      }
    }),
  )
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

describe('getRemoteManifest()', () => {
  it('returns SyncMetadata for each blob under basePath', async () => {
    mockFetch(url => {
      if (url.includes('/branches/')) {
        return { commit: { commit: { tree: { sha: 'tree-sha' } } } }
      }
      return {
        tree: [
          { type: 'blob', path: 'data/notes/a.json', sha: 'sha1' },
          { type: 'blob', path: 'data/notes/b.json', sha: 'sha2' },
          { type: 'tree', path: 'data/notes', sha: 'tree1' },
        ],
        truncated: false,
      }
    })
    const adapter = createGitHubAdapter(OPTS)
    const manifest = await adapter.getRemoteManifest()
    expect(manifest).toEqual([
      { path: 'notes/a.json', hash: 'sha1', updatedAt: 0 },
      { path: 'notes/b.json', hash: 'sha2', updatedAt: 0 },
    ])
  })
})

describe('uploadFile()', () => {
  it('PUTs content and returns the blob SHA from the response', async () => {
    let capturedBody: Record<string, unknown> | null = null
    mockFetch((url, init) => {
      if (init?.method === 'PUT') {
        capturedBody = JSON.parse(init.body as string)
        return { content: { sha: 'new-sha' } }
      }
      return { status: 404, ok: false }
    })
    const adapter = createGitHubAdapter(OPTS)
    const result = await adapter.uploadFile('notes/a.json', '{"text":"hello"}')
    expect(result).toEqual({ hash: 'new-sha' })
    expect(capturedBody?.content).toBe(btoa('{"text":"hello"}'))
    expect(capturedBody?.branch).toBe('main')
  })
})

describe('downloadFile()', () => {
  it('fetches, base64-decodes, and JSON-parses the file content', async () => {
    mockFetch(() => ({
      content: btoa(JSON.stringify({ text: 'hello' })),
      encoding: 'base64',
    }))
    const adapter = createGitHubAdapter(OPTS)
    const data = await adapter.downloadFile('notes/a.json')
    expect(data).toEqual({ text: 'hello' })
  })
})

describe('deleteFile()', () => {
  it('GETs the current SHA then DELETEs with it', async () => {
    const calls: string[] = []
    mockFetch((url, init) => {
      calls.push(init?.method ?? 'GET')
      if (init?.method === 'DELETE') return {}
      return { sha: 'current-sha' }
    })
    const adapter = createGitHubAdapter(OPTS)
    await adapter.deleteFile('notes/a.json')
    expect(calls).toEqual(['GET', 'DELETE'])
  })
})

describe('error handling', () => {
  it('throws on non-ok HTTP responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 403,
      text: () => Promise.resolve('Forbidden'),
    })))
    const adapter = createGitHubAdapter(OPTS)
    await expect(adapter.getRemoteManifest()).rejects.toThrow('403')
  })
})
