import { Instance } from "../project/instance"
import type { Message } from "./message"

/**
 * Dedup ledger for file-level instruction injection, shared by InstructionPrompt and ContextAttach.
 * It is a separate module so instruction.ts and context-attach.ts depend on it one way, without an import cycle.
 */
export namespace ContextClaims {
  const state = Instance.state(() => {
    return {
      claims: new Map<string, Set<string>>(),
    }
  })

  export function isClaimed(messageID: string, filepath: string) {
    const claimed = state().claims.get(messageID)
    if (!claimed) return false
    return claimed.has(filepath)
  }

  export function claim(messageID: string, filepath: string) {
    const current = state()
    let claimed = current.claims.get(messageID)
    if (!claimed) {
      claimed = new Set()
      current.claims.set(messageID, claimed)
    }
    claimed.add(filepath)
  }

  export function clear(messageID: string) {
    state().claims.delete(messageID)
  }

  /**
   * Instruction files already injected through tool output in earlier messages. Besides read, write/edit/grep/glob
   * also set metadata.loaded, so no tool name filter applies; otherwise files would be injected again across tools.
   * Compacted injections do not count and may be injected again; otherwise the rules would be lost after compaction.
   */
  export function loaded(messages: Message.FullMsg[]) {
    const paths = new Set<string>()
    for (const msg of messages) {
      for (const part of msg.parts) {
        if (part.type === "tool" && part.state.status === "completed") {
          if (part.state.time.compacted) continue
          const loaded = part.state.metadata?.loaded
          if (!loaded || !Array.isArray(loaded)) continue
          for (const p of loaded) {
            if (typeof p === "string") paths.add(p)
          }
        }
      }
    }
    return paths
  }
}
