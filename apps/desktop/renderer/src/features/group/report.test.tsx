import { render } from "solid-js/web"
import { expect, test } from "vitest"
import { setLocale } from "../../i18n"
import { Report } from "./report"

test("renders the report fields and distinguishes unknown cost from a free run", () => {
  setLocale("en")
  const host = document.createElement("div")
  const dispose = render(
    () => (
      <Report
        report={{
          claim: "claim",
          verdict: "needs_review",
          summary: "Updated the documentation.",
          changes: [{ path: "README.md", kind: "modified", added: 2, removed: 1 }],
          checks: [{ command: "go test ./...", exitCode: 0 }],
          artifacts: [{ path: "report.txt", title: "Verification notes" }],
          questions: ["Confirm the wording?"],
          next: ["Publish the examples."],
          usage: { input: 17, output: 9, cacheRead: 4, cacheWrite: 0, cost: 0, costKnown: false },
        }}
      />
    ),
    host,
  )
  try {
    expect(host.textContent).toContain("Needs review")
    expect(host.textContent).toContain("Updated the documentation.")
    const changes = host.querySelector('table[aria-label="File changes"]')!
    expect(changes.textContent).toContain("README.md")
    expect(changes.textContent).toContain("+2")
    expect(changes.textContent).toContain("−1")
    expect(host.textContent).toContain("go test ./...")
    expect(host.textContent).toContain("Exit code 0")
    expect(host.textContent).toContain("Verification notes")
    expect(host.textContent).toContain("report.txt")
    expect(host.textContent).toContain("Confirm the wording?")
    expect(host.textContent).toContain("Publish the examples.")
    expect(host.textContent).toContain("Input 17 · output 9")
    expect(host.textContent).toContain("Cost unavailable")
  } finally {
    dispose()
  }
})
