import { beforeEach, describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { getBaseline, openStore, upsertBaselineEntry, removeBaselineEntry } from '../src/store.js'
import type { SyncMetadata } from '../src/types.js'

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
})

describe('openStore', () => {
  it('creates the baseline object store on first open', async () => {
    const db = await openStore('test-db')
    expect(db.objectStoreNames.contains('baseline')).toBe(true)
    db.close()
  })
})

describe('getBaseline', () => {
  it('returns empty array when no entries have been saved', async () => {
    const db = await openStore('test-db')
    const result = await getBaseline(db)
    expect(result).toEqual([])
    db.close()
  })
})

describe('upsertBaselineEntry / getBaseline', () => {
  it('persists a single entry and retrieves it', async () => {
    const db = await openStore('test-db')
    const entry: SyncMetadata = { path: 'notes/a.json', hash: 'abc123', updatedAt: 1000 }
    await upsertBaselineEntry(db, entry)
    const result = await getBaseline(db)
    expect(result).toEqual([entry])
    db.close()
  })

  it('overwrites an existing entry for the same path', async () => {
    const db = await openStore('test-db')
    await upsertBaselineEntry(db, { path: 'a.json', hash: 'old', updatedAt: 1 })
    await upsertBaselineEntry(db, { path: 'a.json', hash: 'new', updatedAt: 2 })
    const result = await getBaseline(db)
    expect(result).toHaveLength(1)
    expect(result[0].hash).toBe('new')
    db.close()
  })

  it('stores multiple entries independently', async () => {
    const db = await openStore('test-db')
    await upsertBaselineEntry(db, { path: 'a.json', hash: 'h1', updatedAt: 1 })
    await upsertBaselineEntry(db, { path: 'b.json', hash: 'h2', updatedAt: 2, tags: ['work'] })
    const result = await getBaseline(db)
    expect(result).toHaveLength(2)
    expect(result.find(m => m.path === 'b.json')?.tags).toEqual(['work'])
    db.close()
  })
})

describe('removeBaselineEntry', () => {
  it('removes an entry by path', async () => {
    const db = await openStore('test-db')
    await upsertBaselineEntry(db, { path: 'a.json', hash: 'h1', updatedAt: 1 })
    await upsertBaselineEntry(db, { path: 'b.json', hash: 'h2', updatedAt: 2 })
    await removeBaselineEntry(db, 'a.json')
    const result = await getBaseline(db)
    expect(result).toHaveLength(1)
    expect(result[0].path).toBe('b.json')
    db.close()
  })

  it('is a no-op when the path does not exist', async () => {
    const db = await openStore('test-db')
    await removeBaselineEntry(db, 'nonexistent.json')
    const result = await getBaseline(db)
    expect(result).toEqual([])
    db.close()
  })
})
