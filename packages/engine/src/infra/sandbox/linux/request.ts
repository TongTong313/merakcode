/**
 * The request file a Linux sandbox helper reads. Its digest travels in the helper's arguments, which no other process
 * can change, so the helper only acts on the request the engine wrote.
 */
import { createHash } from "node:crypto"

export namespace SandboxRequest {
  export function digest(content: string | Buffer) {
    return createHash("sha256").update(content).digest("hex")
  }

  export function matches(content: Buffer, expected: string) {
    return digest(content) === expected
  }
}
