import type { SyncMetadata } from './types.js'

export function openStore(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 2)
    request.onupgradeneeded = () => {
      const db = request.result
      if (db.objectStoreNames.contains('baseline')) {
        db.deleteObjectStore('baseline')
      }
      db.createObjectStore('baseline', { keyPath: 'path' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export function getBaseline(db: IDBDatabase): Promise<SyncMetadata[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('baseline', 'readonly')
    const request = tx.objectStore('baseline').getAll()
    request.onsuccess = () => resolve(request.result as SyncMetadata[])
    request.onerror = () => reject(request.error)
  })
}

export function upsertBaselineEntry(db: IDBDatabase, meta: SyncMetadata): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('baseline', 'readwrite')
    tx.objectStore('baseline').put(meta)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export function removeBaselineEntry(db: IDBDatabase, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('baseline', 'readwrite')
    tx.objectStore('baseline').delete(path)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}
