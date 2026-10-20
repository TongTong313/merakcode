import { expect, test } from "vitest"
import { notes } from "./notes"

const changelog = `# Changelog

## [Unreleased]

- something not out yet

## [0.2.0] - 2026-10-20

### Added
- merak doctor

## 0.1.0

- first release
`

test("takes the section of the version, without its heading", () => {
  expect(notes(changelog, "0.2.0")).toBe("### Added\n- merak doctor")
  expect(notes(changelog, "0.1.0")).toBe("- first release")
})

test("a version that is not in the changelog gets a short pointer instead", () => {
  expect(notes(changelog, "0.3.0")).toBe("MerakCode 0.3.0. See CHANGELOG.md for what changed.")
})
