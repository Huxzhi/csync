# @huxzhi/csync

Adapter-based file sync engine for browser and edge runtimes. Syncs records between a local database (IndexedDB) and a remote repository (GitHub, WebDAV, S3).

## Install

```bash
npm install @huxzhi/csync
```

## Usage

```ts
import { createSyncer } from '@huxzhi/csync'
import { createGitHubAdapter } from '@huxzhi/csync/adapters/github'

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
```

## Adapters

| Import | Backend |
|---|---|
| `@huxzhi/csync/adapters/github` | GitHub Contents API |
| `@huxzhi/csync/adapters/webdav` | WebDAV (Nextcloud, etc.) |
| `@huxzhi/csync/adapters/s3` | S3-compatible (AWS, Cloudflare R2, etc.) |

## License

MIT
