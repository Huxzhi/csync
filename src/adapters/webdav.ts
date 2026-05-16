import type { RemoteRepositoryAdapter, SyncMetadata } from '../types.js'

export interface WebDAVAdapterOptions {
  baseUrl: string
  username: string
  password: string
  basePath?: string
}

function byLocalName(parent: Element | Document, name: string): Element[] {
  return Array.from(parent.getElementsByTagName('*')).filter(el => el.localName === name)
}

function firstByLocalName(parent: Element | Document, name: string): Element | undefined {
  return byLocalName(parent, name)[0]
}

export function createWebDAVAdapter(options: WebDAVAdapterOptions): RemoteRepositoryAdapter {
  const { baseUrl, username, password, basePath = 'data' } = options

  const authHeader = `Basic ${btoa(`${username}:${password}`)}`
  const baseUrlPath = new URL(baseUrl).pathname.replace(/\/$/, '')
  const remoteBase = basePath ? `${baseUrl}/${basePath}` : baseUrl
  const manifestPrefix = basePath ? `${baseUrlPath}/${basePath}/` : `${baseUrlPath}/`

  async function request(url: string, init: RequestInit = {}): Promise<Response> {
    return fetch(url, {
      ...init,
      headers: {
        authorization: authHeader,
        ...(init.headers as Record<string, string> | undefined),
      },
    })
  }

  function stripEtag(raw: string | null): string {
    return raw ? raw.replace(/^"|"$/g, '') : ''
  }

  return {
    async getRemoteManifest(): Promise<SyncMetadata[]> {
      const res = await request(`${remoteBase}/`, {
        method: 'PROPFIND',
        headers: {
          depth: 'infinity',
          'content-type': 'application/xml; charset=utf-8',
        },
        body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>',
      })

      if (res.status === 404) return []
      if (!res.ok) throw new Error(`WebDAV ${res.status}: ${await res.text().catch(() => '')}`)

      const doc = new DOMParser().parseFromString(await res.text(), 'text/xml')
      const responses = byLocalName(doc, 'response')
      const result: SyncMetadata[] = []

      for (const response of responses) {
        if (byLocalName(response, 'collection').length > 0) continue

        const href = decodeURIComponent(firstByLocalName(response, 'href')?.textContent ?? '')
        const hash = stripEtag(firstByLocalName(response, 'getetag')?.textContent ?? null)
        if (!href.startsWith(manifestPrefix) || !hash) continue

        result.push({ path: href.slice(manifestPrefix.length), hash, updatedAt: 0 })
      }

      return result
    },

    async uploadFile(meta: SyncMetadata, content: ArrayBuffer): Promise<SyncMetadata> {
      const { path, hash: currentHash } = meta
      const url = `${remoteBase}/${path}`

      const putRes = await request(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: content,
      })
      if (!putRes.ok) throw new Error(`WebDAV ${putRes.status}: ${await putRes.text().catch(() => '')}`)

      const headRes = await request(url, { method: 'HEAD' })
      const etag = stripEtag(headRes.headers.get('etag'))
      const lastModified = headRes.headers.get('last-modified')
      const updatedAt = lastModified ? new Date(lastModified).getTime() : Date.now()
      if (etag) return { path, hash: etag, updatedAt }
      if (currentHash) return { path, hash: currentHash, updatedAt }
      throw new Error(`WebDAV: server did not return ETag for ${path}`)
    },

    async downloadFile(path: string): Promise<{ content: ArrayBuffer; meta: SyncMetadata }> {
      const res = await request(`${remoteBase}/${path}`)
      if (!res.ok) throw new Error(`WebDAV ${res.status}: ${await res.text().catch(() => '')}`)
      const lastModified = res.headers.get('last-modified')
      return {
        content: await res.arrayBuffer(),
        meta: {
          path,
          hash: stripEtag(res.headers.get('etag')),
          updatedAt: lastModified ? new Date(lastModified).getTime() : Date.now(),
        },
      }
    },

    async deleteFile(path: string): Promise<void> {
      const res = await request(`${remoteBase}/${path}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`WebDAV ${res.status}: ${await res.text().catch(() => '')}`)
    },
  }
}
