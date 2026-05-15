export type TaskResult<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown }

export async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  options: {
    concurrency: number
    timeout?: number
    maxRetries?: number
    signal?: AbortSignal
    onProgress?: (completed: number, total: number) => void
  },
): Promise<TaskResult<T>[]> {
  const { concurrency, timeout, maxRetries = 3, signal, onProgress } = options
  const total = tasks.length
  if (total === 0) return []

  const results: TaskResult<T>[] = new Array(total)
  let currentIndex = 0
  let completed = 0
  const BASE_DELAY_MS = 200

  function withTimeout(p: Promise<T>): Promise<T> {
    if (timeout === undefined) return p
    return Promise.race([
      p,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Task timed out after ${timeout}ms`)),
          timeout,
        ),
      ),
    ])
  }

  async function runWithRetry(index: number): Promise<void> {
    const taskFn = tasks[index]
    let lastError: unknown

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const jitter = Math.random() * BASE_DELAY_MS
        await new Promise<void>(r =>
          setTimeout(r, BASE_DELAY_MS * 2 ** (attempt - 1) + jitter),
        )
      }
      try {
        const value = await withTimeout(taskFn())
        results[index] = { status: 'fulfilled', value }
        return
      } catch (err) {
        lastError = err
      }
    }

    results[index] = { status: 'rejected', reason: lastError }
  }

  async function worker(): Promise<void> {
    while (true) {
      if (signal?.aborted) break
      const index = currentIndex++
      if (index >= total) break
      await runWithRetry(index)
      completed++
      onProgress?.(completed, total)
    }
  }

  const workerCount = Math.min(concurrency, total)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}
