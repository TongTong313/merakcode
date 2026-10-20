export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timeout: NodeJS.Timeout
  return Promise.race([
    promise.then((result) => {
      clearTimeout(timeout)
      return result
    }),
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        reject(new Error(`Operation timed out after ${ms}ms`))
      }, ms)
    }),
  ])
}

/**
 * Runs work with a time limit and returns the fallback on timeout or failure instead of throwing.
 * For optional extras (such as fetching LSP diagnostics after a write): better no result than blocking the main flow.
 */
export async function withFallbackTimeout<T>(work: Promise<T>, ms: number, fallback: () => T | Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      void Promise.resolve(fallback()).then(resolve)
    }, ms)
  })
  return Promise.race([work.catch(() => fallback()), timeout]).finally(() => clearTimeout(timer!))
}
