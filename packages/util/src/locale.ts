export namespace Locale {
  export function titlecase(str: string) {
    return str.replace(/\b\w/g, (c) => c.toUpperCase())
  }

  export function time(input: number): string {
    const date = new Date(input)
    return date.toLocaleTimeString(undefined, { timeStyle: "short" })
  }

  export function datetime(input: number): string {
    const date = new Date(input)
    const localTime = time(input)
    const localDate = date.toLocaleDateString()
    return `${localTime} · ${localDate}`
  }

  export function todayTimeOrDateTime(input: number): string {
    const date = new Date(input)
    const now = new Date()
    const isToday =
      date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()

    if (isToday) {
      return time(input)
    } else {
      return datetime(input)
    }
  }

  export function truncate(str: string, len: number): string {
    if (str.length <= len) return str
    return str.slice(0, len - 1) + "…"
  }
}
