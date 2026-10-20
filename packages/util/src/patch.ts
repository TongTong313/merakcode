export namespace Patch {
  /**
   * The human-readable part of a unified diff, starting at the first hunk (@@).
   * Header paths are quoted git-style, with backslashes and non-ASCII characters escaped ("C:\\proj\\\350\257..."),
   * and every place that shows a diff already shows the path separately, so the header is only noise.
   * Returns the input unchanged when there are no hunks.
   */
  export function hunks(diff: string) {
    const start = diff.indexOf("\n@@")
    return start === -1 ? diff : diff.slice(start + 1)
  }
}
