import { createInterface } from "node:readline"
import { Storage } from "../../src/infra/storage/storage"

type Value = { id: string; revision: number; payload: string }

const key = JSON.parse(process.argv[2]) as string[]
// "increment": add 1 to the stored revision 40 times; otherwise write revisions 1 to 60, alternating write and update
const mode = process.argv[3]
const value = await Storage.read<Value>(key)
process.stdout.write("ready\n")
for await (const line of createInterface({ input: process.stdin })) {
  if (line !== "go") continue
  if (mode === "increment")
    for (let index = 0; index < 40; index++)
      await Storage.update<Value>(key, (draft) => {
        draft.revision++
      })
  if (mode !== "increment")
    for (let revision = 1; revision <= 60; revision++) {
      if (revision % 2) await Storage.write(key, { ...value, revision })
      if (!(revision % 2))
        await Storage.update<Value>(key, (draft) => {
          draft.revision = revision
        })
    }
  break
}
// A piped stdin handle stays on the event loop after readline closes; without destroying it the process never exits
process.stdin.destroy()
