import { expect, test } from "vitest"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { z } from "zod"
import { response, sequence } from "../fixture/sdk-sequence"
import { pty } from "../fixture/sequence-pty"
import { Filesystem } from "@merakcode/util/filesystem"

test("S07.07 real TUI pasted image path becomes exact model image payload", async () => {
  // Owned synthetic 1x1 PNG. The terminal's bracketed-paste file-path branch
  // invokes the actual pasteImage() flow; no OS clipboard API is accessed.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgcPj/HwADwgI/a1FO7AAAAABJRU5ErkJggg==",
    "base64",
  )
  const hash = createHash("sha256").update(png).digest("hex")
  const observations: { follow: boolean; images: number; sha256?: string }[] = []
  const kit = await sequence(
    "read",
    false,
    ({ input, messages, outputs, project, send }) => {
      const follow = input.includes("S07_IMAGE_FOLLOW")
      if (!input.includes("S07_IMAGE")) throw new Error("S07 unexpected image input")
      const content = messages.findLast((item) => item.role === "user")?.content
      const parts = z
        .array(z.object({ type: z.string(), image_url: z.object({ url: z.string() }).optional() }))
        .safeParse(content)
      const images = parts.success ? parts.data.filter((part) => part.type === "image_url") : []
      if (images.length !== (follow ? 0 : 1)) throw new Error("S07 current model image count mismatch")
      const url = images[0]?.image_url?.url
      const bytes = url?.startsWith("data:image/png;base64,")
        ? Buffer.from(url.slice("data:image/png;base64,".length), "base64")
        : undefined
      const actual = bytes && createHash("sha256").update(bytes).digest("hex")
      if (!follow && (actual !== hash || bytes?.length !== png.length))
        throw new Error("S07 actual image bytes or MIME mismatch")
      observations.push({ follow, images: images.length, sha256: actual })
      if (!outputs.length) return send("read", { filePath: join(project, "src/a.txt") })
      const marker = outputs[0].text.match(/MARKER_[a-f0-9-]+/)?.[0]
      if (outputs.length !== 1 || !marker) throw new Error("S07 actual marker read missing")
      return response(`${follow ? "S07_IMAGE_FOLLOW_DONE" : "S07_IMAGE_DONE"} ${marker}`)
    },
    async ({ project }) => {
      const file = join(project, "merakcode.json")
      const config = await Filesystem.readJson(file)
      config.provider.alibaba.models = {
        "qwen-plus": { attachment: true, modalities: { input: ["text", "image"], output: ["text"] } },
      }
      await Filesystem.write(file, JSON.stringify(config))
      await Filesystem.write(join(project, "test-image.png"), png)
    },
  )
  let success = false
  let failure: unknown
  try {
    const session = await kit.api("/session", "POST", { title: "S07.07" })
    const terminal = await pty(kit, session.id, "S07.07")
    const pasted = terminal.offset()
    terminal.write(`\x1b[200~${join(kit.project, "test-image.png")}\x1b[201~`)
    await terminal.wait(() => terminal.visible("[图片 1]", pasted), "actual pasted image chip")
    const sent = await terminal.submit(" S07_IMAGE 核对图片附件传输，并读取 src/a.txt")
    await terminal.wait(() => terminal.visible("S07_IMAGE_DONE", sent), "actual image task answer")
    const history = z
      .array(
        z.object({
          info: z.object({ id: z.string(), role: z.string(), sessionID: z.string() }),
          parts: z.array(
            z.object({
              type: z.string(),
              text: z.string().optional(),
              mime: z.string().optional(),
              url: z.string().optional(),
            }),
          ),
        }),
      )
      .parse(await kit.api(`/session/${session.id}/message`))
    const users = history.filter(
      (item) => item.info.role === "user" && item.parts.some((part) => part.text?.includes("S07_IMAGE")),
    )
    expect(users).toHaveLength(1)
    const images = users[0].parts.filter((part) => part.type === "file")
    expect(images).toHaveLength(1)
    expect(images[0].mime).toBe("image/png")
    expect(images[0].url).toBe(`data:image/png;base64,${png.toString("base64")}`)
    await kit.assertResult(session.id, users[0].info.id, "S07_IMAGE_DONE")
    const follow = "S07_IMAGE_FOLLOW 只读 src/a.txt，不附加新图片"
    const next = await terminal.submit(follow)
    await terminal.wait(() => terminal.visible("S07_IMAGE_FOLLOW_DONE", next), "ordinary image-free follow-up")
    await kit.assertResult(session.id, await kit.submitted(session.id, follow), "S07_IMAGE_FOLLOW_DONE")
    expect(observations.some((item) => !item.follow && item.sha256 === hash)).toBe(true)
    expect(observations.filter((item) => item.follow).every((item) => item.images === 0)).toBe(true)
    await Filesystem.write(
      join(kit.artifacts, "sequence.json"),
      JSON.stringify({
        id: "S07.07",
        layer: "P/M+T",
        sessionID: session.id,
        userID: users[0].info.id,
        mime: "image/png",
        bytes: png.length,
        sha256: hash,
        observations,
        entry: "actual TUI bracketed paste of owned PNG path -> pasteImage -> model payload",
        clipboard: "not accessed; OS clipboard integration remains Q08",
        realImageRecognition: "unverified",
      }),
    )
    success = true
  } catch (error) {
    failure = error
    throw error
  } finally {
    await kit.finish(success, failure)
  }
}, 90_000)
