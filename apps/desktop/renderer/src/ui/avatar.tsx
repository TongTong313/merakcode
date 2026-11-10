/** Keeps a member's avatar color stable when its name changes. */
export function Avatar(props: { id: string; name: string }) {
  const hue = () => {
    let hash = 0
    for (const char of props.id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
    return Math.round((hash * 137.508) % 360)
  }
  const initials = () => {
    const chars = [...props.name]
    if (/\p{Script=Han}/u.test(props.name)) return chars.slice(-2).join("")
    return (chars[0] ?? "").toUpperCase()
  }
  return (
    <span class="avatar" style={{ "--hue": String(hue()) }} aria-hidden="true">
      {initials()}
    </span>
  )
}
