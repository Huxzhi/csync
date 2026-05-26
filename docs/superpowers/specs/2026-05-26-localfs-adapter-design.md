# LocalFS Adapter Design

**Date:** 2026-05-26
**Status:** Approved

## Overview

Add a `RemoteRepositoryAdapter` implementation that uses the browser's File System Access API to treat a local directory as the sync "remote". This lets apps sync IndexedDB records to/from a local folder on disk without a network backend.

## Interface

```ts
import { createLocalFSAdapter } from '@huxzhi/csync/adapters/localfs'

const handle = await showDirectoryPicker()

const remote = createLocalFSAdapter({
  handle,           // FileSystemDirectoryHandle — required, caller owns picker UI
  basePath?: string // optional subdirectory prefix inside handle root, default ''
  dbName?: string   // IndexedDB cache DB name, default 'csync-localfs-cache'
})

const syncer = createSyncer({ local, remote })
```

`showDirectoryPicker()` is called by the application, not the adapter. The adapter performs no browser UI. `basePath` defaults to empty (handle is the root).

The returned object satisfies `RemoteRepositoryAdapter` and is drop-in compatible with `createGitHubAdapter` / `createWebDAVAdapter`.

## Operations

### `getRemoteManifest()`

1. Recursively traverse the directory from the handle root (depth-first via `handle.values()`), applying `basePath` prefix filter if set.
2. For each file entry, read `file.lastModified` and `file.size`.
3. Look up path in the IndexedDB hash cache.
   - **Cache hit** (`lastModified` and `size` both unchanged): reuse cached SHA-256 hash.
   - **Cache miss**: read file `ArrayBuffer`, compute SHA-256 via `SubtleCrypto`, write result back to cache.
4. Return `SyncMetadata[]` with `path` (relative to handle root, `/`-separated), `hash` (SHA-256 hex), `updatedAt` (file `lastModified` mtime).

### `uploadFile(meta, content)`

1. Split `meta.path` into segments; traverse/create intermediate directories with `getDirectoryHandle(name, { create: true })`.
2. Get or create the file handle with `getFileHandle(name, { create: true })`.
3. Write `content` via `createWritable()` writable stream.
4. After `writable.close()`, call `fileHandle.getFile()` to read OS-assigned mtime.
5. Compute SHA-256 of written content, update cache entry.
6. Return `SyncMetadata` with new `hash` and `updatedAt: file.lastModified`.

### `downloadFile(path)`

1. Traverse directory tree to locate the file handle.
2. Read file as `ArrayBuffer`.
3. Compute SHA-256, update cache entry.
4. Return `{ content, meta: { path, hash, updatedAt: file.lastModified } }`.

### `deleteFile(path)`

1. Traverse to the parent directory handle.
2. Call `parentHandle.removeEntry(filename)`.
3. Remove cache entry for the path.
4. Throw `Error` if the path does not exist.

## Hash Cache

- **DB name:** `csync-localfs-cache` (overridable via `dbName` option)
- **Version:** 1
- **Object store:** `hashes`, keyed by path string
- **Record shape:**

```ts
{
  path: string         // relative file path
  lastModified: number // mtime at time of last hash computation
  size: number         // file size at time of last hash computation
  hash: string         // SHA-256 hex digest
}
```

- **Cache hit condition:** `entry.lastModified === file.lastModified && entry.size === file.size`
- **Implementation:** raw IndexedDB API, no third-party dependencies.

## Error Handling

| Situation | Behavior |
|---|---|
| File not found (`downloadFile` / `deleteFile`) | Throw `Error` |
| Permission error (File System Access API) | Let the browser error propagate; caller handles re-authorization |
| Missing intermediate directories (`uploadFile`) | Create automatically with `{ create: true }` |

## File Layout

```
src/adapters/localfs.ts         # adapter implementation
src/adapters/localfs.test.ts    # unit tests
```

README additions:
- One row in the adapters table: `@huxzhi/csync/adapters/localfs | Browser File System Access API`
- Usage example section showing `showDirectoryPicker()` + `createLocalFSAdapter`

## Testing Strategy

- `vitest` with mocked `FileSystemDirectoryHandle` / `FileSystemFileHandle` interfaces (or `happy-dom` if it provides them).
- Test cases: manifest scan (cache hit, cache miss, cache invalidation), upload with nested path creation, download, delete, SHA-256 correctness.
