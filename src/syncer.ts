import type {
  SyncerConfig,
  PrepareOptions,
  CommitOptions,
  ConflictResolution,
  DiffResult,
  SyncSummary,
  SyncMetadata,
} from './types.js'
import { openStore, getBaseline, upsertBaselineEntry, removeBaselineEntry } from './store.js'
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

  async function prepare(options: PrepareOptions = {}): Promise<DiffResult> {
    const { signal, onConflict = 'skip' } = options
    const db = await dbPromise

    console.log('[csync] fetching remote manifest...')
    const [localManifest, remoteManifest, baseline] = await Promise.all([
      local.getLocalManifest(),
      remote.getRemoteManifest(),
      getBaseline(db),
    ])
    console.log(`[csync] remote manifest: ${remoteManifest.length} file(s)`)

    const enrichedRemote = remote.resolveTags
      ? remoteManifest.map(m => ({ ...m, tags: remote.resolveTags!(m.path, m.hash, m.updatedAt) ?? m.tags }))
      : remoteManifest

    if (signal?.aborted) throw new Error('Aborted')

    let diff = computeDiff(localManifest, enrichedRemote, baseline)

    if (onConflict === 'skip' || diff.conflict.length === 0) return diff

    const resolveOne = (c: { path: string; local: SyncMetadata | undefined; remote: SyncMetadata | undefined; baseline: SyncMetadata | undefined }): ConflictResolution => {
      if (typeof onConflict === 'function') return onConflict(c)
      if (onConflict === 'newer') {
        if (c.local === undefined) return 'remote'
        if (c.remote === undefined) return 'local'
        return c.local.updatedAt >= c.remote.updatedAt ? 'local' : 'remote'
      }
      return onConflict
    }

    const upload = [...diff.upload]
    const download = [...diff.download]
    const deleteRemote = [...diff.deleteRemote]
    const deleteLocal = [...diff.deleteLocal]
    const conflict: DiffResult['conflict'] = []

    for (const c of diff.conflict) {
      const resolution = resolveOne(c)
      if (resolution === 'local') {
        if (c.local !== undefined) upload.push(c.local)
        else if (c.remote !== undefined) deleteRemote.push(c.remote)
      } else if (resolution === 'remote') {
        if (c.remote !== undefined) download.push(c.remote)
        else if (c.local !== undefined) deleteLocal.push(c.local)
      } else {
        conflict.push(c)
      }
    }

    return { upload, download, deleteRemote, deleteLocal, conflict }
  }

  async function commit(diff: DiffResult, options: CommitOptions = {}): Promise<SyncSummary> {
    const { signal, tags, onProgress } = options
    const db = await dbPromise

    let activeDiff = diff
    if (tags && tags.length > 0) {
      const tagSet = new Set(tags)
      const hasTag = (m: SyncMetadata) => m.tags?.some(t => tagSet.has(t)) ?? false
      activeDiff = {
        upload: diff.upload.filter(hasTag),
        download: diff.download.filter(hasTag),
        deleteRemote: diff.deleteRemote.filter(hasTag),
        deleteLocal: diff.deleteLocal.filter(hasTag),
        conflict: diff.conflict.filter(c =>
          (c.local && hasTag(c.local)) || (c.remote && hasTag(c.remote)) || (c.baseline && hasTag(c.baseline))
        ),
      }
    }

    type TaskMeta =
      | { op: 'upload'; meta: SyncMetadata }
      | { op: 'download'; meta: SyncMetadata }
      | { op: 'deleteRemote'; meta: SyncMetadata }
      | { op: 'deleteLocal'; meta: SyncMetadata }

    const taskMetas: TaskMeta[] = []
    for (const meta of activeDiff.upload) taskMetas.push({ op: 'upload', meta })
    for (const meta of activeDiff.download) taskMetas.push({ op: 'download', meta })
    for (const meta of activeDiff.deleteRemote) taskMetas.push({ op: 'deleteRemote', meta })
    for (const meta of activeDiff.deleteLocal) taskMetas.push({ op: 'deleteLocal', meta })

    const tasks = taskMetas.map((taskMeta) => async (): Promise<void> => {
      if (taskMeta.op === 'upload') {
        const { meta } = taskMeta
        const data = await local.getRecordContent(meta.path)
        if (!data) throw new Error(`No content for ${meta.path}`)
        console.log(`[csync] uploading ${meta.path}`)
        const remoteMeta = await remote.uploadFile(meta, data)
        console.log(`[csync] uploaded ${meta.path} (hash: ${remoteMeta.hash})`)
        const updatedMeta: SyncMetadata = { ...remoteMeta, tags: meta.tags }
        await local.upsertRecord(data, updatedMeta)
        await upsertBaselineEntry(db, updatedMeta)
        return
      }

      if (taskMeta.op === 'download') {
        const { meta } = taskMeta
        console.log(`[csync] downloading ${meta.path}`)
        const { content, meta: fetchedMeta } = await remote.downloadFile(meta.path)
        const hash = fetchedMeta.hash || meta.hash || ''
        console.log(`[csync] downloaded ${meta.path} (hash: ${hash})`)
        const finalMeta: SyncMetadata = { ...fetchedMeta, hash, tags: meta.tags }
        await local.upsertRecord(content, finalMeta)
        await upsertBaselineEntry(db, finalMeta)
        return
      }

      if (taskMeta.op === 'deleteRemote') {
        console.log(`[csync] deleting remote ${taskMeta.meta.path}`)
        await remote.deleteFile(taskMeta.meta.path)
        await removeBaselineEntry(db, taskMeta.meta.path)
        return
      }

      // deleteLocal
      await local.deleteRecordPermanently(taskMeta.meta.path)
      await removeBaselineEntry(db, taskMeta.meta.path)
    })

    const results = await runWithConcurrency(tasks, { concurrency, timeout, maxRetries, signal, onProgress })

    const summary: SyncSummary = {
      uploaded: [],
      downloaded: [],
      deletedRemote: [],
      deletedLocal: [],
      skippedConflicts: activeDiff.conflict.map(c => c.path),
      failed: [],
    }

    for (let i = 0; i < taskMetas.length; i++) {
      const taskMeta = taskMetas[i]
      const result = results[i]
      const path = taskMeta.meta.path

      if (result.status === 'rejected') {
        summary.failed.push({ path, reason: result.reason })
        continue
      }

      if (taskMeta.op === 'upload') summary.uploaded.push(path)
      else if (taskMeta.op === 'download') summary.downloaded.push(path)
      else if (taskMeta.op === 'deleteRemote') summary.deletedRemote.push(path)
      else if (taskMeta.op === 'deleteLocal') summary.deletedLocal.push(path)
    }

    return summary
  }

  return { prepare, commit }
}
