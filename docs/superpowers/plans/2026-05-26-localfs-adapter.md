# LocalFS Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `createLocalFSAdapter` — a `RemoteRepositoryAdapter` that syncs against a local directory via the browser's File System Access API, with SHA-256 hashes cached in IndexedDB.

**Architecture:** Single file `src/adapters/localfs.ts` following the same factory pattern as existing adapters. Private helpers handle SHA-256 (`SubtleCrypto`), IndexedDB cache (`hashes` store keyed by path), recursive directory traversal, and path resolution. `getRemoteManifest()` is metadata-only — returns cached hash or `''`; actual SHA-256 is computed in `downloadFile()` and `uploadFile()` and written to the cache.

**Tech Stack:** TypeScript, File System Access API (`FileSystemDirectoryHandle`), `SubtleCrypto`, raw IndexedDB API (same pattern as `src/store.ts`), Vitest + `fake-indexeddb`

---

## File map

| Action | Path |
|---|---|
| Create | `src/adapters/localfs.ts` |
| Create | `tests/adapters/localfs.test.ts` |
| Modify | `tsup.config.ts` |
| Modify | `package.json` |
| Modify | `README.md` |

---

### Task 1: Adapter scaffold + `getRemoteManifest()`

**Files:**
- Create: `src/adapters/localfs.ts`
- Create: `tests/adapters/localfs.test.ts`

- [ ] **Step 1: Write the test file with mock helpers and `getRemoteManifest` tests**

Create `tests/adapters/localfs.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createLocalFSAdapter } from '../../src/adapters/localfs.js'

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
})

// ── Mock helpers ────────────────────────────────────────────────────────────

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

// ── getRemoteManifest() ──────────────────────────────────────────────────────

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
    // populate cache via download
    const { meta } = await adapter.downloadFile('a.json')
    // manifest should now return the cached hash
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
```

- [ ] **Step 2: Run to verify tests fail**

```bash
npx vitest run tests/adapters/localfs.test.ts
```

Expected: FAIL — `createLocalFSAdapter` not found / module missing

- [ ] **Step 3: Create `src/adapters/localfs.ts` with all helpers and `getRemoteManifest`**

```ts
import type { RemoteRepositoryAdapter, SyncMetadata } from '../types.js'

interface CacheEntry {
  path: string
  lastModified: number
  size: number
  hash: string
}

export interface LocalFSAdapterOptions {
  handle: FileSystemDirectoryHandle
  basePath?: string
  dbName?: string
}

async function sha256hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

function openCache(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore('hashes', { keyPath: 'path' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function getCacheEntry(db: IDBDatabase, path: string): Promise<CacheEntry | undefined> {
  return new Promise((resolve, reject) => {
    const req = db.transaction('hashes', 'readonly').objectStore('hashes').get(path)
    req.onsuccess = () => resolve(req.result as CacheEntry | undefined)
    req.onerror = () => reject(req.error)
  })
}

function setCacheEntry(db: IDBDatabase, entry: CacheEntry): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('hashes', 'readwrite')
    tx.objectStore('hashes').put(entry)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

function deleteCacheEntry(db: IDBDatabase, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('hashes', 'readwrite')
    tx.objectStore('hashes').delete(path)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

async function* walkDir(
  dir: FileSystemDirectoryHandle,
  prefix: string,
): AsyncGenerator<{ path: string; file: File }> {
  for await (const entry of dir.values()) {
    const entryPath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.kind === 'directory') {
      yield* walkDir(entry as FileSystemDirectoryHandle, entryPath)
    } else {
      const file = await (entry as FileSystemFileHandle).getFile()
      yield { path: entryPath, file }
    }
  }
}

async function resolveDir(
  root: FileSystemDirectoryHandle,
  path: string,
): Promise<FileSystemDirectoryHandle> {
  if (!path) return root
  let dir = root
  for (const seg of path.split('/')) {
    dir = await dir.getDirectoryHandle(seg, { create: false })
  }
  return dir
}

async function resolveFileHandle(
  root: FileSystemDirectoryHandle,
  segments: string[],
  create: boolean,
): Promise<FileSystemFileHandle> {
  let dir = root
  for (let i = 0; i < segments.length - 1; i++) {
    dir = await dir.getDirectoryHandle(segments[i], { create })
  }
  return dir.getFileHandle(segments[segments.length - 1], { create })
}

async function resolveParent(
  root: FileSystemDirectoryHandle,
  segments: string[],
): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
  let dir = root
  for (let i = 0; i < segments.length - 1; i++) {
    dir = await dir.getDirectoryHandle(segments[i], { create: false })
  }
  return { dir, name: segments[segments.length - 1] }
}

export function createLocalFSAdapter(options: LocalFSAdapterOptions): RemoteRepositoryAdapter {
  const { handle, basePath = '', dbName = 'csync-localfs-cache' } = options
  let db: IDBDatabase | null = null

  async function getDb(): Promise<IDBDatabase> {
    if (!db) db = await openCache(dbName)
    return db
  }

  function toSegments(path: string): string[] {
    return (basePath ? `${basePath}/${path}` : path).split('/')
  }

  return {
    async getRemoteManifest(): Promise<SyncMetadata[]> {
      const cache = await getDb()
      const root = await resolveDir(handle, basePath)
      const results: SyncMetadata[] = []
      for await (const { path, file } of walkDir(root, '')) {
        const entry = await getCacheEntry(cache, path)
        const hash =
          entry && entry.lastModified === file.lastModified && entry.size === file.size
            ? entry.hash
            : ''
        results.push({ path, hash, updatedAt: file.lastModified })
      }
      return results
    },

    downloadFile: async () => { throw new Error('not implemented') },
    uploadFile: async () => { throw new Error('not implemented') },
    deleteFile: async () => { throw new Error('not implemented') },
  }
}
```

- [ ] **Step 4: Run tests to verify `getRemoteManifest` tests pass**

```bash
npx vitest run tests/adapters/localfs.test.ts
```

Expected: the 4 `getRemoteManifest` tests PASS; the `downloadFile` call inside "cached hash" test will fail until Task 2 — temporarily remove that one test or skip it with `it.skip`.

> Note: the "returns cached hash" test calls `adapter.downloadFile()` which throws "not implemented". Either skip it now with `it.skip(...)` and restore in Task 2, or implement `downloadFile` in this task. Skipping is cleaner.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/localfs.ts tests/adapters/localfs.test.ts
git commit -m "feat: add localfs adapter scaffold with getRemoteManifest"
```

---

### Task 2: `downloadFile()` + cache integration

**Files:**
- Modify: `src/adapters/localfs.ts`
- Modify: `tests/adapters/localfs.test.ts`

- [ ] **Step 1: Add `downloadFile` tests and restore the skipped cache-hit test**

Add to `tests/adapters/localfs.test.ts` (and remove `it.skip` from the cache-hit test above):

```ts
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
```

- [ ] **Step 2: Run to verify new tests fail**

```bash
npx vitest run tests/adapters/localfs.test.ts
```

Expected: `downloadFile` describe block FAIL — throws "not implemented"

- [ ] **Step 3: Implement `downloadFile` in `src/adapters/localfs.ts`**

Replace `downloadFile: async () => { throw new Error('not implemented') }` with:

```ts
async downloadFile(path: string): Promise<{ content: ArrayBuffer; meta: SyncMetadata }> {
  const cache = await getDb()
  const fileHandle = await resolveFileHandle(handle, toSegments(path), false)
  const file = await fileHandle.getFile()
  const content = await file.arrayBuffer()
  const hash = await sha256hex(content)
  await setCacheEntry(cache, { path, lastModified: file.lastModified, size: file.size, hash })
  return { content, meta: { path, hash, updatedAt: file.lastModified } }
},
```

- [ ] **Step 4: Run all tests**

```bash
npx vitest run tests/adapters/localfs.test.ts
```

Expected: all tests PASS (including the restored cache-hit test in `getRemoteManifest`)

- [ ] **Step 5: Commit**

```bash
git add src/adapters/localfs.ts tests/adapters/localfs.test.ts
git commit -m "feat: implement downloadFile with SHA-256 cache for localfs adapter"
```

---

### Task 3: `uploadFile()`

**Files:**
- Modify: `src/adapters/localfs.ts`
- Modify: `tests/adapters/localfs.test.ts`

- [ ] **Step 1: Add `uploadFile` tests**

```ts
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
    // download the same file and verify the hash matches
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
```

- [ ] **Step 2: Run to verify new tests fail**

```bash
npx vitest run tests/adapters/localfs.test.ts
```

Expected: `uploadFile` describe block FAIL — throws "not implemented"

- [ ] **Step 3: Implement `uploadFile` in `src/adapters/localfs.ts`**

Replace `uploadFile: async () => { throw new Error('not implemented') }` with:

```ts
async uploadFile(meta: SyncMetadata, content: ArrayBuffer): Promise<SyncMetadata> {
  const cache = await getDb()
  const fileHandle = await resolveFileHandle(handle, toSegments(meta.path), true)
  const writable = await fileHandle.createWritable()
  await writable.write(content)
  await writable.close()
  const file = await fileHandle.getFile()
  const hash = await sha256hex(content)
  await setCacheEntry(cache, { path: meta.path, lastModified: file.lastModified, size: file.size, hash })
  return { path: meta.path, hash, updatedAt: file.lastModified }
},
```

- [ ] **Step 4: Run all tests**

```bash
npx vitest run tests/adapters/localfs.test.ts
```

Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/adapters/localfs.ts tests/adapters/localfs.test.ts
git commit -m "feat: implement uploadFile for localfs adapter"
```

---

### Task 4: `deleteFile()`

**Files:**
- Modify: `src/adapters/localfs.ts`
- Modify: `tests/adapters/localfs.test.ts`

- [ ] **Step 1: Add `deleteFile` tests**

```ts
describe('deleteFile()', () => {
  it('removes the file from the directory', async () => {
    const children = new Map<string, any>([['a.json', makeFileHandle('a.json', 'content')]])
    const root = makeDirHandle('root', children)
    const adapter = createLocalFSAdapter({ handle: asDir(root), dbName: 'test-del-1' })
    await adapter.deleteFile('a.json')
    expect(children.has('a.json')).toBe(false)
  })

  it('removes a nested file from its parent directory', async () => {
    const subChildren = new Map<string, any>([['note.json', makeFileHandle('note.json', 'x')]])
    const sub = makeDirHandle('notes', subChildren)
    const root = makeDirHandle('root', new Map([['notes', sub]]))
    const adapter = createLocalFSAdapter({ handle: asDir(root), dbName: 'test-del-2' })
    await adapter.deleteFile('notes/note.json')
    expect(subChildren.has('note.json')).toBe(false)
  })

  it('throws when file does not exist', async () => {
    const root = makeDirHandle('root', new Map())
    const adapter = createLocalFSAdapter({ handle: asDir(root), dbName: 'test-del-3' })
    await expect(adapter.deleteFile('nonexistent.json')).rejects.toThrow()
  })

  it('removes the cache entry so next manifest scan returns empty hash', async () => {
    const fh = makeFileHandle('a.json', 'hello', 1000)
    const children = new Map<string, FH | DH>([['a.json', fh]])
    const root = makeDirHandle('root', children)
    const adapter = createLocalFSAdapter({ handle: asDir(root), dbName: 'test-del-4' })
    // populate cache
    await adapter.downloadFile('a.json')
    // delete the file and re-add a fresh one with same name
    await adapter.deleteFile('a.json')
    children.set('a.json', makeFileHandle('a.json', 'new', 9999))
    const manifest = await adapter.getRemoteManifest()
    // cache was cleared, so hash is empty
    expect(manifest[0].hash).toBe('')
  })
})
```

- [ ] **Step 2: Run to verify new tests fail**

```bash
npx vitest run tests/adapters/localfs.test.ts
```

Expected: `deleteFile` describe block FAIL — throws "not implemented"

- [ ] **Step 3: Implement `deleteFile` in `src/adapters/localfs.ts`**

Replace `deleteFile: async () => { throw new Error('not implemented') }` with:

```ts
async deleteFile(path: string): Promise<void> {
  const cache = await getDb()
  const segments = toSegments(path)
  const { dir, name } = await resolveParent(handle, segments)
  await dir.removeEntry(name)
  await deleteCacheEntry(cache, path)
},
```

- [ ] **Step 4: Run all tests**

```bash
npx vitest run tests/adapters/localfs.test.ts
```

Expected: all tests PASS

- [ ] **Step 5: Run full test suite**

```bash
npm test
```

Expected: all tests PASS (no regressions in other adapters)

- [ ] **Step 6: Commit**

```bash
git add src/adapters/localfs.ts tests/adapters/localfs.test.ts
git commit -m "feat: implement deleteFile for localfs adapter"
```

---

### Task 5: Wire up build exports

**Files:**
- Modify: `tsup.config.ts`
- Modify: `package.json`

- [ ] **Step 1: Add entry to `tsup.config.ts`**

In the `entry` object, add one line:

```ts
entry: {
  index: 'src/index.ts',
  'adapters/github': 'src/adapters/github.ts',
  'adapters/webdav': 'src/adapters/webdav.ts',
  'adapters/s3': 'src/adapters/s3.ts',
  'adapters/localfs': 'src/adapters/localfs.ts',   // ← add this
},
```

- [ ] **Step 2: Add export condition to `package.json`**

After the `"./adapters/s3"` block, add:

```json
"./adapters/localfs": {
  "import": "./dist/adapters/localfs.js",
  "types": "./dist/adapters/localfs.d.ts"
}
```

- [ ] **Step 3: Build and verify output**

```bash
npm run build
```

Expected: exits 0; `dist/adapters/localfs.js` and `dist/adapters/localfs.d.ts` are generated.

```bash
ls dist/adapters/
```

Expected output includes `localfs.js` and `localfs.d.ts`.

- [ ] **Step 4: Run typecheck**

```bash
npm run typecheck
```

Expected: exits 0, no errors.

- [ ] **Step 5: Commit**

```bash
git add tsup.config.ts package.json
git commit -m "chore: add localfs adapter to build and package exports"
```

---

### Task 6: README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add row to adapters table**

In the Adapters table (after the S3 row), add:

```markdown
| `@huxzhi/csync/adapters/localfs` | Browser File System Access API |
```

- [ ] **Step 2: Add usage section before the API section**

After the last existing usage section and before `## API`, add:

````markdown
### Local file system sync (browser)

Sync IndexedDB records to a local folder the user picks with the browser's File System Access API. SHA-256 hashes are cached in IndexedDB so unchanged files are skipped on subsequent syncs.

```ts
import { createSyncer } from '@huxzhi/csync'
import { createLocalFSAdapter } from '@huxzhi/csync/adapters/localfs'

const handle = await showDirectoryPicker()
const remote = createLocalFSAdapter({ handle })

const syncer = createSyncer({ local, remote })
const diff = await syncer.prepare()
const summary = await syncer.commit(diff)
```

Pass `basePath` to scope the adapter to a subdirectory inside the chosen folder:

```ts
const remote = createLocalFSAdapter({ handle, basePath: 'data' })
```
````

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add localfs adapter to README"
```
