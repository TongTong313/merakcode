import { methodSchemas, type EventEvent, type StoreDoc, type StoreDocMeta, type StoreQuery } from "./protocol.gen"
import { StoreError } from "./store-error"

export interface StorageHost {
  append(events: EventEvent[]): void | Promise<void>
  read(stream: string, from: number, limit: number): EventEvent[] | Promise<EventEvent[]>
  find(query: StoreQuery): EventEvent[] | Promise<EventEvent[]>
  get(id: string): EventEvent | Promise<EventEvent>
  put(doc: StoreDoc): void | Promise<void>
  fetch(kind: string, key: string): StoreDoc | Promise<StoreDoc>
  list(kind: string, prefix: string): StoreDocMeta[] | Promise<StoreDocMeta[]>
}

export async function handleStore(store: StorageHost, method: string, input: unknown) {
  try {
    switch (method) {
      case "store.append": {
        const p = methodSchemas[method].params.parse(input)
        await store.append(p.events ?? [])
        return { result: {} }
      }
      case "store.read": {
        const p = methodSchemas[method].params.parse(input)
        return { result: await store.read(p.stream, p.from, p.limit ?? 0) }
      }
      case "store.find": {
        const p = methodSchemas[method].params.parse(input)
        return { result: await store.find(p) }
      }
      case "store.get": {
        const p = methodSchemas[method].params.parse(input)
        return { result: await store.get(p.id) }
      }
      case "store.put": {
        const p = methodSchemas[method].params.parse(input)
        await store.put(p.doc)
        return { result: {} }
      }
      case "store.fetch": {
        const p = methodSchemas[method].params.parse(input)
        return { result: await store.fetch(p.kind, p.key) }
      }
      case "store.list": {
        const p = methodSchemas[method].params.parse(input)
        return { result: await store.list(p.kind, p.prefix ?? "") }
      }
      default:
        return { error: { code: -32601, message: "Method not found", data: { code: "MRK-1001" } } }
    }
  } catch (error) {
    const code =
      error instanceof StoreError ? { "not-found": -32004, conflict: -32009, sequence: -32010 }[error.kind] : -32011
    return { error: { code, message: "Storage request failed", data: { code: "MRK-1003" } } }
  }
}
