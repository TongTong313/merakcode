export namespace EnvVar {
  const TRUE_VALUES = new Set(["1", "true", "yes", "on", "enabled"])

  export function bool(key: string): boolean | undefined {
    const value = process.env[key]
    if (value === undefined) return undefined
    return TRUE_VALUES.has(value.trim().toLowerCase())
  }

  export function int(key: string): number | undefined {
    const value = process.env[key]
    if (!value) return undefined
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined
  }

  export function choice<T extends string>(key: string, values: readonly T[], fallback: T): T | undefined {
    const value = process.env[key]?.trim().toLowerCase()
    if (value === undefined) return undefined
    return values.includes(value as T) ? (value as T) : fallback
  }
}
