import { render } from "solid-js/web"
import { expect, test } from "vitest"
import { setLocale } from "../../i18n"
import { GroupInbox } from "./inbox"

test.each([
  ["en", "Project file watcher exceeded its scan limit", "50000 files"],
  ["zh", "项目文件监视器超出扫描上限", "50000 个文件"],
] as const)("renders watcher findings in %s", (language, title, limit) => {
  setLocale(language)
  const host = document.createElement("div")
  const dispose = render(
    () => (
      <GroupInbox
        inbox={{
          todo: [],
          lastSeq: 1,
          info: [
            {
              id: "notice",
              kind: "info",
              text: "MRK-1005",
              to: [],
              scope: { group: "group" },
              time: "2026-11-09T00:00:00Z",
            },
          ],
        }}
        onTask={() => {}}
      />
    ),
    host,
  )
  try {
    expect(host.textContent).toContain(title)
    expect(host.textContent).toContain(limit)
    expect(host.textContent).toContain("MRK-1005")
  } finally {
    dispose()
  }
})
