import type { FileTreeRow } from "./file-tree-utils"

export type FileTreeActivation =
  { type: "noop" } | { type: "scroll-to-file"; fileIndex: number } | { type: "toggle-directory"; nodeId: number }

/** Activating a file tree row: files scroll into view (unless already selected), directories toggle. */
export function resolveFileTreeActivation(
  row: FileTreeRow | undefined,
  selectedFileIndex: number | undefined,
): FileTreeActivation {
  if (!row) return { type: "noop" }
  if (row.fileIndex !== undefined) {
    if (selectedFileIndex === row.fileIndex) return { type: "noop" }
    return { type: "scroll-to-file", fileIndex: row.fileIndex }
  }
  return { type: "toggle-directory", nodeId: row.id }
}
