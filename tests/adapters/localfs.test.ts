import { beforeEach, describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createLocalFSAdapter } from '../../src/adapters/localfs.js'

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
})

// ── Mock helpers ─────────────────────────────────────────────────────────────

function makeFileHandle(name: string, initialContent = '', initialMtime = 1000) {
  let buf = new TextEncoder().encode(initialContent).buffer as ArrayBuffer
  let mtime = initialMtime
  let pendingBuf: ArrayBuffer | undefined

  return {
    kind: 'file' as const,
    name,
    getFile: async () => ({
      arrayBuffer: async () => buf,
      lastModified: mtime,
      size: buf.byteLength,
    }),
    createWritable: async () => ({
      write: async (data: ArrayBuffer) => { pendingBuf = data },
      close: async () => {
        if (pendingBuf !== undefined) {
          buf = pendingBuf
          mtime = Date.now()
          pendingBuf = undefined
        }
      },
    }),
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeDirHandle(name: string, children: Map<string, any>) {
  return {
    kind: 'directory' as const,
    name,
    async *values() { yield* children.values() },
    getFileHandle: async (n: string, opts?: { create?: boolean }) => {
      if (children.has(n)) return children.get(n)
      if (opts?.create) {
        const fh = makeFileHandle(n)
        children.set(n, fh)
        return fh
      }
      throw new Error(`NotFoundError: ${n}`)
    },
    getDirectoryHandle: async (n: string, opts?: { create?: boolean }) => {
      if (children.has(n)) return children.get(n)
      if (opts?.create) {
        const dh = makeDirHandle(n, new Map())
        children.set(n, dh)
        return dh
      }
      throw new Error(`NotFoundError: ${n}`)
    },
    removeEntry: async (n: string) => {
      if (!children.has(n)) throw new Error(`NotFoundError: ${n}`)
      children.delete(n)
    },
  }
}

function asDir(h: ReturnType<typeof makeDirHandle>): FileSystemDirectoryHandle {
  return h as unknown as FileSystemDirectoryHandle
}

// ── getRemoteManifest() ───────────────────────────────────────────────────────

describe('getRemoteManifest()', () => {
  it('returns SyncMetadata for each file with empty hash on first scan', async () => {
    const root = makeDirHandle('root', new Map([
      ['a.json', makeFileHandle('a.json', 'aaa', 1000)],
      ['b.json', makeFileHandle('b.json', 'bbb', 2000)],
    ]))
    const adapter = createLocalFSAdapter({ handle: asDir(root), dbName: 'test-manifest-1' })
    const manifest = await adapter.getRemoteManifest()
    expect(manifest).toHaveLength(2)
    const a = manifest.find(m => m.path === 'a.json')!
    expect(a.hash).toBe('')
    expect(a.updatedAt).toBe(1000)
  })

  it('recurses into subdirectories', async () => {
    const sub = makeDirHandle('notes', new Map([
      ['c.json', makeFileHandle('c.json', 'ccc', 3000)],
    ]))
    const root = makeDirHandle('root', new Map([['notes', sub]]))
    const adapter = createLocalFSAdapter({ handle: asDir(root), dbName: 'test-manifest-2' })
    const manifest = await adapter.getRemoteManifest()
    expect(manifest).toHaveLength(1)
    expect(manifest[0].path).toBe('notes/c.json')
    expect(manifest[0].updatedAt).toBe(3000)
  })

  it('returns cached hash when lastModified and size match after a download', async () => {
    const fh = makeFileHandle('a.json', 'hello', 1000)
    const root = makeDirHandle('root', new Map([['a.json', fh]]))
    const adapter = createLocalFSAdapter({ handle: asDir(root), dbName: 'test-manifest-3' })
    const { meta } = await adapter.downloadFile('a.json')
    const manifest = await adapter.getRemoteManifest()
    expect(manifest[0].hash).toBe(meta.hash)
    expect(manifest[0].hash).toHaveLength(64)
  })

  it('respects basePath — only walks that subdirectory, paths are relative to it', async () => {
    const sub = makeDirHandle('data', new Map([
      ['note.json', makeFileHandle('note.json', 'x', 1000)],
    ]))
    const root = makeDirHandle('root', new Map([
      ['data', sub],
      ['other.json', makeFileHandle('other.json', 'y', 2000)],
    ]))
    const adapter = createLocalFSAdapter({
      handle: asDir(root),
      basePath: 'data',
      dbName: 'test-manifest-4',
    })
    const manifest = await adapter.getRemoteManifest()
    expect(manifest).toHaveLength(1)
    expect(manifest[0].path).toBe('note.json')
  })
})

// ── downloadFile() ────────────────────────────────────────────────────────────

describe('downloadFile()', () => {
  it('reads file content and returns SHA-256 hash with mtime', async () => {
    const fh = makeFileHandle('a.json', 'hello world', 5000)
    const root = makeDirHandle('root', new Map([['a.json', fh]]))
    const adapter = createLocalFSAdapter({ handle: asDir(root), dbName: 'test-dl-1' })
    const { content, meta } = await adapter.downloadFile('a.json')
    expect(new TextDecoder().decode(content)).toBe('hello world')
    expect(meta.path).toBe('a.json')
    expect(meta.hash).toHaveLength(64)
    expect(meta.hash).toMatch(/^[0-9a-f]+$/)
    expect(meta.updatedAt).toBe(5000)
  })

  it('navigates nested paths', async () => {
    const fh = makeFileHandle('note.json', 'data', 1000)
    const sub = makeDirHandle('notes', new Map([['note.json', fh]]))
    const root = makeDirHandle('root', new Map([['notes', sub]]))
    const adapter = createLocalFSAdapter({ handle: asDir(root), dbName: 'test-dl-2' })
    const { meta } = await adapter.downloadFile('notes/note.json')
    expect(meta.path).toBe('notes/note.json')
  })

  it('navigates into basePath for the file', async () => {
    const fh = makeFileHandle('note.json', 'data', 1000)
    const sub = makeDirHandle('data', new Map([['note.json', fh]]))
    const root = makeDirHandle('root', new Map([['data', sub]]))
    const adapter = createLocalFSAdapter({ handle: asDir(root), basePath: 'data', dbName: 'test-dl-3' })
    const { meta } = await adapter.downloadFile('note.json')
    expect(meta.path).toBe('note.json')
  })

  it('hash is deterministic — same content same hash', async () => {
    const fh1 = makeFileHandle('a.json', 'same', 1000)
    const fh2 = makeFileHandle('b.json', 'same', 2000)
    const root = makeDirHandle('root', new Map([['a.json', fh1], ['b.json', fh2]]))
    const adapter = createLocalFSAdapter({ handle: asDir(root), dbName: 'test-dl-4' })
    const { meta: m1 } = await adapter.downloadFile('a.json')
    const { meta: m2 } = await adapter.downloadFile('b.json')
    expect(m1.hash).toBe(m2.hash)
  })
})

// ── uploadFile() ──────────────────────────────────────────────────────────────

describe('uploadFile()', () => {
  it('writes content and returns path + SHA-256 hash + OS mtime', async () => {
    const fh = makeFileHandle('new.json')
    const root = makeDirHandle('root', new Map([['new.json', fh]]))
    const adapter = createLocalFSAdapter({ handle: asDir(root), dbName: 'test-ul-1' })
    const content = new TextEncoder().encode('uploaded').buffer as ArrayBuffer
    const result = await adapter.uploadFile({ path: 'new.json', hash: '', updatedAt: 0 }, content)
    expect(result.path).toBe('new.json')
    expect(result.hash).toHaveLength(64)
    expect(result.hash).toMatch(/^[0-9a-f]+$/)
    expect(typeof result.updatedAt).toBe('number')
    expect(result.updatedAt).toBeGreaterThan(0)
  })

  it('creates intermediate directories for nested paths', async () => {
    const root = makeDirHandle('root', new Map())
    const adapter = createLocalFSAdapter({ handle: asDir(root), dbName: 'test-ul-2' })
    const content = new TextEncoder().encode('x').buffer as ArrayBuffer
    const result = await adapter.uploadFile({ path: 'notes/sub/a.json', hash: '', updatedAt: 0 }, content)
    expect(result.path).toBe('notes/sub/a.json')
    expect(result.hash).toHaveLength(64)
  })

  it('hash matches SHA-256 of written content', async () => {
    const root = makeDirHandle('root', new Map())
    const adapter = createLocalFSAdapter({ handle: asDir(root), dbName: 'test-ul-3' })
    const content = new TextEncoder().encode('hello').buffer as ArrayBuffer
    const result = await adapter.uploadFile({ path: 'f.json', hash: '', updatedAt: 0 }, content)
    const { meta } = await adapter.downloadFile('f.json')
    expect(result.hash).toBe(meta.hash)
  })

  it('populates the cache so next getRemoteManifest returns the hash', async () => {
    const root = makeDirHandle('root', new Map())
    const adapter = createLocalFSAdapter({ handle: asDir(root), dbName: 'test-ul-4' })
    const content = new TextEncoder().encode('cached').buffer as ArrayBuffer
    const uploaded = await adapter.uploadFile({ path: 'f.json', hash: '', updatedAt: 0 }, content)
    const manifest = await adapter.getRemoteManifest()
    expect(manifest[0].hash).toBe(uploaded.hash)
  })
})
