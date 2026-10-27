import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { expect, test } from "vitest"
import { setLocale, t } from "../../i18n"
import { GitFiles } from "./source-control"

test("Git groups expose review navigation only while that file is pending review", () => {
  setLocale("zh")
  const [pending, setPending] = createSignal(["a.txt"])
  const host = document.createElement("div")
  document.body.append(host)
  const file = { file: "a.txt", status: "modified" as const, version: "v1" }
  const dispose = render(
    () => (
      <GitFiles
        data={{ checkout: "c", staged: [file], unstaged: [file] }}
        pending={pending()}
        working={false}
        onChange={async () => {}}
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
    setPending([])
    expect(host.querySelectorAll(`button[aria-label="${t("git.reviewFile", { file: "a.txt" })}"]`)).toHaveLength(0)
    expect(host.querySelectorAll(".git-file")).toHaveLength(2)
    expect(host.textContent).toContain(t("git.stage"))
    expect(host.textContent).toContain(t("git.unstage"))
  } finally {
    dispose()
    host.remove()
  }
})

test("a conflicted file remains available for explicit staging after editing its resolution", () => {
  setLocale("zh")
  const host = document.createElement("div")
  document.body.append(host)
  const dispose = render(
    () => (
      <GitFiles
        data={{ checkout: "c", staged: [], unstaged: [{ file: "a.txt", status: "conflicted", version: "v" }] }}
        pending={[]}
        working={false}
        onChange={async () => {}}
        onReview={() => {}}
      />
    ),
    host,
  )
  try {
    const stage = host.querySelector<HTMLButtonElement>(`button[aria-label="${t("git.stage")} a.txt"]`)
    expect(stage?.disabled).toBe(false)
    expect(host.querySelector<HTMLInputElement>("input")?.disabled).toBe(false)
  } finally {
    dispose()
    host.remove()
  }
})
