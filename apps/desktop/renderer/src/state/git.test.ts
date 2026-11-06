import { execFileSync } from "node:child_process"
import { createServer, request } from "node:http"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { startEngine } from "@merakcode/sdk/process"
import { expect, test } from "vitest"
import { engine, sandbox } from "../../../../../packages/sdk/js/test/fixture/engine"
import { gitState, refreshBranches, resolveDirectory, switchBranch } from "./git"

for (const scenario of ["same", "alias", "failure", "worktree"])
  test(
    scenario === "failure"
      ? "a failed branch refresh remains visible after its subdirectory is resolved independently"
      : scenario === "worktree"
        ? "refreshing another worktree does not wait for a pending branch switch"
        : scenario === "alias"
          ? "a root branch refresh cannot cancel a requested checkout from an unresolved subdirectory"
          : "a background branch refresh cannot cancel a requested checkout",
    async () => {
      const alias = scenario === "alias" || scenario === "failure"
      await using env = await sandbox("http://127.0.0.1:1/v1")
      const git = (...args: string[]) =>
        execFileSync("git", ["-C", env.project, ...args], { encoding: "utf8", windowsHide: true }).trim()
      git(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "initial",
      )
      git("branch", "feature")
      const directory = alias ? path.join(env.project, "sub") : env.project
      if (alias) await mkdir(directory)
      const other = scenario === "worktree" ? path.join(env.root, "worktree") : env.project
      if (scenario === "worktree") git("worktree", "add", "--quiet", "--detach", other)
      const backend = await startEngine({ cwd: env.project, executablePath: engine, env: env.env })
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      let hold = false
      const proxy = createServer(async (incoming, outgoing) => {
        if (hold && incoming.url?.startsWith("/vcs/branch-options")) {
          hold = false
          entered.resolve()
          await release.promise
          if (scenario === "failure") {
            outgoing.writeHead(503, { "content-type": "application/json" })
            outgoing.end(JSON.stringify({ message: "Branch lookup unavailable" }))
            return
          }
        }
        const target = request(
          new URL(incoming.url ?? "/", backend.url),
          { method: incoming.method, headers: { ...incoming.headers, ...backend.headers } },
          (response) => {
            outgoing.writeHead(response.statusCode ?? 500, response.headers)
            response.pipe(outgoing)
          },
        )
        target.on("error", (error) => outgoing.destroy(error))
        incoming.pipe(target)
      })
      await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
      const address = proxy.address()
      if (!address || typeof address === "string") throw new Error("Branch transport did not listen")
      location.href = `http://127.0.0.1:${address.port}`
      try {
        await refreshBranches(env.project)
        hold = true
        const switching = scenario === "failure" ? refreshBranches(directory) : switchBranch(directory, "feature")
        await entered.promise
        if (scenario === "failure") {
          await resolveDirectory(directory)
          release.resolve()
          expect(await switching).toBeUndefined()
          expect(gitState(directory)).toMatchObject({ loading: false, error: expect.any(Error) })
          expect(await refreshBranches(directory)).toMatchObject({ directory: env.project })
          expect(gitState(directory)?.error).toBeUndefined()
          return
        }
        const background = refreshBranches(other)
        if (alias || scenario === "worktree") expect(await background).toMatchObject({ directory: other })
        // Both callers overlap while the real transport holds the checkout's validation request.
        release.resolve()
        await background
        expect(await switching).toMatchObject({ branch: "feature" })
        expect(git("branch", "--show-current")).toBe("feature")
        if (scenario === "worktree")
          expect(execFileSync("git", ["-C", other, "branch", "--show-current"], { encoding: "utf8" }).trim()).toBe("")
      } finally {
        release.resolve()
        proxy.closeAllConnections()
        await new Promise<void>((resolve) => proxy.close(() => resolve()))
        await backend.close()
      }
    },
  )
