import { parsePatch } from "diff"

export type PatchHunk = {
  fileIndex: number
  hunkIndex: number
  contentY: number
}

export type SelectedHunk = {
  fileIndex: number
  hunkIndex: number
  scrollTop: number
}

export type RenderedHunkEntry = {
  fileIndex: number
  baseContentY: number
  hunkRows?: readonly number[]
  patch?: string
}

/** Hunk start rows counted from the rendered +/-/context lines, matching OpenTUI's unified view. */
export function logicalHunkRows(patch: string) {
  const patches = parsePatch(patch)
  if (patches.length === 0) return []
  const rows: number[] = []
  let line = 0
  for (const parsed of patches) {
    for (const hunk of parsed.hunks) {
      rows.push(line)
      for (const item of hunk.lines) {
        const prefix = item[0]
        if (prefix === "+" || prefix === "-" || prefix === " ") line++
      }
    }
  }
  return rows
}

/** Collects hunk scroll positions from OpenTUI <diff> row offsets (or logical patch rows). */
export function collectRenderedHunks(entries: readonly RenderedHunkEntry[]) {
  return entries
    .flatMap(({ fileIndex, baseContentY, hunkRows, patch }) => {
      const rows = hunkRows?.length ? hunkRows : patch ? logicalHunkRows(patch) : []
      return rows.map((row, hunkIndex) => ({
        fileIndex,
        hunkIndex,
        contentY: baseContentY + row,
      }))
    })
    .sort((left, right) => left.contentY - right.contentY)
}

/** Picks the previous or next hunk relative to the current position. */
export function pickRelativeHunk(
  hunks: readonly PatchHunk[],
  scrollTop: number,
  selected: SelectedHunk | undefined,
  offset: -1 | 1,
) {
  if (hunks.length === 0) return undefined

  if (selected) {
    const selectedIndex = hunks.findIndex(
      (hunk) => hunk.fileIndex === selected.fileIndex && hunk.hunkIndex === selected.hunkIndex,
    )
    if (selectedIndex !== -1) {
      const next = selectedIndex + offset
      if (next < 0 || next >= hunks.length) return undefined
      return hunks[next]
    }
  }

  // Without a selected hunk, ] goes to the first hunk below the viewport top.
  if (offset === 1) return hunks.find((hunk) => hunk.contentY > scrollTop)

  // [ goes to the hunk before the current one; on the first hunk it returns undefined and the caller scrolls to top.
  const at = hunks.findLastIndex((hunk) => hunk.contentY <= scrollTop + 1)
  if (at === -1) return undefined
  if (hunks[at].contentY >= scrollTop - 3) return at > 0 ? hunks[at - 1] : undefined
  return hunks[at]
}
