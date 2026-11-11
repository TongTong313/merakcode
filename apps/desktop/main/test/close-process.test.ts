import { expect, test } from "vitest"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { closeProcess } from "../script/close-process"

test("a process already terminated by a signal is reported as an abnormal exit", async () => {
  const child = spawn(process.execPath, ["-e", "process.send('ready'); setInterval(() => {}, 1000)"], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  })
  try {
    await once(child, "message")
    const exited = once(child, "exit")
    child.kill("SIGKILL")
    await exited
    expect(child.signalCode).toBe("SIGKILL")
    await expect(closeProcess(child, async () => {}, 100)).rejects.toThrow("Packaged app exited with SIGKILL")
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
  }
})

test("the close deadline includes a request that never settles", async () => {
  const child = spawn(process.execPath, ["-e", "process.send('ready'); setInterval(() => {}, 1000)"], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  })
  try {
    await once(child, "message")
    await expect(closeProcess(child, () => new Promise(() => {}), 100)).rejects.toThrow(
      "Packaged app did not exit after closing",
    )
    expect(child.exitCode).toBeNull()
    expect(child.signalCode).toBeNull()
    expect(child.listenerCount("exit")).toBe(0)
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit")
      child.kill("SIGKILL")
      await exited
    }
  }
}, 2000)

test("a normal exit succeeds even when the close connection disappears", async () => {
  const child = spawn(process.execPath, ["-e", "process.send('ready'); process.on('message', () => process.exit(0))"], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  })
  try {
    await once(child, "message")
    await closeProcess(child, async () => {
      child.send("close")
      throw new Error("Target page, context or browser has been closed")
    })
    expect(child.exitCode).toBe(0)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
  }
})

test("a failed close request remains the cause when the process does not exit", async () => {
  const child = spawn(process.execPath, ["-e", "process.send('ready'); setInterval(() => {}, 1000)"], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  })
  const failure = new Error("Close command rejected")
  try {
    await once(child, "message")
    await expect(
      closeProcess(
        child,
        async () => {
          throw failure
        },
        100,
      ),
    ).rejects.toMatchObject({ message: "Packaged app did not exit after closing", cause: failure })
    expect(child.exitCode).toBeNull()
    expect(child.signalCode).toBeNull()
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit")
      child.kill("SIGKILL")
      await exited
    }
  }
})

test("a nonzero process exit fails even after the close request succeeds", async () => {
  const child = spawn(process.execPath, ["-e", "process.send('ready'); process.on('message', () => process.exit(7))"], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  })
  try {
    await once(child, "message")
    await expect(
      closeProcess(child, async () => {
        child.send("close")
      }),
    ).rejects.toThrow("Packaged app exited with 7")
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
  }
})
