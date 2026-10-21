import { expect, test } from "vitest"
import { pathToFileURL } from "node:url"
import path from "path"
import { Identifier } from "@merakcode/util/id"
import { Message } from "@merakcode/engine/session/message"
import { Log } from "@merakcode/log/logger"
import { tmpdir, runtime } from "../fixture/fixture"
import { Filesystem } from "@merakcode/util/filesystem"
import { Process } from "@merakcode/util/process"

Log.init({ print: false })

/**
 * Several processes (product instances on one machine) write to the same session at once, including MB-sized parts;
 * every part must be stored complete. The child processes inherit MERAKCODE_HOME, so they share this database.
 */
test("two processes writing to one session store every part complete", async () => {
  await using tmp = await tmpdir()
  const sessionID = Identifier.descending("session")
  const messageID = Identifier.ascending("message")
  const count = 120
  const big = 1_000_000
  const script = path.join(tmp.path, "append.mts")
  const module = path.join(import.meta.dirname, "../../../../packages/engine/src/session/transcript.ts")
  await Filesystem.write(
    script,
    `import { Transcript } from ${JSON.stringify(pathToFileURL(module).href)}
const [sessionID, messageID, tag, count] = process.argv.slice(2)
for (let index = 0; index < Number(count); index++) {
  const id = "prt_" + tag + String(index).padStart(5, "0")
  const text = index % 20 === 0 ? tag.repeat(${big}) : tag + "-" + index
  await Transcript.append(sessionID, [{ type: "part", part: { id, sessionID, messageID, type: "text", text } }])
}
`,
  )

  const children = ["a", "b"].map((tag) =>
    Process.spawn([...runtime, script, sessionID, messageID, tag, String(count)], {
      cwd: path.join(import.meta.dirname, "../.."),
      env: process.env,
      stdout: "ignore",
      stderr: "pipe",
    }),
  )
  const codes = await Promise.all(children.map((child) => child.exited))
  const errors = await Promise.all(children.map((child) => new Response(child.stderr).text()))
  expect(codes, errors.join("\n")).toEqual([0, 0])

  const parts = (await Message.parts({ sessionID, messageID })) as Message.TextPart[]
  expect(parts).toHaveLength(count * 2)
  for (const tag of ["a", "b"]) {
    const mine = parts.filter((part) => part.id.startsWith("prt_" + tag))
    expect(mine).toHaveLength(count)
    for (const [index, part] of mine.entries())
      expect(part.text).toBe(index % 20 === 0 ? tag.repeat(big) : tag + "-" + index)
  }
}, 120_000)
