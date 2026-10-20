/** TUI-wide ownership survives prompt component replacement and session navigation. */
export function createSessionRequests(idle: (sessionID: string) => void, busy?: (sessionID: string) => void) {
  const owners = new Map<string, string>()
  return {
    claim(sessionID: string, requestID: string) {
      owners.set(sessionID, requestID)
      busy?.(sessionID)
    },
    settle(sessionID: string, requestID: string, complete = false) {
      if (owners.get(sessionID) !== requestID) return false
      owners.delete(sessionID)
      if (complete) idle(sessionID)
      return true
    },
  }
}
