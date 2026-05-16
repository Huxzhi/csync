import type { RemoteRepositoryAdapter, SyncMetadata } from '../types.js'

export interface S3AdapterOptions {
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  endpoint?: string
  basePath?: string
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

async function sha256(data: ArrayBuffer | string): Promise<string> {
  const bytes: ArrayBuffer =
    typeof data === 'string'
      ? (new TextEncoder().encode(data).buffer as ArrayBuffer)
      : data
  return toHex(await crypto.subtle.digest('SHA-256', bytes))
}

async function hmac(key: ArrayBuffer, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    new TextEncoder().encode(data).buffer as ArrayBuffer,
  )
}

function getDatetime(): { datetime: string; date: string } {
  const datetime = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z'
  return { datetime, date: datetime.slice(0, 8) }
}

function encodeUriPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

function stripEtag(raw: string | null): string {
  return raw ? raw.replace(/^"|"$/g, '') : ''
}

async function buildAuthHeaders(
  method: string,
  url: URL,
  body: ArrayBuffer | string,
  region: string,
  accessKeyId: string,
  secretAccessKey: string,
): Promise<Record<string, string>> {
  const { datetime, date } = getDatetime()
  const payloadHash = await sha256(body)

  const baseHeaders: Record<string, string> = {
    host: url.host,
    'x-amz-date': datetime,
    'x-amz-content-sha256': payloadHash,
  }

  const sortedNames = Object.keys(baseHeaders).sort()
  const canonicalHeaders = sortedNames.map(k => `${k}:${baseHeaders[k]}`).join('\n') + '\n'
  const signedHeaders = sortedNames.join(';')

  const canonicalUri = encodeUriPath(url.pathname || '/')
  const canonicalQueryString = [...url.searchParams.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')

  const canonicalRequest = [
    method, canonicalUri, canonicalQueryString,
    canonicalHeaders, signedHeaders, payloadHash,
  ].join('\n')

  const credentialScope = `${date}/${region}/s3/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256', datetime, credentialScope, await sha256(canonicalRequest),
  ].join('\n')

  const kDate = await hmac(new TextEncoder().encode(`AWS4${secretAccessKey}`).buffer as ArrayBuffer, date)
  const kRegion = await hmac(kDate, region)
  const kService = await hmac(kRegion, 's3')
  const kSigning = await hmac(kService, 'aws4_request')
  const signature = toHex(await hmac(kSigning, stringToSign))

  return {
    ...baseHeaders,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }
}

function parseListXml(xml: string, prefix: string): { items: SyncMetadata[]; nextToken: string | null } {
  const doc = new DOMParser().parseFromString(xml, 'text/xml')
  const contents = Array.from(doc.getElementsByTagName('Contents'))
  const items: SyncMetadata[] = contents.flatMap(c => {
    const key = c.getElementsByTagName('Key')[0]?.textContent ?? ''
    const etag = c.getElementsByTagName('ETag')[0]?.textContent ?? ''
    if (!key.startsWith(prefix)) return []
    return [{ path: key.slice(prefix.length), hash: stripEtag(etag), updatedAt: 0 }]
  })
  const nextToken = doc.getElementsByTagName('NextContinuationToken')[0]?.textContent ?? null
  return { items, nextToken }
}

export function createS3Adapter(options: S3AdapterOptions): RemoteRepositoryAdapter {
  const { region, accessKeyId, secretAccessKey, basePath = 'data' } = options
  const endpoint = (options.endpoint ?? `https://${options.bucket}.s3.${region}.amazonaws.com`).replace(/\/$/, '')
  const keyPrefix = `${basePath}/`

  async function s3Fetch(
    method: string,
    key: string,
    params: Record<string, string> = {},
    body: ArrayBuffer | string = '',
  ): Promise<Response> {
    const url = new URL(key ? `${endpoint}/${key}` : `${endpoint}/`)
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)

    const headers = await buildAuthHeaders(method, url, body, region, accessKeyId, secretAccessKey)

    return fetch(url.toString(), {
      method,
      headers,
      ...(method === 'PUT' ? { body } : {}),
    })
  }

  return {
    async getRemoteManifest(): Promise<SyncMetadata[]> {
      const all: SyncMetadata[] = []
      let continuationToken: string | null = null

      do {
        const params: Record<string, string> = { 'list-type': '2', prefix: keyPrefix }
        if (continuationToken) params['continuation-token'] = continuationToken

        const res = await s3Fetch('GET', '', params)
        if (!res.ok) throw new Error(`S3 ${res.status}: ${await res.text().catch(() => '')}`)

        const { items, nextToken } = parseListXml(await res.text(), keyPrefix)
        all.push(...items)
        continuationToken = nextToken
      } while (continuationToken)

      return all
    },

    async uploadFile(path: string, content: ArrayBuffer): Promise<{ hash: string }> {
      const res = await s3Fetch('PUT', `${basePath}/${path}`, {}, content)
      if (!res.ok) throw new Error(`S3 ${res.status}: ${await res.text().catch(() => '')}`)
      return { hash: stripEtag(res.headers.get('etag')) }
    },

    async downloadFile(path: string): Promise<ArrayBuffer> {
      const res = await s3Fetch('GET', `${basePath}/${path}`)
      if (!res.ok) throw new Error(`S3 ${res.status}: ${await res.text().catch(() => '')}`)
      return res.arrayBuffer()
    },

    async deleteFile(path: string): Promise<void> {
      const res = await s3Fetch('DELETE', `${basePath}/${path}`)
      if (!res.ok) throw new Error(`S3 ${res.status}: ${await res.text().catch(() => '')}`)
    },
  }
}
