import { beforeEach, describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createSyncer } from '../src/syncer.js'
import type { LocalDatabaseAdapter, RemoteRepositoryAdapter, SyncMetadata } from '../src/types.js'

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
  resolveTags?: (path: string, hash: string, updatedAt: number) => string[] | undefined,
): RemoteRepositoryAdapter {
  return {
    getRemoteManifest: () =>
      Promise.resolve(
        [...files.entries()].map(([path, f]) => ({ path, hash: f.hash, updatedAt: 0 })),
      ),
    uploadFile: (meta, content) => {
      const hash = `hash-${meta.path}`
      files.set(meta.path, { content, hash })
      return Promise.resolve({ path: meta.path, hash, updatedAt: Date.now() })
    },
    downloadFile: path => {
      const f = files.get(path)
      if (!f) throw new Error(`Not found: ${path}`)
      return Promise.resolve({ content: f.content, meta: { path, hash: f.hash, updatedAt: Date.now() } })
    },
    deleteFile: path => {
      files.delete(path)
      return Promise.resolve()
    },
    resolveTags,
  }
}

const paths = (arr: SyncMetadata[]) => arr.map(m => m.path)

describe('resolveTags()', () => {
  it('enriches remote manifest entries with tags from the resolver', async () => {
    const localRecords = new Map<string, { content: ArrayBuffer; meta: SyncMetadata }>()
    const remoteFiles = new Map([
      ['work/a.json', { content: toBuffer('{}'), hash: 'h1' }],
      ['personal/b.json', { content: toBuffer('{}'), hash: 'h2' }],
    ])
    const syncer = createSyncer({
      local: makeLocalAdapter(localRecords),
      remote: makeRemoteAdapter(remoteFiles, (path) => (path.startsWith('work/') ? ['work'] : ['personal'])),
      dbName: 'test-resolve-tags',
    })
    const diff = await syncer.prepare()
    const workEntry = diff.download.find(m => m.path === 'work/a.json')
    const personalEntry = diff.download.find(m => m.path === 'personal/b.json')
    expect(workEntry?.tags).toContain('work')
    expect(personalEntry?.tags).toContain('personal')
  })

  it('commit with tags filters to matching entries only', async () => {
    const localRecords = new Map<string, { content: ArrayBuffer; meta: SyncMetadata }>()
    const remoteFiles = new Map([
      ['work/a.json', { content: toBuffer('{}'), hash: 'h1' }],
      ['personal/b.json', { content: toBuffer('{}'), hash: 'h2' }],
    ])
    const syncer = createSyncer({
      local: makeLocalAdapter(localRecords),
      remote: makeRemoteAdapter(remoteFiles, (path) => (path.startsWith('work/') ? ['work'] : ['personal'])),
      dbName: 'test-resolve-tags-commit',
    })
    const diff = await syncer.prepare()
    const summary = await syncer.commit(diff, { tags: ['work'] })
    expect(summary.downloaded).toContain('work/a.json')
    expect(summary.downloaded).not.toContain('personal/b.json')
  })
})

describe('tag mismatch — same path, different tags on local vs remote', () => {
  it('surfaces as conflict rather than silently uploading or deleting', async () => {
    // local: a.json tagged ['work'] (dirty)
    // remote: a.json tagged ['personal'] (different content)
    // Old (buggy): remote filtered out → treated as "doesn't exist" → upload (overwrites personal file!)
    // New (correct): full diff detects dirty-local + modified-remote → conflict surfaced
    const localRecords = new Map([
      ['a.json', { content: toBuffer('{"v":"local"}'), meta: { path: 'a.json', hash: '', updatedAt: 2, tags: ['work'] } }],
    ])
    const remoteFiles = new Map([['a.json', { content: toBuffer('{"v":"personal"}'), hash: 'personal-hash' }]])
    const syncer = createSyncer({
      local: makeLocalAdapter(localRecords),
      remote: makeRemoteAdapter(remoteFiles, () => ['personal']),
      dbName: 'test-tag-mismatch',
    })
    const diff = await syncer.prepare()
    // Must NOT silently upload (would overwrite the personal file)
    expect(paths(diff.upload)).not.toContain('a.json')
    // Must surface as conflict so the user can decide
    expect(diff.conflict.some(c => c.path === 'a.json')).toBe(true)
    const c = diff.conflict.find(c => c.path === 'a.json')!
    expect(c.local?.tags).toContain('work')
    expect(c.remote?.tags).toContain('personal')
  })

  it('does not delete remote file with different tag when commit filters by old tag', async () => {
    // local deleted a.json; remote still has it but resolveTags now returns ['personal']
    // baseline has a.json with ['work'] tag
    // prepare() → deleteRemote (local deleted, remote hash unchanged)
    // commit(diff, { tags: ['work'] }) → remote entry has ['personal'], filtered out → NOT deleted
    const seedLocal = new Map([
      ['a.json', { content: toBuffer('{}'), meta: { path: 'a.json', hash: 'orig', updatedAt: 0, tags: ['work'] } }],
    ])
    const remoteFiles = new Map([['a.json', { content: toBuffer('{}'), hash: 'orig' }]])
    const seeder = createSyncer({
      local: makeLocalAdapter(seedLocal),
      remote: makeRemoteAdapter(remoteFiles, () => ['work']),
      dbName: 'test-tag-mismatch-delete',
    })
    await seeder.commit(await seeder.prepare())

    // Now: local has nothing, remote has it with ['personal'] tag
    const emptyLocal = new Map<string, { content: ArrayBuffer; meta: SyncMetadata }>()
    const syncer = createSyncer({
      local: makeLocalAdapter(emptyLocal),
      remote: makeRemoteAdapter(remoteFiles, () => ['personal']),
      dbName: 'test-tag-mismatch-delete',
    })
    const diff = await syncer.prepare()
    // prepare sees deleteRemote (local deleted, remote hash unchanged)
    expect(paths(diff.deleteRemote)).toContain('a.json')
    // but the remote entry carries ['personal'] tag
    expect(diff.deleteRemote.find(m => m.path === 'a.json')?.tags).toContain('personal')

    // commit with ['work'] tag filters: remote entry has ['personal'] → skipped → file preserved
    const summary = await syncer.commit(diff, { tags: ['work'] })
    expect(summary.deletedRemote).not.toContain('a.json')
    expect(remoteFiles.has('a.json')).toBe(true)
  })
})

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
    expect(paths(diff.download)).toContain('notes/a.json')
  })

  it('returns full diff with all entries regardless of tags', async () => {
    const localRecords = new Map([
      ['work/a.json', { content: toBuffer('{}'), meta: { path: 'work/a.json', hash: '', updatedAt: 1, tags: ['work'] } }],
      ['personal/b.json', { content: toBuffer('{}'), meta: { path: 'personal/b.json', hash: '', updatedAt: 1, tags: ['personal'] } }],
    ])
    const syncer = createSyncer({
      local: makeLocalAdapter(localRecords),
      remote: makeRemoteAdapter(new Map()),
      dbName: 'test-prepare-no-tag-filter',
    })
    const diff = await syncer.prepare()
    expect(paths(diff.upload)).toContain('work/a.json')
    expect(paths(diff.upload)).toContain('personal/b.json')
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
    expect(paths(diff.deleteRemote)).toContain('notes/c.json')
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

  it('resolves conflict with local when onConflict is "local"', async () => {
    const dbName = 'test-conflict-local'
    const seedLocal = new Map([
      ['a.json', { content: toBuffer('{"v":0}'), meta: { path: 'a.json', hash: 'orig', updatedAt: 0 } }],
    ])
    const remoteFiles = new Map([['a.json', { content: toBuffer('{"v":0}'), hash: 'orig' }]])
    const seeder = createSyncer({ local: makeLocalAdapter(seedLocal), remote: makeRemoteAdapter(remoteFiles), dbName })
    await seeder.commit(await seeder.prepare())

    const localRecords = new Map([
      ['a.json', { content: toBuffer('{"v":"local"}'), meta: { path: 'a.json', hash: '', updatedAt: 2 } }],
    ])
    remoteFiles.set('a.json', { content: toBuffer('{"v":"remote"}'), hash: 'remote-changed' })
    const syncer = createSyncer({ local: makeLocalAdapter(localRecords), remote: makeRemoteAdapter(remoteFiles), dbName })
    const diff = await syncer.prepare({ onConflict: 'local' })
    expect(diff.conflict).toHaveLength(0)
    expect(paths(diff.upload)).toContain('a.json')
    const summary = await syncer.commit(diff)
    expect(summary.uploaded).toContain('a.json')
    expect(fromBuffer(remoteFiles.get('a.json')!.content)).toBe('{"v":"local"}')
  })

  it('resolves conflict with remote when onConflict is "remote"', async () => {
    const dbName = 'test-conflict-remote'
    const seedLocal = new Map([
      ['a.json', { content: toBuffer('{"v":0}'), meta: { path: 'a.json', hash: 'orig', updatedAt: 0 } }],
    ])
    const remoteFiles = new Map([['a.json', { content: toBuffer('{"v":0}'), hash: 'orig' }]])
    const seeder = createSyncer({ local: makeLocalAdapter(seedLocal), remote: makeRemoteAdapter(remoteFiles), dbName })
    await seeder.commit(await seeder.prepare())

    const localRecords = new Map([
      ['a.json', { content: toBuffer('{"v":"local"}'), meta: { path: 'a.json', hash: '', updatedAt: 2 } }],
    ])
    remoteFiles.set('a.json', { content: toBuffer('{"v":"remote"}'), hash: 'remote-changed' })
    const syncer = createSyncer({ local: makeLocalAdapter(localRecords), remote: makeRemoteAdapter(remoteFiles), dbName })
    const diff = await syncer.prepare({ onConflict: 'remote' })
    expect(diff.conflict).toHaveLength(0)
    expect(paths(diff.download)).toContain('a.json')
    const summary = await syncer.commit(diff)
    expect(summary.downloaded).toContain('a.json')
    expect(fromBuffer(localRecords.get('a.json')!.content)).toBe('{"v":"remote"}')
  })

  it('resolves conflict by newer updatedAt when onConflict is "newer"', async () => {
    const dbName = 'test-conflict-newer'
    const seedLocal = new Map([
      ['a.json', { content: toBuffer('{}'), meta: { path: 'a.json', hash: 'orig', updatedAt: 0 } }],
    ])
    const remoteFiles = new Map([['a.json', { content: toBuffer('{}'), hash: 'orig' }]])
    const seeder = createSyncer({ local: makeLocalAdapter(seedLocal), remote: makeRemoteAdapter(remoteFiles), dbName })
    await seeder.commit(await seeder.prepare())

    // local updatedAt=10 > remote (0 from makeRemoteAdapter) → local should win
    const localRecords = new Map([
      ['a.json', { content: toBuffer('{"v":"local"}'), meta: { path: 'a.json', hash: '', updatedAt: 10 } }],
    ])
    remoteFiles.set('a.json', { content: toBuffer('{"v":"remote"}'), hash: 'remote-changed' })
    const syncer = createSyncer({ local: makeLocalAdapter(localRecords), remote: makeRemoteAdapter(remoteFiles), dbName })
    const diff = await syncer.prepare({ onConflict: 'newer' })
    expect(diff.conflict).toHaveLength(0)
    expect(paths(diff.upload)).toContain('a.json')
    const summary = await syncer.commit(diff)
    expect(summary.uploaded).toContain('a.json')
    expect(fromBuffer(remoteFiles.get('a.json')!.content)).toBe('{"v":"local"}')
  })

  it('resolves conflict via custom onConflict function', async () => {
    const dbName = 'test-conflict-custom'
    const seedLocal = new Map([
      ['a.json', { content: toBuffer('{}'), meta: { path: 'a.json', hash: 'orig', updatedAt: 0 } }],
    ])
    const remoteFiles = new Map([['a.json', { content: toBuffer('{}'), hash: 'orig' }]])
    const seeder = createSyncer({ local: makeLocalAdapter(seedLocal), remote: makeRemoteAdapter(remoteFiles), dbName })
    await seeder.commit(await seeder.prepare())

    const localRecords = new Map([
      ['a.json', { content: toBuffer('{"v":"local"}'), meta: { path: 'a.json', hash: '', updatedAt: 2 } }],
    ])
    remoteFiles.set('a.json', { content: toBuffer('{"v":"remote"}'), hash: 'remote-changed' })
    const syncer = createSyncer({ local: makeLocalAdapter(localRecords), remote: makeRemoteAdapter(remoteFiles), dbName })
    const resolved: string[] = []
    const diff = await syncer.prepare({
      onConflict: ({ path }) => { resolved.push(path); return 'remote' },
    })
    expect(resolved).toContain('a.json')
    expect(diff.conflict).toHaveLength(0)
    expect(paths(diff.download)).toContain('a.json')
    const summary = await syncer.commit(diff)
    expect(summary.downloaded).toContain('a.json')
  })

  it('only commits entries matching tags when tags option is provided', async () => {
    const localRecords = new Map([
      ['work/a.json', { content: toBuffer('{}'), meta: { path: 'work/a.json', hash: '', updatedAt: 1, tags: ['work'] } }],
      ['personal/b.json', { content: toBuffer('{}'), meta: { path: 'personal/b.json', hash: '', updatedAt: 1, tags: ['personal'] } }],
    ])
    const remoteFiles = new Map<string, { content: ArrayBuffer; hash: string }>()
    const syncer = createSyncer({
      local: makeLocalAdapter(localRecords),
      remote: makeRemoteAdapter(remoteFiles),
      dbName: 'test-commit-tags',
    })
    const diff = await syncer.prepare()
    expect(paths(diff.upload)).toContain('work/a.json')
    expect(paths(diff.upload)).toContain('personal/b.json')

    const summary = await syncer.commit(diff, { tags: ['work'] })
    expect(summary.uploaded).toContain('work/a.json')
    expect(summary.uploaded).not.toContain('personal/b.json')
    expect(remoteFiles.has('work/a.json')).toBe(true)
    expect(remoteFiles.has('personal/b.json')).toBe(false)
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
