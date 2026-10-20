import { withFallbackTimeout } from "../util/timeout"

/**
 * Picks the clients for diagnostics after an edit (used by LSP.diagnosticsAfterEdit):
 * - Some ready: return them at once without waiting for pending, so a broken or slow server cannot block
 * - None ready: wait up to readyTimeoutMs; on timeout or failure use the current peekReady() snapshot (maybe empty)
 */
export async function pickClientsForEditDiagnostics<T>(input: {
  ready: T[]
  pending: Promise<T[]>
  readyTimeoutMs: number
  peekReady: () => T[] | Promise<T[]>
}): Promise<T[]> {
  if (input.ready.length > 0) return input.ready
  return withFallbackTimeout(input.pending, input.readyTimeoutMs, input.peekReady)
}
