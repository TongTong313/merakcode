import { expect, test } from "vitest"
import { notes, section } from "./notes"

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

test("a version without a section, or with an empty one, has no section: publishing requires one", () => {
  expect(section(changelog, "0.2.0")).toBe("### Added\n- merak doctor")
  expect(section(changelog, "0.3.0")).toBeUndefined()
  expect(section("## [0.3.0] - 2026-10-21\n\n## [0.2.0]\n- x\n", "0.3.0")).toBeUndefined()
  expect(section("## [0.3.0-beta.1]\n- try it\n", "0.3.0-beta.1")).toBe("- try it")
})
