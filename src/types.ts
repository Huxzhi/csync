export interface SyncMetadata {
  path: string
  hash: string
  updatedAt: number
  tags?: string[]
}

export interface DiffResult {
  upload: SyncMetadata[]        // local metadata of files to upload
  download: SyncMetadata[]      // remote metadata of files to download
  deleteRemote: SyncMetadata[]  // remote metadata of files to delete from remote
  deleteLocal: SyncMetadata[]   // local metadata of files to delete locally
  conflict: {
    path: string
    local: SyncMetadata | undefined    // undefined = locally deleted
    remote: SyncMetadata | undefined   // undefined = remotely deleted
    baseline: SyncMetadata | undefined
  }[]
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
  getRecordContent: (path: string) => Promise<ArrayBuffer | null>
  upsertRecord: (content: ArrayBuffer, meta: SyncMetadata) => Promise<void>
  deleteRecordPermanently: (path: string) => Promise<void>
}

export interface RemoteRepositoryAdapter {
  getRemoteManifest: () => Promise<SyncMetadata[]>
  uploadFile: (
    meta: SyncMetadata,
    content: ArrayBuffer,
  ) => Promise<SyncMetadata>
  downloadFile: (
    path: string,
  ) => Promise<{ content: ArrayBuffer; meta: SyncMetadata }>
  deleteFile: (path: string) => Promise<void>
  resolveTags?: (path: string, hash: string, updatedAt: number) => string[] | undefined
}

export interface SyncerConfig {
  local: LocalDatabaseAdapter
  remote: RemoteRepositoryAdapter
  dbName?: string
  concurrency?: number
  timeout?: number
  maxRetries?: number
}

export type ConflictResolution = 'local' | 'remote' | 'skip'

export type ConflictStrategy =
  | ConflictResolution
  | 'newer'
  | ((conflict: {
      path: string
      local: SyncMetadata | undefined
      remote: SyncMetadata | undefined
      baseline: SyncMetadata | undefined
    }) => ConflictResolution)

export interface PrepareOptions {
  signal?: AbortSignal
  onConflict?: ConflictStrategy
}

export interface CommitOptions {
  signal?: AbortSignal
  tags?: string[]
  onProgress?: (completed: number, total: number) => void
}
