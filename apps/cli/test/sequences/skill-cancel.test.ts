import { expect, test } from "vitest"
import { sequence, response, until } from "../fixture/sdk-sequence"

test("aborting a running built-in skill stops the model stream and records the turn as aborted", async () => {
  let started = false
  let cancelled = false
  let heartbeat: ReturnType<typeof setInterval> | undefined
  const kit = await sequence("read", false, ({ input }) => {
    if (!input.includes("adapter-generator")) return response("OTHER")
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          started = true
          heartbeat = setInterval(() => controller.enqueue(new TextEncoder().encode(": heartbeat\n\n")), 1000)
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({ id: "held", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "SKILL_PARTIAL" } }] })}\n\n`,
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
  let success = false
  try {
    const session = await kit.api("/session", "POST", { title: "skill-cancel" })
    // The command route answers only when the turn ends, so it runs in the background until the abort
    const command = kit
      .api(`/session/${session.id}/command`, "POST", {
        command: "adapter-generator",
        arguments: "",
        agent: "build",
        model: "alibaba-cn/qwen-plus",
      })
      .catch(() => undefined)
    await until(() => started, "skill model started")
    await until(async () => (await kit.api("/session/status"))[session.id]?.type === "busy", "skill session busy")
    const abortAt = Date.now()
    expect(await kit.api(`/session/${session.id}/abort`, "POST")).toBe(true)
    await until(async () => (await kit.api("/session/status"))[session.id]?.type !== "busy", "skill session idle")
    expect(Date.now() - abortAt).toBeLessThan(4000)
    await until(async () => {
      const messages = await kit.api(`/session/${session.id}/message`)
      return messages.some(
        (x: { info: { role: string; error?: { name?: string } } }) =>
          x.info.role === "assistant" && x.info.error?.name === "MessageAbortedError",
      )
    }, "skill assistant aborted")
    await until(() => cancelled, "model stream cancelled")
    await command
    success = true
  } finally {
    clearInterval(heartbeat)
    await kit.finish(success)
  }
}, 120_000)
