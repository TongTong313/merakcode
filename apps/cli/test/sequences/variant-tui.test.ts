import { expect, test } from "vitest"
import { join } from "node:path"
import { variants } from "../fixture/variant-sequence"
import { pty } from "../fixture/sequence-pty"
import { Filesystem } from "@merakcode/util/filesystem"
import { setTimeout as delay } from "node:timers/promises"

for (const id of ["S02.02", "S02.03"]) {
  test(`${id} real TUI reasoning selection reaches actual Provider parameters and completes both file tasks`, async () => {
    const toggle = id === "S02.03"
    const kit = await variants(toggle)
    let terminal: Awaited<ReturnType<typeof pty>> | undefined
    let success = false
    try {
      const session = await kit.api("/session", "POST", { title: id })
      terminal = await pty(kit, session.id, id)
      const users: string[] = []
      for (const [index, tag] of ["S02_VARIANT_A", "S02_VARIANT_B"].entries()) {
        const variant = toggle ? (index === 0 ? "off" : undefined) : index === 0 ? "low" : "high"
        if (toggle) await terminal.submit("/thinking")
        else terminal.write("\x14")
        await terminal.wait(async () => {
          const file = join(kit.root, "state/merakcode/model.json")
          if (!(await Filesystem.isFile(file))) return false
          return (await Filesystem.readJson(file)).variant?.["alibaba/qwen-plus"] === variant
        }, "reasoning selection persisted from actual TUI action")
        await delay(150)
        const input = `${tag} 使用当前档位读取实际文件`
        const sent = await terminal.submit(input)
        await terminal.wait(() => terminal!.visible(`${tag}_DONE`, sent), "selected variant actual task visible")
        const userID = await kit.submitted(session.id, input)
        users.push(userID)
        await kit.assertResult(session.id, userID, `${tag}_DONE`)
        const history = await kit.api(`/session/${session.id}/message`)
        expect(history.find((entry: { info: { id: string } }) => entry.info.id === userID).info.variant).toBe(variant)
        const requests = kit.parameters.filter((item) => item.tag === tag)
        expect(requests.length).toBeGreaterThan(0)
        expect(
          requests.every(
            (item) =>
              item.model === "qwen-plus" &&
              item.thinking === !(toggle && index === 0) &&
              item.budget === (!toggle && index === 1 ? 256 : 128),
          ),
        ).toBe(true)
      }
      await Filesystem.write(
        join(kit.artifacts, "sequence.json"),
        JSON.stringify({
          id,
          layer: "P/M+T",
          sessionID: session.id,
          users,
          parameters: kit.parameters,
          modelQuality: "controlled protocol only",
        }),
      )
      success = true
    } finally {
      try {
        await terminal?.close()
      } finally {
        await kit.finish(success)
      }
    }
  }, 120_000)
}
