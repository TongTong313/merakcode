import { Process } from "@merakcode/util/process"
import { readFile } from "node:fs/promises"
import path from "node:path"

/** A successful title must never count as a successful conversation reply. */
const result = await Process.run(
  [process.execPath, ...process.execArgv, path.join(import.meta.dirname, "smoke-package.ts"), "--fail-main"],
  { nothrow: true, timeout: 180_000 },
)
if (result.exitCode === 0 || !result.stderr.toString().includes("Main reply failed during button:reply"))
  throw new Error(`The packaged smoke did not reject the broken main reply: ${result.stderr.toString()}`)
const evidence = await readFile(
  path.join(import.meta.dirname, "../release/smoke-results/negative-control/error.txt"),
  "utf8",
)
if (!evidence.startsWith("button:reply\n") || !/"mainRequests":[1-9]/.test(evidence))
  throw new Error("The negative control failed before the main inference request")
process.stdout.write("Packaged smoke rejected a failed main reply despite a successful title\n")
