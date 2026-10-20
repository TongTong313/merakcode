import { expect, test } from "vitest"
import { Diagnose } from "../src/diagnose"

test("missing libatomic (AppImage on a clean Ubuntu) suggests the package to install", () => {
  const error =
    "后端在开始监听前退出（127）：node: error while loading shared libraries: libatomic.so.1: cannot open shared object file"
  expect(Diagnose.hint(error, "zh")).toContain("sudo apt install libatomic1")
  expect(Diagnose.hint(error, "en")).toContain("sudo apt install libatomic1")
})

test("an old glibc names the required version", () => {
  const error = "node: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.28' not found (required by node)"
  expect(Diagnose.hint(error, "zh")).toContain("glibc 2.28")
})

test("unknown errors get no hint", () => {
  expect(Diagnose.hint("后端启动超时", "zh")).toBeUndefined()
  expect(Diagnose.hint(undefined, "zh")).toBeUndefined()
})
