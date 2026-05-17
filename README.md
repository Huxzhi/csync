# @huxzhi/csync

Adapter-based file sync engine for browser and edge runtimes. Syncs records between a local database (IndexedDB) and a remote repository (GitHub, WebDAV, S3).

## Install

```bash
npm install @huxzhi/csync
```

## Adapters

| Import | Backend |
|---|---|
| `@huxzhi/csync/adapters/github` | GitHub Contents API |
| `@huxzhi/csync/adapters/webdav` | WebDAV (Nextcloud, etc.) |
| `@huxzhi/csync/adapters/s3` | S3-compatible (AWS, Cloudflare R2, etc.) |

## Usage

### Basic sync

```ts
import { createSyncer } from '@huxzhi/csync'
import { createGitHubAdapter } from '@huxzhi/csync/adapters/github'
import type { LocalDatabaseAdapter } from '@huxzhi/csync'

// Implement LocalDatabaseAdapter on top of your own IndexedDB store
const local: LocalDatabaseAdapter = {
  getLocalManifest: async () => {
    // return all records as SyncMetadata[]
    // { path, hash, updatedAt, tags? }
    // hash === '' means the record is dirty (pending upload)
  },
  getRecordContent: async (path) => {
    // return ArrayBuffer for the given path, or null if not found
  },
  upsertRecord: async (content, meta) => {
    // write content + meta into local storage
  },
  deleteRecordPermanently: async (path) => {
    // remove the record from local storage
  },
}

const remote = createGitHubAdapter({
  owner: 'your-username',
  repo: 'your-repo',
  branch: 'main',
  token: 'ghp_...',
  basePath: 'data',
})

const syncer = createSyncer({ local, remote })

const diff = await syncer.prepare()
const summary = await syncer.commit(diff)

console.log(summary.uploaded, summary.downloaded)
```

### Tag-based partial sync

Tag entries to sync only a subset. `resolveTags` is defined on the remote adapter so it can classify files by path or metadata. `commit` filters by the same tags.

```ts
const remote = createGitHubAdapter({ ... })
remote.resolveTags = (path) => {
  if (path.startsWith('work/')) return ['work']
  if (path.startsWith('personal/')) return ['personal']
}

const syncer = createSyncer({ local, remote })

const diff = await syncer.prepare()

// only upload/download entries tagged 'work'
const summary = await syncer.commit(diff, { tags: ['work'] })
```

### Conflict resolution

`prepare()` detects three-way conflicts (local dirty + remote changed since last sync). Use `onConflict` to resolve them automatically.

```ts
// force local wins
const diff = await syncer.prepare({ onConflict: 'local' })

// force remote wins
const diff = await syncer.prepare({ onConflict: 'remote' })

// newer updatedAt wins
const diff = await syncer.prepare({ onConflict: 'newer' })

// custom per-file logic
const diff = await syncer.prepare({
  onConflict: ({ path, local, remote, baseline }) => {
    return path.startsWith('shared/') ? 'remote' : 'local'
  },
})

const summary = await syncer.commit(diff)
console.log(summary.skippedConflicts) // paths left unresolved
```

### Conflict types

| Situation | `local` | `remote` |
|---|---|---|
| Both sides modified | dirty record | changed record |
| Local deleted, remote modified | `undefined` | changed record |
| Local modified, remote deleted | dirty record | `undefined` |

### Progress tracking

```ts
const summary = await syncer.commit(diff, {
  onProgress: (completed, total) => {
    console.log(`${completed}/${total}`)
  },
})
```

### Abort

```ts
const controller = new AbortController()

const diff = await syncer.prepare({ signal: controller.signal })
const summary = await syncer.commit(diff, { signal: controller.signal })

controller.abort() // cancels in-flight tasks
```

## API

### `createSyncer(config)`

| Option | Type | Description |
|---|---|---|
| `local` | `LocalDatabaseAdapter` | Local IndexedDB adapter |
| `remote` | `RemoteRepositoryAdapter` | Remote storage adapter |
| `dbName` | `string` | IndexedDB database name (default: `csync-baseline`) |
| `concurrency` | `number` | Max parallel tasks (default: `5`) |
| `timeout` | `number` | Per-task timeout in ms |
| `maxRetries` | `number` | Retry attempts on failure (default: `3`) |

### `syncer.prepare(options?)`

Fetches local and remote manifests, computes a three-way diff against the stored baseline, and resolves conflicts. Returns a `DiffResult` — no writes happen yet.

| Option | Type | Description |
|---|---|---|
| `onConflict` | `'skip' \| 'local' \| 'remote' \| 'newer' \| function` | Conflict strategy (default: `'skip'`) |
| `signal` | `AbortSignal` | Cancellation signal |

### `syncer.commit(diff, options?)`

Executes the diff: uploads, downloads, and deletes. Each completed entry is written to the baseline immediately. Returns a `SyncSummary`.

| Option | Type | Description |
|---|---|---|
| `tags` | `string[]` | Only commit entries matching at least one tag |
| `signal` | `AbortSignal` | Cancellation signal |
| `onProgress` | `(completed, total) => void` | Progress callback |

### `RemoteRepositoryAdapter`

```ts
interface RemoteRepositoryAdapter {
  getRemoteManifest(): Promise<SyncMetadata[]>
  uploadFile(meta: SyncMetadata, content: ArrayBuffer): Promise<SyncMetadata>
  downloadFile(path: string): Promise<{ content: ArrayBuffer; meta: SyncMetadata }>
  deleteFile(path: string): Promise<void>
  resolveTags?(path: string, hash: string, updatedAt: number): string[] | undefined
}
```

## License

MIT
