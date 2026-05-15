import { beforeEach, describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { getBaseline, openStore, saveBaseline } from './store.js'
import type { SyncMetadata } from './types.js'

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
  it('returns empty array when no snapshot has been saved', async () => {
    const db = await openStore('test-db')
    const result = await getBaseline(db)
    expect(result).toEqual([])
    db.close()
  })
})

describe('saveBaseline / getBaseline round-trip', () => {
  it('persists and retrieves a snapshot', async () => {
    const db = await openStore('test-db')
    const snapshot: SyncMetadata[] = [
      { path: 'notes/a.json', hash: 'abc123', updatedAt: 1000 },
      { path: 'notes/b.json', hash: 'def456', updatedAt: 2000, tags: ['work'] },
    ]
    await saveBaseline(db, snapshot)
    const result = await getBaseline(db)
    expect(result).toEqual(snapshot)
    db.close()
  })

  it('overwrites the previous snapshot on second save', async () => {
    const db = await openStore('test-db')
    await saveBaseline(db, [{ path: 'a.json', hash: 'old', updatedAt: 1000 }])
    const newSnapshot: SyncMetadata[] = [{ path: 'b.json', hash: 'new', updatedAt: 2000 }]
    await saveBaseline(db, newSnapshot)
    const result = await getBaseline(db)
    expect(result).toEqual(newSnapshot)
    db.close()
  })

  it('persists an empty snapshot', async () => {
    const db = await openStore('test-db')
    await saveBaseline(db, [{ path: 'a.json', hash: 'h1', updatedAt: 1 }])
    await saveBaseline(db, [])
    const result = await getBaseline(db)
    expect(result).toEqual([])
    db.close()
  })
})
