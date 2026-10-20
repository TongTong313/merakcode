import { useLocale } from "../context/locale"

export function localizedProviderName(t: ReturnType<typeof useLocale>["t"], p: { id: string; name?: string }): string {
  const key = `provider.name.${p.id}`
  const v = t(key)
  return v && v !== key ? v : (p.name ?? p.id)
}
