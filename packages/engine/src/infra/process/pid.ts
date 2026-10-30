/**
 * Checks whether a PID from any process is still alive.
 *
 * process.kill(pid, 0) sends no signal and only probes the PID:
 * - success: the process is alive
 * - throws: the process does not exist or we lack permission (treated as dead)
 *
 * Used to recover cross-process file locks: a lock whose holder PID is dead can be taken over safely.
 */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
