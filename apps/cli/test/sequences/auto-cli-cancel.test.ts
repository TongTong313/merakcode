import { expect, test } from "vitest"
import { sequence, response } from "../fixture/sdk-sequence"
import { pty } from "../fixture/sequence-pty"
import { setTimeout as delay } from "node:timers/promises"

for (const autocomplete of [false, true])
  test(`/auto-cli task accepts TUI Escape cancellation${autocomplete ? " with autocomplete" : ""}`, async () => {
    let started = false
    let cancelled = false
    let heartbeat: ReturnType<typeof setInterval> | undefined
    const kit = await sequence("read", false, ({ input }) => {
      if (!input.includes("/auto-cli")) return response("OTHER")
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            started = true
            heartbeat = setInterval(() => controller.enqueue(new TextEncoder().encode(": heartbeat\n\n")), 1000)
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ id: "held", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "AUTO_CLI_PARTIAL" } }] })}\n\n`,
              ),
            )
          },
          cancel() {
            clearInterval(heartbeat)
            cancelled = true
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      )
    })
    let terminal: Awaited<ReturnType<typeof pty>> | undefined
    let success = false
    try {
      const session = await kit.api("/session", "POST", { title: "auto-cli-cancel" })
      terminal = await pty(kit, session.id, "auto-cli-cancel")
      const sent = await terminal.submit("/auto-cli")
      await delay(100)
      terminal.write("\r")
      await terminal.wait(() => started && terminal!.visible("AUTO_CLI_PARTIAL", sent), "skill model started")
      expect((await kit.api("/session/status"))[session.id]?.type).toBe("busy")
      if (autocomplete) {
        const popupAt = terminal.offset()
        terminal.write("/")
        await terminal.wait(() => terminal!.visible("auto-cli", popupAt), "slash autocomplete visible")
      }
      terminal.write("\x1b")
      await delay(100)
      expect((await kit.api("/session/status"))[session.id]?.type).toBe("busy")
      terminal.write("\x1b")
      const abortAt = Date.now()
      await terminal.wait(
        async () => (await kit.api("/session/status"))[session.id]?.type !== "busy",
        "skill session idle",
      )
      expect(Date.now() - abortAt).toBeLessThan(4000)
      await terminal.wait(async () => {
        const messages = await kit.api(`/session/${session.id}/message`)
        return messages.some(
          (x: { info: { role: string; error?: { name?: string } } }) =>
            x.info.role === "assistant" && x.info.error?.name === "MessageAbortedError",
        )
      }, "skill assistant aborted")
      expect(cancelled).toBe(true)
      success = true
    } finally {
      clearInterval(heartbeat)
      try {
        await terminal?.close()
      } finally {
        await kit.finish(success)
      }
    }
  }, 120_000)
