import { z } from "zod"
import { sequence } from "./sdk-sequence"
import { setTimeout as delay } from "node:timers/promises"

/** Product HTTP driver for P-only cards. Replies once to actual requests, never seeds an allow rule. */
export async function drive(
  kit: Awaited<ReturnType<typeof sequence>>,
  sessionID: string,
  input: string,
  permissions: string[] = [],
  permissionMode?: "ask" | "auto",
  agent = "build",
) {
  let settled = false
  const request = kit
    .api(`/session/${sessionID}/message`, "POST", {
      agent,
      ...(permissionMode ? { permissionMode } : {}),
      model: { providerID: "alibaba", modelID: "qwen-plus" },
      parts: [{ type: "text", text: input }],
    })
    .then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    .finally(() => {
      settled = true
    })
  const replied = new Set<string>()
  const deadline = Date.now() + 60_000
  while (!settled) {
    if (Date.now() >= deadline) throw new Error("Sequence product round exceeded 60 seconds")
    const pending = z
      .array(z.object({ id: z.string(), sessionID: z.string(), permission: z.string() }))
      .parse(await kit.api("/permission"))
    for (const item of pending.filter((item) => item.sessionID === sessionID && !replied.has(item.id))) {
      if (!permissions.includes(item.permission)) throw new Error(`Unexpected permission class: ${item.permission}`)
      await kit.api(`/permission/${item.id}/reply`, "POST", { reply: "once" })
      replied.add(item.id)
    }
    if (!settled) await delay(40)
  }
  const result = await request
  if (!result.ok) throw result.error
  return { userID: await kit.submitted(sessionID, input), permissions: [...replied] }
}
