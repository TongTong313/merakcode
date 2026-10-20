/**
 * Syncs the author and repository from packages/util/src/project.ts into LICENSE and every package.json.
 *
 * Usage: pnpm sync:project
 */
import path from "node:path"
import { Project } from "../packages/util/src/project"
import { Filesystem } from "@merakcode/util/filesystem"
import { Glob } from "@merakcode/util/glob"

const MIT = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`

const NOTICE = `
---

Parts of this software are derived from other open-source projects, most notably
opencode (https://github.com/anomalyco/opencode), Copyright (c) 2025 opencode, MIT License.
See THIRD_PARTY_NOTICES.md for their copyright notices and licenses.
`

export function license(input: { author: string; since: number; year: number }) {
  const years = input.year > input.since ? `${input.since}-${input.year}` : `${input.since}`
  return `MIT License\n\nCopyright (c) ${years} ${input.author}\n\n${MIT}${NOTICE}`
}

type Pkg = Record<string, unknown>

export function packageMeta(pkg: Pkg, input: { repository: string; directory: string }) {
  const home = `https://github.com/${input.repository}`
  return {
    ...pkg,
    repository: {
      type: "git",
      url: `git+${home}.git`,
      ...(input.directory ? { directory: input.directory } : {}),
    },
    homepage: home,
    bugs: { url: `${home}/issues` },
  }
}

/** Moves GitHub links in docs (github.com/<repo>, raw.githubusercontent.com/<repo>) from the old repo to the new one */
export function docLinks(text: string, input: { from: string; to: string }) {
  const from = input.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return text.replace(
    new RegExp(`(github\\.com|raw\\.githubusercontent\\.com)/${from}(?=[/"'\`)\\s]|$)`, "g"),
    `$1/${input.to}`,
  )
}

/** Docs such as README are shown as is on GitHub without a build step, so their links must be real URLs */
const DOCS = ["README.md", "README.en.md", "CONTRIBUTING.md"]

async function main() {
  const root = path.resolve(import.meta.dirname, "..")
  await Filesystem.write(
    path.join(root, "LICENSE"),
    license({ author: Project.AUTHOR, since: Project.SINCE, year: new Date().getFullYear() }),
  )

  // The previously synced repository is in the root package.json; old doc links are replaced based on it
  const previous = (
    (await Filesystem.readJson(path.join(root, "package.json"))) as { repository?: { url?: string } }
  ).repository?.url?.match(/github\.com\/(.+?)\.git$/)?.[1]
  if (previous && previous !== Project.REPOSITORY) {
    for (const doc of DOCS) {
      const full = path.join(root, doc)
      const text = await Filesystem.readText(full)
      const next = docLinks(text, { from: previous, to: Project.REPOSITORY })
      if (next !== text) await Filesystem.write(full, next)
    }
  }

  const files = ["package.json", ...new Glob("{apps,packages}/**/package.json").scanSync({ cwd: root })]
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !file.includes("node_modules/"))
  for (const file of files) {
    const full = path.join(root, file)
    const pkg = (await Filesystem.readJson(full)) as Pkg
    const directory = path.posix.dirname(file) === "." ? "" : path.posix.dirname(file)
    const next = packageMeta(pkg, { repository: Project.REPOSITORY, directory })
    const text = JSON.stringify(next, null, 2) + "\n"
    if (text !== (await Filesystem.readText(full))) await Filesystem.write(full, text)
  }
  console.log(`LICENSE + ${files.length} package.json synced (${Project.REPOSITORY}, ${Project.AUTHOR})`)
}

if (import.meta.main) await main()
