import { PermissionExecution } from "../../src/agent/permission/execution"

/** A ready OS-backend boundary for approval-only tests; commands cannot launch through this fixture. */
export function readySandbox() {
  const previous = process.env.MERAKCODE_SANDBOX_MODE
  process.env.MERAKCODE_SANDBOX_MODE = "preferred"
  PermissionExecution.useBackendForTest({
    status: async () => ({ status: "on", backend: "landlock" }),
    wrap: async () => {
      throw new Error("This fixture supports permission tests without command execution")
    },
  })
  return {
    [Symbol.dispose]() {
      PermissionExecution.useBackendForTest(undefined)
      if (previous === undefined) delete process.env.MERAKCODE_SANDBOX_MODE
      else process.env.MERAKCODE_SANDBOX_MODE = previous
    },
  }
}
