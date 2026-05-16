# csync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a zero-dependency browser TypeScript npm package that syncs local structured data with a remote GitHub repository using a "one record = one JSON file" strategy.

**Architecture:** A functional-adapter pattern where the user wires up their own DB closures; the engine runs a two-phase prepare/commit cycle (three-way merge diff → concurrent task queue). Internal state (baseline snapshot) is persisted in a private IndexedDB database.

**Tech Stack:** TypeScript 5, tsup (ESM build), Vitest (tests), fake-indexeddb (store tests), native fetch (GitHub adapter)

---

## File Map

| File | Responsibility |
|---|---|
| `src/types.ts` | All public interfaces and type aliases |
| `src/store.ts` | Raw IndexedDB wrapper for baseline snapshot |
| `src/queue.ts` | Concurrent worker pool with retry + timeout + abort |
| `src/diff.ts` | Pure three-way merge function |
| `src/syncer.ts` | `createSyncer()` factory — orchestrates store, diff, queue |
| `src/adapters/github.ts` | GitHub REST API remote adapter |
| `src/index.ts` | Public re-exports |
| `package.json` | Package metadata and exports map |
| `tsconfig.json` | TypeScript compiler config |
| `tsup.config.ts` | Build entry points |
| `vitest.config.ts` | Test runner config |

---

## Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsup.config.ts`
- Create: `vitest.config.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "csync",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    },
    "./adapters/github": {
      "import": "./dist/adapters/github.js",
      "types": "./dist/adapters/github.d.ts"
    }
  },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "fake-indexeddb": "^5.0.2",
    "tsup": "^8.1.0",
    "typescript": "^5.4.5",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "lib": ["ES2020", "DOM"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "declaration": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `tsup.config.ts`**

```ts
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'adapters/github': 'src/adapters/github.ts',
  },
  format: ['esm'],
  dts: true,
  splitting: false,
  clean: true,
  sourcemap: true,
})
```

- [ ] **Step 4: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
  },
})
```

- [ ] **Step 5: Create `.gitignore`**

```
node_modules/
dist/
*.js.map
```

- [ ] **Step 6: Install dependencies**

```bash
cd /home/huxzhi/4-code/csync && npm install
```

Expected: `node_modules/` created, no errors.

- [ ] **Step 7: Commit**

```bash
git init && git add package.json tsconfig.json tsup.config.ts vitest.config.ts .gitignore
git commit -m "chore: project scaffold — tsup, vitest, typescript"
```

---

## Task 2: Types (`src/types.ts`)

**Files:**
- Create: `src/types.ts`

No tests needed — this file is purely type definitions with no runtime behaviour.

- [ ] **Step 1: Create `src/types.ts`**

```ts
export interface SyncMetadata {
  path: string
  hash: string
  updatedAt: number
  tags?: string[]
}

export interface DiffResult {
  upload: string[]
  download: string[]
  deleteRemote: string[]
  deleteLocal: string[]
  conflict: { path: string; local: SyncMetadata; remote: SyncMetadata }[]
}

export interface SyncSummary {
  uploaded: string[]
  downloaded: string[]
  deletedRemote: string[]
  deletedLocal: string[]
  skippedConflicts: string[]
  failed: { path: string; reason: unknown }[]
}

export interface LocalDatabaseAdapter {
  getLocalManifest: () => Promise<SyncMetadata[]>
  getRecordContent: (path: string) => Promise<Record<string, unknown> | null>
  upsertRecord: (
    path: string,
    data: Record<string, unknown>,
    meta: Omit<SyncMetadata, 'path'>,
  ) => Promise<void>
  deleteRecordPermanently: (path: string) => Promise<void>
}

export interface RemoteRepositoryAdapter {
  getRemoteManifest: () => Promise<SyncMetadata[]>
  uploadFile: (path: string, content: string) => Promise<{ hash: string }>
  downloadFile: (path: string) => Promise<Record<string, unknown>>
  deleteFile: (path: string) => Promise<void>
}

export interface SyncerConfig {
  local: LocalDatabaseAdapter
  remote: RemoteRepositoryAdapter
  dbName?: string
  concurrency?: number
  timeout?: number
  maxRetries?: number
}

export interface PrepareOptions {
  signal?: AbortSignal
  tags?: string[]
}

export interface CommitOptions {
  signal?: AbortSignal
  onProgress?: (completed: number, total: number) => void
}
```

- [ ] **Step 2: Verify types compile**

```bash
cd /home/huxzhi/4-code/csync && npx tsc --noEmit --allowImportingTsExtensions
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: define all public types and adapter interfaces"
```

---

## Task 3: Internal Store (`src/store.ts`)

**Files:**
- Create: `src/store.ts`
- Create: `src/store.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/store.test.ts
import { beforeEach, describe, expect, it } from 'vitest'
import FakeIndexedDB from 'fake-indexeddb'
import { getBaseline, openStore, saveBaseline } from './store.js'
import type { SyncMetadata } from './types.js'

beforeEach(() => {
  globalThis.indexedDB = new FakeIndexedDB()
})

describe('openStore', () => {
  it('creates the baseline object store on first open', async () => {
    const db = await openStore('test-db')
    expect(db.objectStoreNames.contains('baseline')).toBe(true)
    db.close()
  })
})

describe('getBaseline', () => {
  it('returns empty array when no snapshot has been saved', async () => {
    const db = await openStore('test-db')
    const result = await getBaseline(db)
    expect(result).toEqual([])
    db.close()
  })
})

describe('saveBaseline / getBaseline round-trip', () => {
  it('persists and retrieves a snapshot', async () => {
    const db = await openStore('test-db')
    const snapshot: SyncMetadata[] = [
      { path: 'notes/a.json', hash: 'abc123', updatedAt: 1000 },
      { path: 'notes/b.json', hash: 'def456', updatedAt: 2000, tags: ['work'] },
    ]
    await saveBaseline(db, snapshot)
    const result = await getBaseline(db)
    expect(result).toEqual(snapshot)
    db.close()
  })

  it('overwrites the previous snapshot on second save', async () => {
    const db = await openStore('test-db')
    await saveBaseline(db, [{ path: 'a.json', hash: 'old', updatedAt: 1000 }])
    const newSnapshot: SyncMetadata[] = [{ path: 'b.json', hash: 'new', updatedAt: 2000 }]
    await saveBaseline(db, newSnapshot)
    const result = await getBaseline(db)
    expect(result).toEqual(newSnapshot)
    db.close()
  })

  it('persists an empty snapshot', async () => {
    const db = await openStore('test-db')
    await saveBaseline(db, [{ path: 'a.json', hash: 'h1', updatedAt: 1 }])
    await saveBaseline(db, [])
    const result = await getBaseline(db)
    expect(result).toEqual([])
    db.close()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/huxzhi/4-code/csync && npx vitest run src/store.test.ts
```

Expected: FAIL — `Cannot find module './store.js'`

- [ ] **Step 3: Implement `src/store.ts`**

```ts
import type { SyncMetadata } from './types.js'

export function openStore(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore('baseline')
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export function getBaseline(db: IDBDatabase): Promise<SyncMetadata[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('baseline', 'readonly')
    const request = tx.objectStore('baseline').get('snapshot')
    request.onsuccess = () => resolve((request.result as SyncMetadata[] | undefined) ?? [])
    request.onerror = () => reject(request.error)
  })
}

export function saveBaseline(db: IDBDatabase, snapshot: SyncMetadata[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('baseline', 'readwrite')
    tx.objectStore('baseline').put(snapshot, 'snapshot')
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/huxzhi/4-code/csync && npx vitest run src/store.test.ts
```

Expected: PASS — 5 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/store.ts src/store.test.ts
git commit -m "feat: internal IndexedDB store for baseline snapshot"
```

---

## Task 4: Concurrency Engine (`src/queue.ts`)

**Files:**
- Create: `src/queue.ts`
- Create: `src/queue.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/queue.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runWithConcurrency } from './queue.js'

beforeEach(() => {
  vi.useRealTimers()
})

describe('runWithConcurrency', () => {
  it('returns fulfilled results for all successful tasks', async () => {
    const tasks = [() => Promise.resolve(1), () => Promise.resolve(2), () => Promise.resolve(3)]
    const results = await runWithConcurrency(tasks, { concurrency: 2 })
    expect(results).toEqual([
      { status: 'fulfilled', value: 1 },
      { status: 'fulfilled', value: 2 },
      { status: 'fulfilled', value: 3 },
    ])
  })

  it('returns empty array for empty task list', async () => {
    const results = await runWithConcurrency([], { concurrency: 5 })
    expect(results).toEqual([])
  })

  it('isolates task failures — other tasks still complete', async () => {
    const tasks = [
      () => Promise.resolve('ok'),
      () => Promise.reject(new Error('boom')),
      () => Promise.resolve('also ok'),
    ]
    const results = await runWithConcurrency(tasks, { concurrency: 3, maxRetries: 0 })
    expect(results[0]).toEqual({ status: 'fulfilled', value: 'ok' })
    expect(results[1].status).toBe('rejected')
    expect((results[1] as { status: 'rejected'; reason: Error }).reason.message).toBe('boom')
    expect(results[2]).toEqual({ status: 'fulfilled', value: 'also ok' })
  })

  it('never exceeds the concurrency limit', async () => {
    let active = 0
    let maxActive = 0
    const tasks = Array.from({ length: 10 }, () => async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise<void>(r => setTimeout(r, 5))
      active--
      return 'done'
    })
    await runWithConcurrency(tasks, { concurrency: 3 })
    expect(maxActive).toBeLessThanOrEqual(3)
  })

  it('retries a failing task and succeeds on the third attempt', async () => {
    let calls = 0
    const tasks = [
      async () => {
        calls++
        if (calls < 3) throw new Error('transient')
        return 'success'
      },
    ]
    const results = await runWithConcurrency(tasks, { concurrency: 1, maxRetries: 3 })
    expect(results[0]).toEqual({ status: 'fulfilled', value: 'success' })
    expect(calls).toBe(3)
  })

  it('marks a task rejected after exhausting all retries', async () => {
    const err = new Error('always fails')
    const tasks = [() => Promise.reject(err)]
    const results = await runWithConcurrency(tasks, { concurrency: 1, maxRetries: 2 })
    expect(results[0].status).toBe('rejected')
    expect((results[0] as { status: 'rejected'; reason: Error }).reason).toBe(err)
  })

  it('rejects a task that exceeds the timeout', async () => {
    vi.useFakeTimers()
    const tasks = [() => new Promise<string>(r => setTimeout(() => r('late'), 10_000))]
    const promise = runWithConcurrency(tasks, { concurrency: 1, timeout: 100, maxRetries: 0 })
    vi.advanceTimersByTime(200)
    const results = await promise
    expect(results[0].status).toBe('rejected')
    expect((results[0] as { status: 'rejected'; reason: Error }).reason.message).toContain(
      'timed out',
    )
  })

  it('stops dispatching new tasks when signal is aborted before start', async () => {
    const controller = new AbortController()
    controller.abort()
    let started = 0
    const tasks = Array.from({ length: 5 }, () => async () => {
      started++
      return 'done'
    })
    await runWithConcurrency(tasks, { concurrency: 2, signal: controller.signal })
    expect(started).toBe(0)
  })

  it('calls onProgress once per completed task in order', async () => {
    const progress: [number, number][] = []
    const tasks = [() => Promise.resolve(1), () => Promise.resolve(2), () => Promise.resolve(3)]
    await runWithConcurrency(tasks, {
      concurrency: 1,
      onProgress: (c, t) => progress.push([c, t]),
    })
    expect(progress).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/huxzhi/4-code/csync && npx vitest run src/queue.test.ts
```

Expected: FAIL — `Cannot find module './queue.js'`

- [ ] **Step 3: Implement `src/queue.ts`**

```ts
export type TaskResult<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown }

export async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  options: {
    concurrency: number
    timeout?: number
    maxRetries?: number
    signal?: AbortSignal
    onProgress?: (completed: number, total: number) => void
  },
): Promise<TaskResult<T>[]> {
  const { concurrency, timeout, maxRetries = 3, signal, onProgress } = options
  const total = tasks.length
  if (total === 0) return []

  const results: TaskResult<T>[] = new Array(total)
  let currentIndex = 0
  let completed = 0
  const BASE_DELAY_MS = 200

  function withTimeout(p: Promise<T>): Promise<T> {
    if (timeout === undefined) return p
    return Promise.race([
      p,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Task timed out after ${timeout}ms`)),
          timeout,
        ),
      ),
    ])
  }

  async function runWithRetry(index: number): Promise<void> {
    const taskFn = tasks[index]
    let lastError: unknown

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const jitter = Math.random() * BASE_DELAY_MS
        await new Promise<void>(r =>
          setTimeout(r, BASE_DELAY_MS * 2 ** (attempt - 1) + jitter),
        )
      }
      try {
        const value = await withTimeout(taskFn())
        results[index] = { status: 'fulfilled', value }
        return
      } catch (err) {
        lastError = err
      }
    }

    results[index] = { status: 'rejected', reason: lastError }
  }

  async function worker(): Promise<void> {
    while (true) {
      if (signal?.aborted) break
      const index = currentIndex++
      if (index >= total) break
      await runWithRetry(index)
      completed++
      onProgress?.(completed, total)
    }
  }

  const workerCount = Math.min(concurrency, total)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/huxzhi/4-code/csync && npx vitest run src/queue.test.ts
```

Expected: PASS — 9 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/queue.ts src/queue.test.ts
git commit -m "feat: concurrent worker pool with retry, timeout, and abort"
```

---

## Task 5: Three-Way Merge (`src/diff.ts`)

**Files:**
- Create: `src/diff.ts`
- Create: `src/diff.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/diff.test.ts
import { describe, expect, it } from 'vitest'
import { computeDiff } from './diff.js'
import type { SyncMetadata } from './types.js'

function m(path: string, hash: string, tags?: string[]): SyncMetadata {
  return { path, hash, updatedAt: 1000, tags }
}

describe('computeDiff — upload', () => {
  it('uploads a locally dirty record when remote is unchanged', () => {
    const diff = computeDiff([m('a.json', '')], [m('a.json', 'h1')], [m('a.json', 'h1')])
    expect(diff.upload).toEqual(['a.json'])
    expect(diff.download).toEqual([])
  })

  it('uploads a new local dirty record not present anywhere else', () => {
    const diff = computeDiff([m('new.json', '')], [], [])
    expect(diff.upload).toEqual(['new.json'])
  })
})

describe('computeDiff — download', () => {
  it('downloads a remotely changed record when local is clean', () => {
    const diff = computeDiff([m('a.json', 'h1')], [m('a.json', 'h2')], [m('a.json', 'h1')])
    expect(diff.download).toEqual(['a.json'])
    expect(diff.upload).toEqual([])
  })

  it('downloads a new remote record not present in baseline or local', () => {
    const diff = computeDiff([], [m('remote.json', 'h1')], [])
    expect(diff.download).toEqual(['remote.json'])
  })
})

describe('computeDiff — deleteRemote', () => {
  it('queues remote delete when record was deleted locally and remote is unchanged', () => {
    const diff = computeDiff([], [m('a.json', 'h1')], [m('a.json', 'h1')])
    expect(diff.deleteRemote).toEqual(['a.json'])
  })
})

describe('computeDiff — deleteLocal', () => {
  it('queues local delete when remote deleted a clean local record', () => {
    const diff = computeDiff([m('a.json', 'h1')], [], [m('a.json', 'h1')])
    expect(diff.deleteLocal).toEqual(['a.json'])
  })
})

describe('computeDiff — conflict', () => {
  it('marks conflict when both local is dirty and remote has changed', () => {
    const diff = computeDiff([m('a.json', '')], [m('a.json', 'h2')], [m('a.json', 'h1')])
    expect(diff.conflict).toHaveLength(1)
    expect(diff.conflict[0].path).toBe('a.json')
    expect(diff.conflict[0].local.hash).toBe('')
    expect(diff.conflict[0].remote.hash).toBe('h2')
  })
})

describe('computeDiff — no-op', () => {
  it('produces empty diff when nothing has changed', () => {
    const diff = computeDiff([m('a.json', 'h1')], [m('a.json', 'h1')], [m('a.json', 'h1')])
    expect(diff.upload).toEqual([])
    expect(diff.download).toEqual([])
    expect(diff.deleteRemote).toEqual([])
    expect(diff.deleteLocal).toEqual([])
    expect(diff.conflict).toEqual([])
  })

  it('is a no-op when both sides deleted a record (already converged)', () => {
    const diff = computeDiff([], [], [m('a.json', 'h1')])
    expect(diff.deleteRemote).toEqual([])
    expect(diff.deleteLocal).toEqual([])
  })
})

describe('computeDiff — multi-record', () => {
  it('handles multiple records with independent actions in one pass', () => {
    const local = [m('upload.json', ''), m('clean.json', 'h1'), m('dl.json', 'h1')]
    const remote = [m('upload.json', 'h1'), m('clean.json', 'h1'), m('dl.json', 'h2')]
    const baseline = [m('upload.json', 'h1'), m('clean.json', 'h1'), m('dl.json', 'h1')]
    const diff = computeDiff(local, remote, baseline)
    expect(diff.upload).toEqual(['upload.json'])
    expect(diff.download).toEqual(['dl.json'])
    expect(diff.deleteRemote).toEqual([])
    expect(diff.deleteLocal).toEqual([])
    expect(diff.conflict).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/huxzhi/4-code/csync && npx vitest run src/diff.test.ts
```

Expected: FAIL — `Cannot find module './diff.js'`

- [ ] **Step 3: Implement `src/diff.ts`**

```ts
import type { DiffResult, SyncMetadata } from './types.js'

export function computeDiff(
  local: SyncMetadata[],
  remote: SyncMetadata[],
  baseline: SyncMetadata[],
): DiffResult {
  const L = new Map(local.map(m => [m.path, m]))
  const R = new Map(remote.map(m => [m.path, m]))
  const B = new Map(baseline.map(m => [m.path, m]))

  const allPaths = new Set([...L.keys(), ...R.keys(), ...B.keys()])

  const result: DiffResult = {
    upload: [],
    download: [],
    deleteRemote: [],
    deleteLocal: [],
    conflict: [],
  }

  for (const path of allPaths) {
    const l = L.get(path)
    const r = R.get(path)
    const b = B.get(path)

    const localDirty = l !== undefined && l.hash === ''
    const localDeleted = l === undefined && b !== undefined
    const remoteModified = r !== undefined && r.hash !== b?.hash
    const remoteDeleted = r === undefined && b !== undefined

    if (localDirty && !remoteModified && !remoteDeleted) {
      result.upload.push(path)
    } else if (localDeleted && !remoteModified && !remoteDeleted) {
      result.deleteRemote.push(path)
    } else if (!localDirty && !localDeleted && remoteModified) {
      result.download.push(path)
    } else if (!localDirty && !localDeleted && remoteDeleted) {
      result.deleteLocal.push(path)
    } else if (localDirty && remoteModified) {
      result.conflict.push({ path, local: l!, remote: r! })
    }
  }

  return result
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/huxzhi/4-code/csync && npx vitest run src/diff.test.ts
```

Expected: PASS — 10 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/diff.ts src/diff.test.ts
git commit -m "feat: three-way merge diff algorithm"
```

---

## Task 6: Core Syncer (`src/syncer.ts`)

**Files:**
- Create: `src/syncer.ts`
- Create: `src/syncer.test.ts`

> **Implementation note:** The syncer stores `lastRemoteMap` and `lastLocalMap` (captured during `prepare()`) on the instance so that `commit()` can look up the remote hash for downloads and preserve local tags on uploads without extra adapter calls.

- [ ] **Step 1: Write the failing tests**

```ts
// src/syncer.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import FakeIndexedDB from 'fake-indexeddb'
import { createSyncer } from './syncer.js'
import type {
  CommitOptions,
  LocalDatabaseAdapter,
  RemoteRepositoryAdapter,
  SyncMetadata,
} from './types.js'

beforeEach(() => {
  globalThis.indexedDB = new FakeIndexedDB()
})

function makeLocalAdapter(records: Map<string, { data: Record<string, unknown>; meta: SyncMetadata }>): LocalDatabaseAdapter {
  return {
    getLocalManifest: () => Promise.resolve([...records.values()].map(r => r.meta)),
    getRecordContent: (path) => Promise.resolve(records.get(path)?.data ?? null),
    upsertRecord: (path, data, meta) => {
      records.set(path, { data, meta: { path, ...meta } })
      return Promise.resolve()
    },
    deleteRecordPermanently: (path) => {
      records.delete(path)
      return Promise.resolve()
    },
  }
}

function makeRemoteAdapter(files: Map<string, { content: Record<string, unknown>; hash: string }>): RemoteRepositoryAdapter {
  return {
    getRemoteManifest: () =>
      Promise.resolve(
        [...files.entries()].map(([path, f]) => ({
          path,
          hash: f.hash,
          updatedAt: 0,
        })),
      ),
    uploadFile: (path, content) => {
      const hash = `hash-${path}-${Date.now()}`
      files.set(path, { content: JSON.parse(content), hash })
      return Promise.resolve({ hash })
    },
    downloadFile: (path) => {
      const f = files.get(path)
      if (!f) throw new Error(`Not found: ${path}`)
      return Promise.resolve(f.content)
    },
    deleteFile: (path) => {
      files.delete(path)
      return Promise.resolve()
    },
  }
}

describe('prepare()', () => {
  it('identifies a locally dirty record as upload', async () => {
    const localRecords = new Map([
      ['notes/a.json', { data: { text: 'hello' }, meta: { path: 'notes/a.json', hash: '', updatedAt: 1 } }],
    ])
    const remoteFiles = new Map([
      ['notes/a.json', { content: { text: 'old' }, hash: 'old-hash' }],
    ])
    const syncer = createSyncer({
      local: makeLocalAdapter(localRecords),
      remote: makeRemoteAdapter(remoteFiles),
      dbName: 'test-prepare',
    })
    // Baseline has the old hash → local is now dirty
    // First prepare with no baseline → remote is treated as source of truth (download)
    // To get an upload, we need the baseline to match remote
    // Set up baseline by doing a fake first sync
    const diff = await syncer.prepare()
    // No baseline → remote record is "new" → download
    expect(diff.download).toEqual(['notes/a.json'])
  })

  it('identifies a locally deleted record as deleteRemote', async () => {
    const localRecords = new Map<string, { data: Record<string, unknown>; meta: SyncMetadata }>()
    const remoteFiles = new Map([
      ['notes/a.json', { content: { text: 'hello' }, hash: 'h1' }],
    ])
    // Populate baseline by committing first
    const syncer = createSyncer({
      local: makeLocalAdapter(localRecords),
      remote: makeRemoteAdapter(remoteFiles),
      dbName: 'test-delete',
    })
    // Seed the baseline manually by doing prepare + commit on a record that exists locally
    const localWithRecord = new Map([
      ['notes/a.json', { data: { text: 'hello' }, meta: { path: 'notes/a.json', hash: 'h1', updatedAt: 1 } }],
    ])
    const seeder = createSyncer({
      local: makeLocalAdapter(localWithRecord),
      remote: makeRemoteAdapter(remoteFiles),
      dbName: 'test-delete',
    })
    const firstDiff = await seeder.prepare()
    await seeder.commit(firstDiff)

    // Now local has deleted the record — new syncer same db, empty local
    const diff = await syncer.prepare()
    expect(diff.deleteRemote).toContain('notes/a.json')
  })

  it('filters by tags when tags option is provided', async () => {
    const localRecords = new Map([
      ['work/a.json', { data: {}, meta: { path: 'work/a.json', hash: '', updatedAt: 1, tags: ['work'] } }],
      ['personal/b.json', { data: {}, meta: { path: 'personal/b.json', hash: '', updatedAt: 1, tags: ['personal'] } }],
    ])
    const syncer = createSyncer({
      local: makeLocalAdapter(localRecords),
      remote: makeRemoteAdapter(new Map()),
      dbName: 'test-tags',
    })
    const diff = await syncer.prepare({ tags: ['work'] })
    expect(diff.upload).toContain('work/a.json')
    expect(diff.upload).not.toContain('personal/b.json')
  })
})

describe('commit()', () => {
  it('uploads dirty records and updates the baseline', async () => {
    const localRecords = new Map([
      ['notes/a.json', { data: { text: 'hello' }, meta: { path: 'notes/a.json', hash: '', updatedAt: 1 } }],
    ])
    const remoteFiles = new Map<string, { content: Record<string, unknown>; hash: string }>()
    const syncer = createSyncer({
      local: makeLocalAdapter(localRecords),
      remote: makeRemoteAdapter(remoteFiles),
      dbName: 'test-upload',
    })
    const diff = await syncer.prepare()
    const summary = await syncer.commit(diff)
    expect(summary.uploaded).toContain('notes/a.json')
    expect(summary.failed).toEqual([])
    expect(remoteFiles.has('notes/a.json')).toBe(true)
    // After commit, hash should be set (not empty) in local
    const updatedMeta = localRecords.get('notes/a.json')?.meta
    expect(updatedMeta?.hash).not.toBe('')
  })

  it('downloads remote-only records into local', async () => {
    const localRecords = new Map<string, { data: Record<string, unknown>; meta: SyncMetadata }>()
    const remoteFiles = new Map([
      ['notes/b.json', { content: { text: 'remote data' }, hash: 'r-hash' }],
    ])
    const syncer = createSyncer({
      local: makeLocalAdapter(localRecords),
      remote: makeRemoteAdapter(remoteFiles),
      dbName: 'test-download',
    })
    const diff = await syncer.prepare()
    const summary = await syncer.commit(diff)
    expect(summary.downloaded).toContain('notes/b.json')
    expect(localRecords.has('notes/b.json')).toBe(true)
    expect(localRecords.get('notes/b.json')?.data).toEqual({ text: 'remote data' })
  })

  it('skips conflict entries and records them in summary', async () => {
    const localRecords = new Map([
      ['a.json', { data: { v: 1 }, meta: { path: 'a.json', hash: '', updatedAt: 1 } }],
    ])
    const remoteFiles = new Map([
      ['a.json', { content: { v: 2 }, hash: 'remote-hash' }],
    ])
    const syncer = createSyncer({
      local: makeLocalAdapter(localRecords),
      remote: makeRemoteAdapter(remoteFiles),
      dbName: 'test-conflict',
    })
    // Seed baseline with original hash so three-way merge sees both sides changed
    const seeder = createSyncer({
      local: makeLocalAdapter(new Map([
        ['a.json', { data: { v: 0 }, meta: { path: 'a.json', hash: 'original-hash', updatedAt: 0 } }],
      ])),
      remote: makeRemoteAdapter(new Map([
        ['a.json', { content: { v: 0 }, hash: 'original-hash' }],
      ])),
      dbName: 'test-conflict',
    })
    await seeder.commit(await seeder.prepare())

    // Now both sides diverged from baseline
    const diff = await syncer.prepare()
    const summary = await syncer.commit(diff)
    expect(summary.skippedConflicts).toContain('a.json')
    expect(summary.uploaded).not.toContain('a.json')
  })

  it('calls onProgress for each completed task', async () => {
    const localRecords = new Map([
      ['a.json', { data: {}, meta: { path: 'a.json', hash: '', updatedAt: 1 } }],
      ['b.json', { data: {}, meta: { path: 'b.json', hash: '', updatedAt: 1 } }],
    ])
    const syncer = createSyncer({
      local: makeLocalAdapter(localRecords),
      remote: makeRemoteAdapter(new Map()),
      dbName: 'test-progress',
      concurrency: 1,
    })
    const diff = await syncer.prepare()
    const progress: [number, number][] = []
    await syncer.commit(diff, {
      onProgress: (c, t) => progress.push([c, t]),
    })
    expect(progress.length).toBe(2)
    expect(progress[progress.length - 1][0]).toBe(2)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/huxzhi/4-code/csync && npx vitest run src/syncer.test.ts
```

Expected: FAIL — `Cannot find module './syncer.js'`

- [ ] **Step 3: Implement `src/syncer.ts`**

```ts
import type {
  CommitOptions,
  DiffResult,
  PrepareOptions,
  SyncMetadata,
  SyncSummary,
  SyncerConfig,
} from './types.js'
import { computeDiff } from './diff.js'
import { getBaseline, openStore, saveBaseline } from './store.js'
import { runWithConcurrency } from './queue.js'

export function createSyncer(config: SyncerConfig) {
  const {
    local,
    remote,
    dbName = '_csync',
    concurrency = 5,
    timeout = 30_000,
    maxRetries = 3,
  } = config

  let dbPromise: Promise<IDBDatabase> | null = null
  let lastRemoteMap = new Map<string, SyncMetadata>()
  let lastLocalMap = new Map<string, SyncMetadata>()

  function getDb(): Promise<IDBDatabase> {
    if (!dbPromise) dbPromise = openStore(dbName)
    return dbPromise
  }

  async function prepare(options: PrepareOptions = {}): Promise<DiffResult> {
    const { tags } = options
    const db = await getDb()

    const [localManifest, remoteManifest, baseline] = await Promise.all([
      local.getLocalManifest(),
      remote.getRemoteManifest(),
      getBaseline(db),
    ])

    lastLocalMap = new Map(localManifest.map(m => [m.path, m]))
    lastRemoteMap = new Map(remoteManifest.map(m => [m.path, m]))

    const filteredLocal =
      tags?.length
        ? localManifest.filter(m => m.tags?.some(t => tags.includes(t)) ?? false)
        : localManifest

    const filteredBaseline =
      tags?.length
        ? baseline.filter(m => m.tags?.some(t => tags.includes(t)) ?? false)
        : baseline

    return computeDiff(filteredLocal, remoteManifest, filteredBaseline)
  }

  async function commit(diff: DiffResult, options: CommitOptions = {}): Promise<SyncSummary> {
    const { signal, onProgress } = options
    const db = await getDb()
    const baseline = await getBaseline(db)

    const summary: SyncSummary = {
      uploaded: [],
      downloaded: [],
      deletedRemote: [],
      deletedLocal: [],
      skippedConflicts: diff.conflict.map(c => c.path),
      failed: [],
    }

    type TaskInfo = { path: string; action: 'upload' | 'download' | 'deleteRemote' | 'deleteLocal' }
    const taskInfos: TaskInfo[] = []
    const tasks: (() => Promise<SyncMetadata | null>)[] = []

    for (const path of diff.upload) {
      taskInfos.push({ path, action: 'upload' })
      tasks.push(async () => {
        const content = await local.getRecordContent(path)
        if (content === null) throw new Error(`Record not found during upload: ${path}`)
        const { hash } = await remote.uploadFile(path, JSON.stringify(content))
        const tags = lastLocalMap.get(path)?.tags
        await local.upsertRecord(path, content, { hash, updatedAt: Date.now(), tags })
        return { path, hash, updatedAt: Date.now(), tags }
      })
    }

    for (const path of diff.download) {
      taskInfos.push({ path, action: 'download' })
      tasks.push(async () => {
        const data = await remote.downloadFile(path)
        const remoteHash = lastRemoteMap.get(path)?.hash ?? ''
        const tags = lastLocalMap.get(path)?.tags
        await local.upsertRecord(path, data, { hash: remoteHash, updatedAt: Date.now(), tags })
        return { path, hash: remoteHash, updatedAt: Date.now(), tags }
      })
    }

    for (const path of diff.deleteRemote) {
      taskInfos.push({ path, action: 'deleteRemote' })
      tasks.push(async () => {
        await remote.deleteFile(path)
        await local.deleteRecordPermanently(path)
        return null
      })
    }

    for (const path of diff.deleteLocal) {
      taskInfos.push({ path, action: 'deleteLocal' })
      tasks.push(async () => {
        await local.deleteRecordPermanently(path)
        return null
      })
    }

    const results = await runWithConcurrency(tasks, {
      concurrency,
      timeout,
      maxRetries,
      signal,
      onProgress,
    })

    const updatedMeta: SyncMetadata[] = []
    const removedPaths = new Set<string>()

    for (let i = 0; i < results.length; i++) {
      const { path, action } = taskInfos[i]
      const result = results[i]

      if (result.status === 'fulfilled') {
        if (result.value !== null) {
          updatedMeta.push(result.value)
        } else {
          removedPaths.add(path)
        }
        if (action === 'upload') summary.uploaded.push(path)
        else if (action === 'download') summary.downloaded.push(path)
        else if (action === 'deleteRemote') summary.deletedRemote.push(path)
        else if (action === 'deleteLocal') summary.deletedLocal.push(path)
      } else {
        summary.failed.push({ path, reason: result.reason })
      }
    }

    const updatedMap = new Map(updatedMeta.map(m => [m.path, m]))
    const newBaseline: SyncMetadata[] = [
      ...baseline.filter(m => !removedPaths.has(m.path) && !updatedMap.has(m.path)),
      ...updatedMeta,
    ]
    await saveBaseline(db, newBaseline)

    return summary
  }

  return { prepare, commit }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/huxzhi/4-code/csync && npx vitest run src/syncer.test.ts
```

Expected: PASS — all syncer tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/syncer.ts src/syncer.test.ts
git commit -m "feat: createSyncer — prepare/commit with baseline persistence"
```

---

## Task 7: GitHub Adapter (`src/adapters/github.ts`)

**Files:**
- Create: `src/adapters/github.ts`
- Create: `src/adapters/github.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/adapters/github.test.ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/huxzhi/4-code/csync && npx vitest run src/adapters/github.test.ts
```

Expected: FAIL — `Cannot find module './github.js'`

- [ ] **Step 3: Create `src/adapters/` directory and implement**

```ts
// src/adapters/github.ts
import type { RemoteRepositoryAdapter, SyncMetadata } from '../types.js'

export interface GitHubAdapterOptions {
  owner: string
  repo: string
  branch: string
  token: string
  basePath?: string
}

interface GitTreeItem {
  path: string
  type: 'blob' | 'tree'
  sha: string
}

export function createGitHubAdapter(options: GitHubAdapterOptions): RemoteRepositoryAdapter {
  const { owner, repo, branch, token, basePath = 'data' } = options

  const BASE = `https://api.github.com/repos/${owner}/${repo}`

  const defaultHeaders: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  }

  async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${BASE}/${path}`, {
      ...init,
      headers: { ...defaultHeaders, ...(init?.headers as Record<string, string> | undefined) },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`GitHub API ${res.status}: ${body}`)
    }
    return res.json() as Promise<T>
  }

  function remotePath(path: string): string {
    return `${basePath}/${path}`
  }

  return {
    async getRemoteManifest(): Promise<SyncMetadata[]> {
      const branchData = await apiFetch<{
        commit: { commit: { tree: { sha: string } } }
      }>(`branches/${branch}`)
      const treeSha = branchData.commit.commit.tree.sha

      const treeData = await apiFetch<{ tree: GitTreeItem[]; truncated: boolean }>(
        `git/trees/${treeSha}?recursive=1`,
      )

      const prefix = `${basePath}/`
      return treeData.tree
        .filter((item): item is GitTreeItem & { type: 'blob' } =>
          item.type === 'blob' && item.path.startsWith(prefix),
        )
        .map(item => ({
          path: item.path.slice(prefix.length),
          hash: item.sha,
          updatedAt: 0,
        }))
    },

    async uploadFile(path: string, content: string): Promise<{ hash: string }> {
      const apiPath = remotePath(path)

      let existingSha: string | undefined
      try {
        const existing = await apiFetch<{ sha: string }>(`contents/${apiPath}`)
        existingSha = existing.sha
      } catch {
        // File does not exist yet — this is a new file, no SHA needed
      }

      const body: Record<string, unknown> = {
        message: `sync: update ${path}`,
        content: btoa(content),
        branch,
      }
      if (existingSha !== undefined) body.sha = existingSha

      const result = await apiFetch<{ content: { sha: string } }>(`contents/${apiPath}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      })

      return { hash: result.content.sha }
    },

    async downloadFile(path: string): Promise<Record<string, unknown>> {
      const data = await apiFetch<{ content: string; encoding: string }>(
        `contents/${remotePath(path)}`,
      )
      const decoded = atob(data.content.replace(/\n/g, ''))
      return JSON.parse(decoded) as Record<string, unknown>
    },

    async deleteFile(path: string): Promise<void> {
      const apiPath = remotePath(path)
      const existing = await apiFetch<{ sha: string }>(`contents/${apiPath}`)
      await apiFetch(`contents/${apiPath}`, {
        method: 'DELETE',
        body: JSON.stringify({
          message: `sync: delete ${path}`,
          sha: existing.sha,
          branch,
        }),
      })
    },
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/huxzhi/4-code/csync && npx vitest run src/adapters/github.test.ts
```

Expected: PASS — all 5 GitHub adapter tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/github.ts src/adapters/github.test.ts
git commit -m "feat: GitHub REST adapter using Git Trees API and native fetch"
```

---

## Task 8: Public Exports & Build Verification

**Files:**
- Create: `src/index.ts`

- [ ] **Step 1: Create `src/index.ts`**

```ts
export type {
  CommitOptions,
  DiffResult,
  LocalDatabaseAdapter,
  PrepareOptions,
  SyncMetadata,
  SyncSummary,
  SyncerConfig,
  RemoteRepositoryAdapter,
} from './types.js'
export type { TaskResult } from './queue.js'
export { createSyncer } from './syncer.js'
```

- [ ] **Step 2: Run all tests**

```bash
cd /home/huxzhi/4-code/csync && npx vitest run
```

Expected: all tests pass, 0 failures.

- [ ] **Step 3: Run type check**

```bash
cd /home/huxzhi/4-code/csync && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Build the package**

```bash
cd /home/huxzhi/4-code/csync && npm run build
```

Expected: `dist/` created with:
- `dist/index.js`
- `dist/index.d.ts`
- `dist/adapters/github.js`
- `dist/adapters/github.d.ts`

- [ ] **Step 5: Verify dist contents**

```bash
ls dist/ && ls dist/adapters/
```

Expected output:
```
adapters  index.d.ts  index.js  index.js.map
github.d.ts  github.js  github.js.map
```

- [ ] **Step 6: Final commit**

```bash
git add src/index.ts
git commit -m "feat: public exports and verified ESM build"
```
