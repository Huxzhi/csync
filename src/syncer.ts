import type {
  SyncerConfig,
  PrepareOptions,
  CommitOptions,
  DiffResult,
  SyncSummary,
  SyncMetadata,
} from './types.js'
import { openStore, getBaseline, saveBaseline } from './store.js'
import { computeDiff } from './diff.js'
import { runWithConcurrency } from './queue.js'

const DEFAULT_DB_NAME = 'csync-baseline'
const DEFAULT_CONCURRENCY = 5
const DEFAULT_MAX_RETRIES = 3

export function createSyncer(config: SyncerConfig) {
  const { local, remote } = config
  const dbName = config.dbName ?? DEFAULT_DB_NAME
  const concurrency = config.concurrency ?? DEFAULT_CONCURRENCY
  const timeout = config.timeout
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES

  const dbPromise = openStore(dbName)
  let lastRemoteMap = new Map<string, SyncMetadata>()
  let lastLocalMap = new Map<string, SyncMetadata>()

  async function prepare(options: PrepareOptions = {}): Promise<DiffResult> {
    const { signal, tags } = options
    const db = await dbPromise

    const [localManifest, remoteManifest, baseline] = await Promise.all([
      local.getLocalManifest(),
      remote.getRemoteManifest(),
      getBaseline(db),
    ])

    lastRemoteMap = new Map(remoteManifest.map(m => [m.path, m]))
    lastLocalMap = new Map(localManifest.map(m => [m.path, m]))

    let filteredLocal = localManifest
    let filteredRemote = remoteManifest
    let filteredBaseline = baseline

    if (tags && tags.length > 0) {
      const tagSet = new Set(tags)
      filteredLocal = localManifest.filter(m => m.tags?.some(t => tagSet.has(t)))
      filteredRemote = remoteManifest.filter(m => m.tags?.some(t => tagSet.has(t)))
      filteredBaseline = baseline.filter(m => m.tags?.some(t => tagSet.has(t)))
    }

    if (signal?.aborted) throw new Error('Aborted')

    return computeDiff(filteredLocal, filteredRemote, filteredBaseline)
  }

  async function commit(diff: DiffResult, options: CommitOptions = {}): Promise<SyncSummary> {
    const { signal, onProgress } = options
    const db = await dbPromise
    const baseline = await getBaseline(db)
    const baselineMap = new Map(baseline.map(m => [m.path, m]))

    type TaskMeta = { op: 'upload' | 'download' | 'deleteRemote' | 'deleteLocal' | 'conflict'; path: string }
    const taskMetas: TaskMeta[] = []

    for (const path of diff.upload) taskMetas.push({ op: 'upload', path })
    for (const path of diff.download) taskMetas.push({ op: 'download', path })
    for (const path of diff.deleteRemote) taskMetas.push({ op: 'deleteRemote', path })
    for (const path of diff.deleteLocal) taskMetas.push({ op: 'deleteLocal', path })
    for (const { path } of diff.conflict) taskMetas.push({ op: 'conflict', path })

    // Returns updated SyncMetadata on success, null on delete, throws on error
    const tasks = taskMetas.map(({ op, path }) => async (): Promise<SyncMetadata | null> => {
      if (op === 'upload') {
        const data = await local.getRecordContent(path)
        if (!data) throw new Error(`No content for ${path}`)
        const currentHash = lastLocalMap.get(path)?.hash || undefined
        const { hash } = await remote.uploadFile(path, data, currentHash)
        const localMeta = lastLocalMap.get(path)
        const updatedMeta: SyncMetadata = {
          path,
          hash,
          updatedAt: localMeta?.updatedAt ?? Date.now(),
          tags: localMeta?.tags,
        }
        await local.upsertRecord(data, updatedMeta)
        return updatedMeta
      }

      if (op === 'download') {
        const data = await remote.downloadFile(path)
        const remoteMeta = lastRemoteMap.get(path)
        const hash = remoteMeta?.hash ?? ''
        const updatedAt = remoteMeta?.updatedAt ?? Date.now()
        const tags = remoteMeta?.tags
        await local.upsertRecord(data, { path, hash, updatedAt, tags })
        return { path, hash, updatedAt, tags }
      }

      if (op === 'deleteRemote') {
        await remote.deleteFile(path)
        return null
      }

      if (op === 'deleteLocal') {
        await local.deleteRecordPermanently(path)
        return null
      }

      // conflict — skip, no-op
      return baselineMap.get(path) ?? null
    })

    const results = await runWithConcurrency(tasks, { concurrency, timeout, maxRetries, signal, onProgress })

    const summary: SyncSummary = {
      uploaded: [],
      downloaded: [],
      deletedRemote: [],
      deletedLocal: [],
      skippedConflicts: [],
      failed: [],
    }

    const newBaselineEntries: SyncMetadata[] = []
    const removedPaths = new Set<string>()

    for (let i = 0; i < taskMetas.length; i++) {
      const { op, path } = taskMetas[i]
      const result = results[i]

      if (result.status === 'rejected') {
        if (op !== 'conflict') summary.failed.push({ path, reason: result.reason })
        continue
      }

      const meta = result.value

      if (op === 'conflict') {
        summary.skippedConflicts.push(path)
        if (meta) newBaselineEntries.push(meta)
        continue
      }

      if (op === 'upload') {
        summary.uploaded.push(path)
        if (meta) newBaselineEntries.push(meta)
      } else if (op === 'download') {
        summary.downloaded.push(path)
        if (meta) newBaselineEntries.push(meta)
      } else if (op === 'deleteRemote') {
        summary.deletedRemote.push(path)
        removedPaths.add(path)
      } else if (op === 'deleteLocal') {
        summary.deletedLocal.push(path)
        removedPaths.add(path)
      }
    }

    // Rebuild baseline: keep unchanged entries, replace updated ones, remove deleted ones
    const updatedPaths = new Set(newBaselineEntries.map(m => m.path))
    const keptBaseline = baseline.filter(m => !updatedPaths.has(m.path) && !removedPaths.has(m.path))
    await saveBaseline(db, [...keptBaseline, ...newBaselineEntries])

    return summary
  }

  return { prepare, commit }
}
