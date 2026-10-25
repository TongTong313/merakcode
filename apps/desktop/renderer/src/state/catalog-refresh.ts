/** Last failure already shown for a provider, so the same one is not toasted again. */
export type SeenFailures = Record<string, string>

type CatalogNotice = {
  providerID: string
  code: string
  message: string
}

type Changed = {
  reason: string
  providerID?: string
  error?: {
    code?: string
    data?: { message?: string }
  }
}

const fingerprint = (code: string, message: string) => `${code}\0${message}`

/**
 * What the model picker should do with one provider.changed event.
 * A repeated failure stays quiet until that provider's list refreshes successfully.
 */
export function providerChanged(seen: SeenFailures, event: Changed) {
  if (event.reason !== "refreshed" && event.reason !== "refresh-failed") return { seen, reload: false }
  const providerID = event.providerID
  if (event.reason === "refreshed") {
    if (!providerID) return { seen, reload: true }
    const next = { ...seen }
    delete next[providerID]
    return { seen: next, reload: true }
  }
  const code = event.error?.code
  const message = event.error?.data?.message
  if (!providerID || !code?.startsWith("MRK-") || !message) return { seen, reload: true }
  if (seen[providerID] === fingerprint(code, message)) return { seen, reload: true }
  return {
    seen: { ...seen, [providerID]: fingerprint(code, message) },
    reload: true,
    toast: { providerID, code, message } satisfies CatalogNotice,
  }
}
