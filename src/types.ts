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
  getRecordContent: (path: string) => Promise<ArrayBuffer | null>
  upsertRecord: (content: ArrayBuffer, meta: SyncMetadata) => Promise<void>
  deleteRecordPermanently: (path: string) => Promise<void>
}

export interface RemoteRepositoryAdapter {
  getRemoteManifest: () => Promise<SyncMetadata[]>
  uploadFile: (path: string, content: ArrayBuffer, currentHash?: string) => Promise<{ hash: string }>
  downloadFile: (path: string) => Promise<ArrayBuffer>
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
