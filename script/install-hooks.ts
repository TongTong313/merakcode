// Points git at the repository's script/hooks. Usage: pnpm hooks:install
import { Process } from "@merakcode/util/process"

await Process.run(["git", "config", "core.hooksPath", "script/hooks"])
console.log("git hooks: script/hooks")
