// Provider credential changes must invalidate the Provider cache after removing or writing credentials.
// The connected list of provider.list comes from a memoized Instance.state cache built on Auth.all() (see state() in
// provider.ts); without invalidation a UI refetch still hits the old cache and the disconnect/connect buttons in
// settings appear to do nothing.
import type { Auth } from "../auth"

/** Every credential change must invalidate the Provider cache */
interface CacheInvalidator {
  /** Invalidates the Provider cache so the next list rebuilds it */
  invalidate(): void
  /** Tells all clients to refetch the provider list after invalidation */
  changed(): Promise<void>
}

/** Side effects needed to disconnect a provider */
export interface ProviderDisconnectDeps extends CacheInvalidator {
  /** Removes the credentials stored under a key */
  remove(key: string): Promise<void>
}

/**
 * Disconnects a provider: removes the credentials, then invalidates the cache.
 * Without invalidation, provider.list hits the old cache and still shows it as connected.
 */
export async function disconnectProvider(providerID: string, deps: ProviderDisconnectDeps): Promise<void> {
  await deps.remove(providerID)
  deps.invalidate()
  await deps.changed()
}

/** Side effects needed to connect a provider */
export interface ProviderConnectDeps extends CacheInvalidator {
  /** Writes the credentials under a key */
  set(key: string, info: Auth.Info): Promise<void>
}

/**
 * Connects a provider: writes the credentials, then invalidates the cache.
 * Without invalidation, provider.list hits the old cache and still shows it as disconnected.
 */
export async function connectProvider(storeID: string, info: Auth.Info, deps: ProviderConnectDeps): Promise<void> {
  await deps.set(storeID, info)
  deps.invalidate()
  await deps.changed()
}
