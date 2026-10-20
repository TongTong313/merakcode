import { expect, test } from "vitest"
import { UpdatePolicy } from "../src/update-policy"

test("Linux updates itself only as an AppImage; a .deb install sends people to the download page", () => {
  expect(UpdatePolicy.decide({ platform: "linux", appImage: true, signed: false, version: "1.0.0" }).mode).toBe("auto")
  expect(UpdatePolicy.decide({ platform: "linux", appImage: false, signed: false, version: "1.0.0" })).toMatchObject({
    mode: "manual",
    reason: "linux-package",
  })
})

test("macOS updates itself only when the app is signed", () => {
  expect(UpdatePolicy.decide({ platform: "darwin", appImage: false, signed: true, version: "1.0.0" }).mode).toBe("auto")
  expect(UpdatePolicy.decide({ platform: "darwin", appImage: false, signed: false, version: "1.0.0" })).toMatchObject({
    mode: "manual",
    reason: "mac-unsigned",
  })
})

test("Windows updates itself, signed or not", () => {
  expect(UpdatePolicy.decide({ platform: "win32", appImage: false, signed: false, version: "1.0.0" }).mode).toBe("auto")
})

test("a pre-release version also gets pre-releases", () => {
  expect(
    UpdatePolicy.decide({ platform: "win32", appImage: false, signed: false, version: "1.1.0-beta.2" }).allowPrerelease,
  ).toBe(true)
  expect(
    UpdatePolicy.decide({ platform: "win32", appImage: false, signed: false, version: "1.1.0" }).allowPrerelease,
  ).toBe(false)
})
