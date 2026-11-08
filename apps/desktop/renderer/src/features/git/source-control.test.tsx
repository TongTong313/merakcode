import { render } from "solid-js/web"
import { expect, test } from "vitest"
import { setLocale, t } from "../../i18n"
import { GitFiles } from "./source-control"

test("Git groups display staged and unstaged files with review navigation", () => {
  setLocale("zh")
  const host = document.createElement("div")
  document.body.append(host)
  const file = { path: "a.txt", status: "modified", staged: true }
  const dispose = render(
    () => (
      <GitFiles
        data={{ head: "head", branch: "main", files: [file, { ...file, staged: false }] }}
        onReview={() => {}}
      />
    ),
    host,
  )
  try {
    expect(host.querySelectorAll(".git-file")).toHaveLength(2)
    expect(host.querySelectorAll(`button[aria-label="${t("git.reviewFile", { file: "a.txt" })}"]`)).toHaveLength(2)
    expect(host.querySelector(".diff")).toBeNull()
    expect(host.querySelector('input[type="checkbox"][data-seen]')).toBeNull()
    expect(host.textContent).not.toContain(t("git.stageAll"))
    expect(host.textContent).not.toContain(t("git.unstageAll"))
  } finally {
    dispose()
    host.remove()
  }
})

test("a conflicted file remains readable for review", () => {
  setLocale("zh")
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(
    () => (
      <GitFiles
        data={{ head: "head", branch: "main", files: [{ path: "a.txt", status: "conflicted", staged: false }] }}
        onReview={() => {}}
      />
    ),
    host,
  )
  try {
    const open = host.querySelector<HTMLButtonElement>(`button[aria-label="${t("git.reviewFile", { file: "a.txt" })}"]`)
    expect(open?.disabled).toBe(false)
    expect(host.textContent).toContain(t("git.status.conflicted"))
  } finally {
    dispose()
    host.remove()
  }
})
