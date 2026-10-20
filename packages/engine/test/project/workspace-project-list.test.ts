import { afterEach, describe, expect, test } from "vitest"
import { Instance } from "@merakcode/engine/project/instance"
import { Project } from "@merakcode/engine/project/project"
import { Log } from "@merakcode/log/logger"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

describe("project.list exposes the workspace kind", () => {
  afterEach(async () => {
    await Instance.disposeAll().catch(() => undefined)
  })

  test("after multi-root provide, list includes kind=workspace with folders", async () => {
    await using a = await tmpdir({ git: true })
    await using b = await tmpdir({ git: true })
    const id = await Instance.provide({
      directory: a.path,
      workspace: {
        folders: [{ path: a.path }, { path: b.path }],
      },
      fn: () => Instance.project.id,
    })

    const listed = await Project.list()
    const ws = listed.find((p) => p.id === id)
    expect(ws).toBeDefined()
    expect(ws!.kind).toBe("workspace")
    expect(ws!.folders?.length).toBe(2)
  })
})
