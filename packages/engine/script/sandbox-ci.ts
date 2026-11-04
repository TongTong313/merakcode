/**
 * CI helper for the sandbox job:
 *   setup   turn the sandbox on (Windows: create the account; the runner is already an administrator)
 *   reset   undo the setup and check that the account, its firewall rule and its permissions are gone
 */
import { execFileSync, spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { Sandbox } from "../src/infra/sandbox/index"
import { WindowsSandbox } from "../src/infra/sandbox/windows/index"

import { SandboxPolicy } from "../src/agent/permission/sandbox-policy"

const backend = Sandbox.backend(SandboxPolicy.base(os.homedir()))

if (process.argv[2] === "verify") {
  const status = await backend.status()
  console.log(JSON.stringify(status))
  if (status.status !== "on") {
    console.error("Sandbox verification never runs setup. Run merak sandbox setup once, then retry verification.")
    process.exit(1)
  }
  const vitest = path.join(path.dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs")
  const result = spawnSync(
    process.execPath,
    [vitest, "run", "--config", "vitest.sandbox.config.ts", "test/sandbox/os/conformance.test.ts"],
    {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, MERAKCODE_SANDBOX_REQUIRED: "1" },
      stdio: "inherit",
      windowsHide: true,
    },
  )
  process.exit(result.status ?? 1)
}

function powershell(command: string) {
  return execFileSync("powershell.exe", ["-NoProfile", "-Command", command], { encoding: "utf8" }).trim()
}

if (process.argv[2] === "setup") {
  const before = await backend.status()
  const status = before.status === "on" || !before.installable ? before : await backend.setup!(console.log)
  console.log(JSON.stringify(status))
  if (status.status !== "on") process.exit(1)
}

if (process.argv[2] === "reset") {
  const status = await backend.reset!()
  console.log(JSON.stringify(status))
  const problems = [
    ...(powershell(`if (Get-LocalUser -Name ${WindowsSandbox.ACCOUNT} -ErrorAction SilentlyContinue) { 'account' }`)
      ? ["the account still exists"]
      : []),
    ...(powershell(
      `if (Get-NetFirewallRule -DisplayName ${WindowsSandbox.RULE} -ErrorAction SilentlyContinue) { 'rule' }`,
    )
      ? ["the firewall rule still exists"]
      : []),
    ...(execFileSync("icacls", [os.homedir()], { encoding: "utf8" }).includes(WindowsSandbox.ACCOUNT)
      ? ["the home folder still has a permission for the account"]
      : []),
    ...(status.status === "on" ? ["the status is still on"] : []),
  ]
  if (problems.length) {
    console.error(`reset left things behind: ${problems.join("; ")}`)
    process.exit(1)
  }
}
