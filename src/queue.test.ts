import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runWithConcurrency } from './queue.js'

beforeEach(() => {
  vi.useRealTimers()
})

describe('runWithConcurrency', () => {
  it('returns fulfilled results for all successful tasks', async () => {
    const tasks = [() => Promise.resolve(1), () => Promise.resolve(2), () => Promise.resolve(3)]
    const results = await runWithConcurrency(tasks, { concurrency: 2 })
    expect(results).toEqual([
      { status: 'fulfilled', value: 1 },
      { status: 'fulfilled', value: 2 },
      { status: 'fulfilled', value: 3 },
    ])
  })

  it('returns empty array for empty task list', async () => {
    const results = await runWithConcurrency([], { concurrency: 5 })
    expect(results).toEqual([])
  })

  it('isolates task failures — other tasks still complete', async () => {
    const tasks = [
      () => Promise.resolve('ok'),
      () => Promise.reject(new Error('boom')),
      () => Promise.resolve('also ok'),
    ]
    const results = await runWithConcurrency(tasks, { concurrency: 3, maxRetries: 0 })
    expect(results[0]).toEqual({ status: 'fulfilled', value: 'ok' })
    expect(results[1].status).toBe('rejected')
    expect((results[1] as { status: 'rejected'; reason: Error }).reason.message).toBe('boom')
    expect(results[2]).toEqual({ status: 'fulfilled', value: 'also ok' })
  })

  it('never exceeds the concurrency limit', async () => {
    let active = 0
    let maxActive = 0
    const tasks = Array.from({ length: 10 }, () => async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise<void>(r => setTimeout(r, 5))
      active--
      return 'done'
    })
    await runWithConcurrency(tasks, { concurrency: 3 })
    expect(maxActive).toBeLessThanOrEqual(3)
  })

  it('retries a failing task and succeeds on the third attempt', async () => {
    let calls = 0
    const tasks = [
      async () => {
        calls++
        if (calls < 3) throw new Error('transient')
        return 'success'
      },
    ]
    const results = await runWithConcurrency(tasks, { concurrency: 1, maxRetries: 3 })
    expect(results[0]).toEqual({ status: 'fulfilled', value: 'success' })
    expect(calls).toBe(3)
  })

  it('marks a task rejected after exhausting all retries', async () => {
    const err = new Error('always fails')
    const tasks = [() => Promise.reject(err)]
    const results = await runWithConcurrency(tasks, { concurrency: 1, maxRetries: 2 })
    expect(results[0].status).toBe('rejected')
    expect((results[0] as { status: 'rejected'; reason: Error }).reason).toBe(err)
  })

  it('rejects a task that exceeds the timeout', async () => {
    vi.useFakeTimers()
    const tasks = [() => new Promise<string>(r => setTimeout(() => r('late'), 10_000))]
    const promise = runWithConcurrency(tasks, { concurrency: 1, timeout: 100, maxRetries: 0 })
    vi.advanceTimersByTime(200)
    const results = await promise
    expect(results[0].status).toBe('rejected')
    expect((results[0] as { status: 'rejected'; reason: Error }).reason.message).toContain(
      'timed out',
    )
  })

  it('stops dispatching new tasks when signal is aborted before start', async () => {
    const controller = new AbortController()
    controller.abort()
    let started = 0
    const tasks = Array.from({ length: 5 }, () => async () => {
      started++
      return 'done'
    })
    await runWithConcurrency(tasks, { concurrency: 2, signal: controller.signal })
    expect(started).toBe(0)
  })

  it('calls onProgress once per completed task in order', async () => {
    const progress: [number, number][] = []
    const tasks = [() => Promise.resolve(1), () => Promise.resolve(2), () => Promise.resolve(3)]
    await runWithConcurrency(tasks, {
      concurrency: 1,
      onProgress: (c, t) => progress.push([c, t]),
    })
    expect(progress).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ])
  })
})
