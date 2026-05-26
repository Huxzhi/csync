import type { RemoteRepositoryAdapter, SyncMetadata } from '../types.js'

interface CacheEntry {
  path: string
  lastModified: number
  size: number
  hash: string
}

export interface LocalFSAdapterOptions {
  handle: FileSystemDirectoryHandle
  basePath?: string
  dbName?: string
}

async function sha256hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

function openCache(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore('hashes', { keyPath: 'path' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function getCacheEntry(db: IDBDatabase, path: string): Promise<CacheEntry | undefined> {
  return new Promise((resolve, reject) => {
    const req = db.transaction('hashes', 'readonly').objectStore('hashes').get(path)
    req.onsuccess = () => resolve(req.result as CacheEntry | undefined)
    req.onerror = () => reject(req.error)
  })
}

function setCacheEntry(db: IDBDatabase, entry: CacheEntry): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('hashes', 'readwrite')
    tx.objectStore('hashes').put(entry)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

function deleteCacheEntry(db: IDBDatabase, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('hashes', 'readwrite')
    tx.objectStore('hashes').delete(path)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

async function* walkDir(
  dir: FileSystemDirectoryHandle,
  prefix: string,
): AsyncGenerator<{ path: string; file: File }> {
  for await (const entry of dir.values()) {
    const entryPath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.kind === 'directory') {
      yield* walkDir(entry as FileSystemDirectoryHandle, entryPath)
    } else {
      const file = await (entry as FileSystemFileHandle).getFile()
      yield { path: entryPath, file }
    }
  }
}

async function resolveDir(
  root: FileSystemDirectoryHandle,
  path: string,
): Promise<FileSystemDirectoryHandle> {
  if (!path) return root
  let dir = root
  for (const seg of path.split('/')) {
    dir = await dir.getDirectoryHandle(seg, { create: false })
  }
  return dir
}

async function resolveFileHandle(
  root: FileSystemDirectoryHandle,
  segments: string[],
  create: boolean,
): Promise<FileSystemFileHandle> {
  let dir = root
  for (let i = 0; i < segments.length - 1; i++) {
    dir = await dir.getDirectoryHandle(segments[i], { create })
  }
  return dir.getFileHandle(segments[segments.length - 1], { create })
}

async function resolveParent(
  root: FileSystemDirectoryHandle,
  segments: string[],
): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
  let dir = root
  for (let i = 0; i < segments.length - 1; i++) {
    dir = await dir.getDirectoryHandle(segments[i], { create: false })
  }
  return { dir, name: segments[segments.length - 1] }
}

export function createLocalFSAdapter(options: LocalFSAdapterOptions): RemoteRepositoryAdapter {
  const { handle, basePath = '', dbName = 'csync-localfs-cache' } = options
  let db: IDBDatabase | null = null

  async function getDb(): Promise<IDBDatabase> {
    if (!db) db = await openCache(dbName)
    return db
  }

  function toSegments(path: string): string[] {
    return (basePath ? `${basePath}/${path}` : path).split('/')
  }

  return {
    async getRemoteManifest(): Promise<SyncMetadata[]> {
      const cache = await getDb()
      const root = await resolveDir(handle, basePath)
      const results: SyncMetadata[] = []
      for await (const { path, file } of walkDir(root, '')) {
        const entry = await getCacheEntry(cache, path)
        const hash =
          entry && entry.lastModified === file.lastModified && entry.size === file.size
            ? entry.hash
            : ''
        results.push({ path, hash, updatedAt: file.lastModified })
      }
      return results
    },

    async downloadFile(path: string): Promise<{ content: ArrayBuffer; meta: SyncMetadata }> {
      const cache = await getDb()
      const fileHandle = await resolveFileHandle(handle, toSegments(path), false)
      const file = await fileHandle.getFile()
      const content = await file.arrayBuffer()
      const hash = await sha256hex(content)
      await setCacheEntry(cache, { path, lastModified: file.lastModified, size: file.size, hash })
      return { content, meta: { path, hash, updatedAt: file.lastModified } }
    },
    async uploadFile(meta: SyncMetadata, content: ArrayBuffer): Promise<SyncMetadata> {
      const cache = await getDb()
      const fileHandle = await resolveFileHandle(handle, toSegments(meta.path), true)
      const writable = await fileHandle.createWritable()
      await writable.write(content)
      await writable.close()
      const file = await fileHandle.getFile()
      const hash = await sha256hex(content)
      await setCacheEntry(cache, { path: meta.path, lastModified: file.lastModified, size: file.size, hash })
      return { path: meta.path, hash, updatedAt: file.lastModified }
    },
    deleteFile: async () => { throw new Error('not implemented') },
  }
}
