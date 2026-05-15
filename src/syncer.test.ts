import { beforeEach, describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createSyncer } from './syncer.js'
import type { LocalDatabaseAdapter, RemoteRepositoryAdapter, SyncMetadata } from './types.js'

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
})

const enc = new TextEncoder()
const dec = new TextDecoder()

function toBuffer(s: string): ArrayBuffer {
  return enc.encode(s).buffer as ArrayBuffer
}

function fromBuffer(b: ArrayBuffer): string {
  return dec.decode(b)
}

function makeLocalAdapter(
  records: Map<string, { content: ArrayBuffer; meta: SyncMetadata }>,
): LocalDatabaseAdapter {
  return {
    getLocalManifest: () => Promise.resolve([...records.values()].map(r => r.meta)),
    getRecordContent: path => Promise.resolve(records.get(path)?.content ?? null),
    upsertRecord: (content, meta) => {
      records.set(meta.path, { content, meta })
      return Promise.resolve()
    },
    deleteRecordPermanently: path => {
      records.delete(path)
      return Promise.resolve()
    },
  }
}

function makeRemoteAdapter(
  files: Map<string, { content: ArrayBuffer; hash: string }>,
): RemoteRepositoryAdapter {
  return {
    getRemoteManifest: () =>
      Promise.resolve(
        [...files.entries()].map(([path, f]) => ({ path, hash: f.hash, updatedAt: 0 })),
      ),
    uploadFile: (path, content) => {
      const hash = `hash-${path}`
      files.set(path, { content, hash })
      return Promise.resolve({ hash })
    },
    downloadFile: path => {
      const f = files.get(path)
      if (!f) throw new Error(`Not found: ${path}`)
      return Promise.resolve(f.content)
    },
    deleteFile: path => {
      files.delete(path)
      return Promise.resolve()
    },
  }
}

describe('prepare()', () => {
  it('downloads new remote records when no baseline exists', async () => {
    const localRecords = new Map<string, { content: ArrayBuffer; meta: SyncMetadata }>()
    const remoteFiles = new Map([['notes/a.json', { content: toBuffer('{"text":"old"}'), hash: 'old-hash' }]])
    const syncer = createSyncer({
      local: makeLocalAdapter(localRecords),
      remote: makeRemoteAdapter(remoteFiles),
      dbName: 'test-prepare-1',
    })
    const diff = await syncer.prepare()
    expect(diff.download).toContain('notes/a.json')
  })

  it('filters by tags when tags option is provided', async () => {
    const localRecords = new Map([
      ['work/a.json', { content: toBuffer('{}'), meta: { path: 'work/a.json', hash: '', updatedAt: 1, tags: ['work'] } }],
      ['personal/b.json', { content: toBuffer('{}'), meta: { path: 'personal/b.json', hash: '', updatedAt: 1, tags: ['personal'] } }],
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
  it('uploads dirty records, updates local hash, and adds to baseline', async () => {
    const localRecords = new Map([
      ['notes/a.json', { content: toBuffer('{"text":"hello"}'), meta: { path: 'notes/a.json', hash: '', updatedAt: 1 } }],
    ])
    const remoteFiles = new Map<string, { content: ArrayBuffer; hash: string }>()
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
    expect(localRecords.get('notes/a.json')?.meta.hash).not.toBe('')
  })

  it('downloads remote-only records into local', async () => {
    const localRecords = new Map<string, { content: ArrayBuffer; meta: SyncMetadata }>()
    const remoteFiles = new Map([['notes/b.json', { content: toBuffer('{"text":"remote data"}'), hash: 'r-hash' }]])
    const syncer = createSyncer({
      local: makeLocalAdapter(localRecords),
      remote: makeRemoteAdapter(remoteFiles),
      dbName: 'test-download',
    })
    const diff = await syncer.prepare()
    const summary = await syncer.commit(diff)
    expect(summary.downloaded).toContain('notes/b.json')
    expect(fromBuffer(localRecords.get('notes/b.json')!.content)).toBe('{"text":"remote data"}')
    expect(localRecords.get('notes/b.json')?.meta.hash).toBe('r-hash')
  })

  it('deletes locally-removed records from remote', async () => {
    const dbName = 'test-delete-remote'
    const seedLocal = new Map([
      ['notes/c.json', { content: toBuffer('{"x":1}'), meta: { path: 'notes/c.json', hash: 'h1', updatedAt: 1 } }],
    ])
    const remoteFiles = new Map([['notes/c.json', { content: toBuffer('{"x":1}'), hash: 'h1' }]])
    const seeder = createSyncer({ local: makeLocalAdapter(seedLocal), remote: makeRemoteAdapter(remoteFiles), dbName })
    await seeder.commit(await seeder.prepare())

    const emptyLocal = new Map<string, { content: ArrayBuffer; meta: SyncMetadata }>()
    const syncer = createSyncer({ local: makeLocalAdapter(emptyLocal), remote: makeRemoteAdapter(remoteFiles), dbName })
    const diff = await syncer.prepare()
    expect(diff.deleteRemote).toContain('notes/c.json')
    const summary = await syncer.commit(diff)
    expect(summary.deletedRemote).toContain('notes/c.json')
    expect(remoteFiles.has('notes/c.json')).toBe(false)
  })

  it('skips conflict entries and records them in skippedConflicts', async () => {
    const dbName = 'test-conflict'
    const seedLocal = new Map([
      ['a.json', { content: toBuffer('{"v":0}'), meta: { path: 'a.json', hash: 'orig', updatedAt: 0 } }],
    ])
    const remoteFiles = new Map([['a.json', { content: toBuffer('{"v":0}'), hash: 'orig' }]])
    const seeder = createSyncer({ local: makeLocalAdapter(seedLocal), remote: makeRemoteAdapter(remoteFiles), dbName })
    await seeder.commit(await seeder.prepare())

    const localRecords = new Map([
      ['a.json', { content: toBuffer('{"v":1}'), meta: { path: 'a.json', hash: '', updatedAt: 2 } }],
    ])
    remoteFiles.set('a.json', { content: toBuffer('{"v":2}'), hash: 'remote-changed' })
    const syncer = createSyncer({ local: makeLocalAdapter(localRecords), remote: makeRemoteAdapter(remoteFiles), dbName })
    const diff = await syncer.prepare()
    const summary = await syncer.commit(diff)
    expect(summary.skippedConflicts).toContain('a.json')
    expect(summary.uploaded).not.toContain('a.json')
  })

  it('calls onProgress for each completed task', async () => {
    const localRecords = new Map([
      ['a.json', { content: toBuffer('{}'), meta: { path: 'a.json', hash: '', updatedAt: 1 } }],
      ['b.json', { content: toBuffer('{}'), meta: { path: 'b.json', hash: '', updatedAt: 1 } }],
    ])
    const syncer = createSyncer({
      local: makeLocalAdapter(localRecords),
      remote: makeRemoteAdapter(new Map()),
      dbName: 'test-progress',
      concurrency: 1,
    })
    const diff = await syncer.prepare()
    const progress: [number, number][] = []
    await syncer.commit(diff, { onProgress: (c, t) => progress.push([c, t]) })
    expect(progress.length).toBe(2)
    expect(progress[progress.length - 1][0]).toBe(2)
  })
})
