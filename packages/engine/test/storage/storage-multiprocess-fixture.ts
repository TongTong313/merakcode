import { createInterface } from "node:readline"
import { Storage } from "../../src/storage/storage"

const key = JSON.parse(process.argv[2]) as string[]
const value = await Storage.read<{ id: string; revision: number; payload: string }>(key)
process.stdout.write("ready\n")
for await (const line of createInterface({ input: process.stdin })) {
  if (line !== "go") continue
  for (let revision = 1; revision <= 60; revision++) {
    if (revision % 2) await Storage.write(key, { ...value, revision })
    if (!(revision % 2))
      await Storage.update<typeof value>(key, (draft) => {
        draft.revision = revision
      })
  }
  break
}
// A piped stdin handle stays on the event loop after readline closes; without destroying it the process never exits
process.stdin.destroy()
