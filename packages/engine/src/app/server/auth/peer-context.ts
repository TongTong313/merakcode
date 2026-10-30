import { AsyncLocalStorage } from "node:async_hooks"

export type PeerAddr = { address: string; port: number; family?: string }

const storage = new AsyncLocalStorage<PeerAddr>()

export function runWithPeer<T>(peer: PeerAddr | undefined, fn: () => T): T {
  if (!peer) return fn()
  return storage.run(peer, fn)
}

export function currentPeer(): PeerAddr | undefined {
  return storage.getStore()
}
