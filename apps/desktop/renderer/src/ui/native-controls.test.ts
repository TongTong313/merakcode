import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { expect, test } from "vitest"

const src = path.resolve(import.meta.dirname, "..")
const kinds = { select: /<select\b/g, radio: /type="radio"/g, checkbox: /type="checkbox"/g }

/**
 * Native controls that stay, with how many of each: panels restored from the UI branch whose e2e specs address them as
 * native checkboxes, and one list of group members, which is a multi-select list rather than a switch.
 */
const allowed: Record<string, Partial<Record<keyof typeof kinds, number>>> = {
  "features/code/code.tsx": { select: 1 },
  "features/git/commit.tsx": { select: 1 },
  "features/git/source-control.tsx": { checkbox: 1 },
  "features/review/diff.tsx": { checkbox: 1 },
  "features/settings/relay-dialog.tsx": { checkbox: 1, radio: 1 },
  "features/conversation/page.tsx": { checkbox: 1 },
  "features/conversation/group-create.tsx": { checkbox: 1 },
}

test("pages use ui/select, ui/segmented and ui/switch instead of native select, radio and checkbox", () => {
  const found = readdirSync(src, { recursive: true, encoding: "utf8" })
    .filter((entry) => /\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry))
    .map((entry) => entry.replaceAll("\\", "/"))
    .filter((entry) => !entry.startsWith("ui/"))
    .flatMap((entry) => {
      const text = readFileSync(path.join(src, entry), "utf8")
      return Object.entries(kinds).flatMap(([kind, pattern]) => {
        const count = text.match(pattern)?.length ?? 0
        const limit = allowed[entry]?.[kind as keyof typeof kinds] ?? 0
        return count > limit ? [`${entry}: ${count} native ${kind}, ${limit} allowed`] : []
      })
    })
  expect(found).toEqual([])
})
