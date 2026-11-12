import { writeFile } from "node:fs/promises"
import path from "node:path"
import { afterAll, beforeAll, expect, test } from "vitest"
import { engineFixture } from "../../test/engine"
import { persistent } from "../../lib/persistence"
import { client } from "../../state/client"
import { refreshBranches, unsavedReason } from "../../state/git"
import { restoreReviewProtection } from "./protection"

let env: Awaited<ReturnType<typeof engineFixture>>
beforeAll(async () => {
  env = await engineFixture()
  location.href = env.url
  await writeFile(path.join(env.project, "note.txt"), "note\n")
  await env.git("add", ".")
  await env.git("commit", "-m", "initial")
}, 120_000)
afterAll(async () => {
  try {
    await (await client()).close()
  } finally {
    await env?.close()
  }
})

const encode = (value: string) => Buffer.from(value).toString("base64url")
/** A saved review panel of a sleeping conversation, with feedback pointing into a folder */
const sleepingReview = (owner: string, directory: string) =>
  persistent.set(
    `panels-${encode(owner)}`,
    "layout",
    JSON.stringify({
      version: 1,
      directory,
      tabs: [
        {
          id: "review-tab",
          kind: "review",
          view: {
            comments: {
              [owner]: [
                {
                  key: "k",
                  directory,
                  sessionID: owner,
                  scope: "turn",
                  file: "a.txt",
                  version: "v",
                  side: "new",
                  rows: [],
                },
              ],
            },
          },
        },
      ],
    }),
  )

test("saved feedback in a folder on a volume that is not there does not keep other folders from loading their branches", async () => {
  const offline = path.join(env.project, "..", "volume-that-is-gone", "old")
  await sleepingReview("offline-owner", offline)
  const options = await refreshBranches(env.project)
  expect(options?.branches.map((branch) => branch.name)).toContain("main")
  await restoreReviewProtection(env.project)
  expect(unsavedReason(env.project)).toBeUndefined()
})

test("saved feedback in a folder that is the same checkout blocks switching its branch", async () => {
  await sleepingReview("same-owner", env.project)
  await restoreReviewProtection(env.project)
  expect(unsavedReason(env.project)).toBeTruthy()
})
