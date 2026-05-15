import type { RemoteRepositoryAdapter, SyncMetadata } from '../types.js'

export interface GitHubAdapterOptions {
  owner: string
  repo: string
  branch: string
  token: string
  basePath?: string
}

interface GitTreeItem {
  path: string
  type: 'blob' | 'tree'
  sha: string
}

export function createGitHubAdapter(options: GitHubAdapterOptions): RemoteRepositoryAdapter {
  const { owner, repo, branch, token, basePath = 'data' } = options

  const BASE = `https://api.github.com/repos/${owner}/${repo}`

  const defaultHeaders: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  }

  async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${BASE}/${path}`, {
      ...init,
      headers: { ...defaultHeaders, ...(init?.headers as Record<string, string> | undefined) },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`GitHub API ${res.status}: ${body}`)
    }
    return res.json() as Promise<T>
  }

  function remotePath(path: string): string {
    return `${basePath}/${path}`
  }

  return {
    async getRemoteManifest(): Promise<SyncMetadata[]> {
      const branchData = await apiFetch<{
        commit: { commit: { tree: { sha: string } } }
      }>(`branches/${branch}`)
      const treeSha = branchData.commit.commit.tree.sha

      const treeData = await apiFetch<{ tree: GitTreeItem[]; truncated: boolean }>(
        `git/trees/${treeSha}?recursive=1`,
      )

      const prefix = `${basePath}/`
      return treeData.tree
        .filter((item): item is GitTreeItem & { type: 'blob' } =>
          item.type === 'blob' && item.path.startsWith(prefix),
        )
        .map(item => ({
          path: item.path.slice(prefix.length),
          hash: item.sha,
          updatedAt: 0,
        }))
    },

    async uploadFile(path: string, content: ArrayBuffer, currentHash?: string): Promise<{ hash: string }> {
      const apiPath = remotePath(path)

      let existingSha: string | undefined
      if (currentHash) {
        existingSha = currentHash
      } else {
        try {
          const existing = await apiFetch<{ sha: string }>(`contents/${apiPath}`)
          existingSha = existing.sha
        } catch {
          // File does not exist yet — new file, no SHA needed
        }
      }

      const bytes = new Uint8Array(content)
      let binary = ''
      for (const b of bytes) binary += String.fromCharCode(b)

      const body: Record<string, unknown> = {
        message: `sync: update ${path}`,
        content: btoa(binary),
        branch,
      }
      if (existingSha !== undefined) body.sha = existingSha

      const result = await apiFetch<{ content: { sha: string } }>(`contents/${apiPath}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      })

      return { hash: result.content.sha }
    },

    async downloadFile(path: string): Promise<ArrayBuffer> {
      const data = await apiFetch<{ content: string; encoding: string }>(
        `contents/${remotePath(path)}`,
      )
      const binary = atob(data.content.replace(/\n/g, ''))
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      return bytes.buffer
    },

    async deleteFile(path: string): Promise<void> {
      const apiPath = remotePath(path)
      const existing = await apiFetch<{ sha: string }>(`contents/${apiPath}`)
      await apiFetch(`contents/${apiPath}`, {
        method: 'DELETE',
        body: JSON.stringify({
          message: `sync: delete ${path}`,
          sha: existing.sha,
          branch,
        }),
      })
    },
  }
}
