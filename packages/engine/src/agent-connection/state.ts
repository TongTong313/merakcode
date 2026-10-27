import { createHash, randomUUID } from "node:crypto"
import { Log } from "@merakcode/log/logger"
import { Storage } from "../storage/storage"
import { Lock } from "../util/lock"
import { GlobalBus } from "../bus/global"

export type ProductState = {
  revision: number
  fingerprint: string
  present: boolean
  enabled: boolean
  disabledCycleID?: string
}

const log = Log.create({ service: "agent-connection.state" })
const listeners = new Set<(productID: string) => void | Promise<void>>()

GlobalBus.on("event", (event) => {
  if (event.payload.type === "config.updated")
    void reconcile().catch((error) => log.error("product state refresh failed", { error }))
})

export function onDisable(listener: (productID: string) => void | Promise<void>) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

async function refresh(productID: string): Promise<ProductState> {
  const { configuredProducts } = await import("./catalog")
  const product = (await configuredProducts()).find((item) => item.id === productID)
  const present = productID === "merak" || !!product
  const enabled = present && product?.enabled !== false
  const normalized = product
    ? { ...product, enabled, model: product.model && { id: product.model.id, providerID: product.model.providerID } }
    : { present }
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(Object.fromEntries(Object.entries(normalized).sort(([a], [b]) => a.localeCompare(b)))))
    .digest("hex")
  const key = ["agent_connection_state", productID]
  const previous = await Storage.read<ProductState>(key).catch((error) => {
    if (error instanceof Storage.NotFoundError) return undefined
    throw error
  })
  if (previous?.fingerprint === fingerprint) return previous
  const disabledCycleID = present && previous?.present === false ? undefined : previous?.disabledCycleID
  const state: ProductState = {
    revision: (previous?.revision ?? 0) + 1,
    fingerprint,
    present,
    enabled,
    disabledCycleID: enabled ? undefined : (disabledCycleID ?? randomUUID()),
  }
  await Storage.write(key, state)
  if (!enabled && previous?.enabled)
    for (const listener of listeners)
      void Promise.resolve(listener(productID)).catch((error) =>
        log.error("product shutdown failed", { productID, error }),
      )
  return state
}

export async function withProduct<T>(productID: string, use: (state: ProductState) => T | Promise<T>): Promise<T> {
  using _ = await Lock.write(`agent-connection:${productID}`)
  return await use(await refresh(productID))
}

export function productState(productID: string) {
  return withProduct(productID, (state) => state)
}

export async function reconcile() {
  const { configuredProducts } = await import("./catalog")
  const ids = new Set((await configuredProducts()).map((product) => product.id))
  for (const key of await Storage.list(["agent_connection_state"])) ids.add(key[1])
  await Promise.all([...ids].map(productState))
}
