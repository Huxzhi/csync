import type { SyncMetadata } from './types.js'

export function openStore(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore('baseline')
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export function getBaseline(db: IDBDatabase): Promise<SyncMetadata[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('baseline', 'readonly')
    const request = tx.objectStore('baseline').get('snapshot')
    request.onsuccess = () => resolve((request.result as SyncMetadata[] | undefined) ?? [])
    request.onerror = () => reject(request.error)
  })
}

export function saveBaseline(db: IDBDatabase, snapshot: SyncMetadata[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('baseline', 'readwrite')
    tx.objectStore('baseline').put(snapshot, 'snapshot')
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}
