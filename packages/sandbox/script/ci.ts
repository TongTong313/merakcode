/**
 * CI helper for the sandbox job:
 *   setup   turn the sandbox on (Windows: create the account; the runner is already an administrator)
 *   reset   undo the setup and check that the account, its firewall rule and its permissions are gone
 */
import { execFileSync } from "node:child_process"
import os from "node:os"
import { Sandbox } from "../src/index"
import { WindowsSandbox } from "../src/windows"

const backend = Sandbox.backend()

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
