import { render } from "solid-js/web"
import { expect, test } from "vitest"
import { setLocale } from "../../i18n"
import { GitFiles } from "./source-control"

test("opens a changed file for review without offering index mutations", () => {
  setLocale("en")
  const host = document.createElement("div")
  document.body.append(host)
  let opened = ""
  const dispose = render(
    () => (
      <GitFiles
        data={{ branch: "main", head: "head", files: [{ path: "note.txt", status: "modified", staged: false }] }}
        onReview={(file) => {
          opened = file
        }}
      />
    ),
    host,
  )
  try {
    const buttons = [...host.querySelectorAll<HTMLButtonElement>("button")]
    expect(buttons.map((button) => button.textContent?.trim())).toEqual(["note.txt"])
    buttons[0]!.click()
    expect(opened).toBe("note.txt")
  } finally {
    dispose()
    host.remove()
  }
})
