import path from "path"
import { Config } from "@merakcode/engine/config/config"
import { Flag } from "@merakcode/engine/flag/flag"
import { Global } from "@merakcode/engine/global/index"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"

const flag = Flag as { MERAKCODE_DISABLE_RULES: boolean; MERAKCODE_DISABLE_CURSOR_RULES: boolean }

export function ruleFlags() {
  return flag
}

/**
 * Rule scanning reads the global config (`rules.user`) and $HOME. Without isolation the machine's real
 * ~/.config/merakcode/merakcode.json leaks into assertions and results differ between machines.
 * Project rule files must be .mdc files with alwaysApply frontmatter.
 */
export async function isolate<T>(fn: (globalDir: string) => Promise<T>) {
  const globalTmp = await tmpdir()
  const homeTmp = await tmpdir()
  const originals = {
    rules: flag.MERAKCODE_DISABLE_RULES,
    cursor: flag.MERAKCODE_DISABLE_CURSOR_RULES,
    configDir: process.env["MERAKCODE_CONFIG_DIR"],
    home: process.env["MERAKCODE_TEST_HOME"],
    config: Global.Path.config,
  }
  delete process.env["MERAKCODE_CONFIG_DIR"]
  process.env["MERAKCODE_TEST_HOME"] = homeTmp.path
  ;(Global.Path as { config: string }).config = globalTmp.path
  Config.global.reset()
  flag.MERAKCODE_DISABLE_RULES = false
  flag.MERAKCODE_DISABLE_CURSOR_RULES = false
  try {
    return await fn(globalTmp.path)
  } finally {
    flag.MERAKCODE_DISABLE_RULES = originals.rules
    flag.MERAKCODE_DISABLE_CURSOR_RULES = originals.cursor
    ;(Global.Path as { config: string }).config = originals.config
    if (originals.configDir === undefined) delete process.env["MERAKCODE_CONFIG_DIR"]
    else process.env["MERAKCODE_CONFIG_DIR"] = originals.configDir
    if (originals.home === undefined) delete process.env["MERAKCODE_TEST_HOME"]
    else process.env["MERAKCODE_TEST_HOME"] = originals.home
    Config.global.reset()
    await globalTmp[Symbol.asyncDispose]()
    await homeTmp[Symbol.asyncDispose]()
  }
}

export function nativeRule(dir: string, name: string, frontmatter: string, body = "# body") {
  return Filesystem.write(path.join(dir, ".merakcode", "rules", name), `---\n${frontmatter}\n---\n\n${body}\n`)
}

export function cursorRule(dir: string, name: string, frontmatter: string, body = "# body") {
  return Filesystem.write(path.join(dir, ".cursor", "rules", name), `---\n${frontmatter}\n---\n\n${body}\n`)
}
