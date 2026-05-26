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

  it.skip('returns cached hash when lastModified and size match after a download', async () => {
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
