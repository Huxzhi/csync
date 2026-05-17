import type { DiffResult, SyncMetadata } from './types.js'

export function computeDiff(
  local: SyncMetadata[],
  remote: SyncMetadata[],
  baseline: SyncMetadata[],
): DiffResult {
  const L = new Map(local.map(m => [m.path, m]))
  const R = new Map(remote.map(m => [m.path, m]))
  const B = new Map(baseline.map(m => [m.path, m]))

  const allPaths = new Set([...L.keys(), ...R.keys(), ...B.keys()])

  const result: DiffResult = {
    upload: [],
    download: [],
    deleteRemote: [],
    deleteLocal: [],
    conflict: [],
  }

  for (const path of allPaths) {
    const l = L.get(path)
    const r = R.get(path)
    const b = B.get(path)

    const localDirty = l !== undefined && l.hash === ''
    const localDeleted = l === undefined && b !== undefined
    const remoteModified = r !== undefined && r.hash !== b?.hash
    const remoteDeleted = r === undefined && b !== undefined

    if (localDirty && !remoteModified && !remoteDeleted) {
      result.upload.push(l!)
    } else if (localDeleted && !remoteModified && !remoteDeleted) {
      result.deleteRemote.push(r!)
    } else if (!localDirty && !localDeleted && remoteModified) {
      result.download.push(r!)
    } else if (!localDirty && !localDeleted && remoteDeleted) {
      result.deleteLocal.push(l!)
    } else if (localDirty && remoteModified) {
      result.conflict.push({ path, local: l!, remote: r!, baseline: b })
    } else if (localDeleted && remoteModified) {
      result.conflict.push({ path, local: undefined, remote: r!, baseline: b })
    } else if (localDirty && remoteDeleted) {
      result.conflict.push({ path, local: l!, remote: undefined, baseline: b })
    }
  }

  return result
}
