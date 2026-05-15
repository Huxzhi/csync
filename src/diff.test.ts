import { describe, expect, it } from 'vitest'
import { computeDiff } from './diff.js'
import type { SyncMetadata } from './types.js'

function m(path: string, hash: string, tags?: string[]): SyncMetadata {
  return { path, hash, updatedAt: 1000, tags }
}

describe('computeDiff — upload', () => {
  it('uploads a locally dirty record when remote is unchanged', () => {
    const diff = computeDiff([m('a.json', '')], [m('a.json', 'h1')], [m('a.json', 'h1')])
    expect(diff.upload).toEqual(['a.json'])
    expect(diff.download).toEqual([])
  })

  it('uploads a new local dirty record not present anywhere else', () => {
    const diff = computeDiff([m('new.json', '')], [], [])
    expect(diff.upload).toEqual(['new.json'])
  })
})

describe('computeDiff — download', () => {
  it('downloads a remotely changed record when local is clean', () => {
    const diff = computeDiff([m('a.json', 'h1')], [m('a.json', 'h2')], [m('a.json', 'h1')])
    expect(diff.download).toEqual(['a.json'])
    expect(diff.upload).toEqual([])
  })

  it('downloads a new remote record not present in baseline or local', () => {
    const diff = computeDiff([], [m('remote.json', 'h1')], [])
    expect(diff.download).toEqual(['remote.json'])
  })
})

describe('computeDiff — deleteRemote', () => {
  it('queues remote delete when record was deleted locally and remote is unchanged', () => {
    const diff = computeDiff([], [m('a.json', 'h1')], [m('a.json', 'h1')])
    expect(diff.deleteRemote).toEqual(['a.json'])
  })
})

describe('computeDiff — deleteLocal', () => {
  it('queues local delete when remote deleted a clean local record', () => {
    const diff = computeDiff([m('a.json', 'h1')], [], [m('a.json', 'h1')])
    expect(diff.deleteLocal).toEqual(['a.json'])
  })
})

describe('computeDiff — conflict', () => {
  it('marks conflict when both local is dirty and remote has changed', () => {
    const diff = computeDiff([m('a.json', '')], [m('a.json', 'h2')], [m('a.json', 'h1')])
    expect(diff.conflict).toHaveLength(1)
    expect(diff.conflict[0].path).toBe('a.json')
    expect(diff.conflict[0].local.hash).toBe('')
    expect(diff.conflict[0].remote.hash).toBe('h2')
  })
})

describe('computeDiff — no-op', () => {
  it('produces empty diff when nothing has changed', () => {
    const diff = computeDiff([m('a.json', 'h1')], [m('a.json', 'h1')], [m('a.json', 'h1')])
    expect(diff.upload).toEqual([])
    expect(diff.download).toEqual([])
    expect(diff.deleteRemote).toEqual([])
    expect(diff.deleteLocal).toEqual([])
    expect(diff.conflict).toEqual([])
  })

  it('is a no-op when both sides deleted a record (already converged)', () => {
    const diff = computeDiff([], [], [m('a.json', 'h1')])
    expect(diff.deleteRemote).toEqual([])
    expect(diff.deleteLocal).toEqual([])
  })
})

describe('computeDiff — multi-record', () => {
  it('handles multiple records with independent actions in one pass', () => {
    const local = [m('upload.json', ''), m('clean.json', 'h1'), m('dl.json', 'h1')]
    const remote = [m('upload.json', 'h1'), m('clean.json', 'h1'), m('dl.json', 'h2')]
    const baseline = [m('upload.json', 'h1'), m('clean.json', 'h1'), m('dl.json', 'h1')]
    const diff = computeDiff(local, remote, baseline)
    expect(diff.upload).toEqual(['upload.json'])
    expect(diff.download).toEqual(['dl.json'])
    expect(diff.deleteRemote).toEqual([])
    expect(diff.deleteLocal).toEqual([])
    expect(diff.conflict).toEqual([])
  })
})
