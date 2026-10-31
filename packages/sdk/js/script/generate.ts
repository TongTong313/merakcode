import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { createClient } from "@hey-api/openapi-ts"
import { format, resolveConfig } from "prettier"
import { Filesystem } from "@merakcode/util/filesystem"
import { Glob } from "@merakcode/util/glob"
import { Process } from "@merakcode/util/process"
import { Runtime } from "@merakcode/util/runtime"
import { canonical } from "./generated"

const root = resolve(import.meta.dirname, "../../../..")
const outputIndex = process.argv.indexOf("--output-root")
const outputValue = outputIndex === -1 ? undefined : process.argv[outputIndex + 1]
if (outputIndex !== -1 && (!outputValue || outputValue.startsWith("--"))) {
  throw new Error("--output-root requires a directory")
}
const check = process.argv.includes("--check")
if (check && outputValue) throw new Error("--check cannot be combined with --output-root")
const outputRoot = check
  ? await mkdtemp(join(tmpdir(), "merakcode-sdk-check-"))
  : outputValue
    ? resolve(outputValue)
    : root
const target = {
  openapi: join(outputRoot, "packages/sdk/openapi.json"),
  output: join(outputRoot, "packages/sdk/js/src/client/gen"),
  tsconfig: join(root, "packages/sdk/js/tsconfig.json"),
}

// The CLI's generate subcommand prints the OpenAPI spec; run the CLI source with the current runtime and its
// arguments (the source loader)
try {
  const engine = Process.spawn([process.execPath, ...Runtime.execArgv(), "./src/index.ts", "generate"], {
    cwd: join(root, "apps/cli"),
    stdout: "pipe",
    stderr: "inherit",
  })
  const output = await new Response(engine.stdout).text()
  if ((await engine.exited) !== 0) throw new Error("Failed to generate OpenAPI")
  const openapi = JSON.stringify(canonical(JSON.parse(output)))
  await mkdir(dirname(target.openapi), { recursive: true })
  await Filesystem.write(target.openapi, openapi)

  await createClient({
    input: target.openapi,
    output: {
      path: target.output,
      tsConfigPath: target.tsconfig,
      clean: true,
    },
    plugins: [
      {
        name: "@hey-api/typescript",
        exportFromIndex: false,
      },
      {
        name: "@hey-api/sdk",
        operations: { strategy: "single", containerName: "MerakCodeClient", methods: "instance" },
        exportFromIndex: false,
        auth: false,
        paramsStructure: "flat",
      },
      {
        name: "@hey-api/client-fetch",
        exportFromIndex: false,
        baseUrl: "http://localhost:4096",
      },
    ],
  })

  // Format with the repo's prettier config (root package.json); when writing elsewhere, pick the parser by the matching
  // path in the repo
  const config = await resolveConfig(join(root, "package.json"))
  const files = [target.openapi]
  for await (const file of new Glob("**/*").scan({ cwd: target.output, onlyFiles: true })) {
    files.push(join(target.output, file))
  }
  await Promise.all(
    files.map(async (file) =>
      Filesystem.write(
        file,
        await format(await Filesystem.readText(file), { ...config, filepath: join(root, relative(outputRoot, file)) }),
      ),
    ),
  )

  if (check) {
    const committed = join(root, "packages/sdk/js/src/client/gen")
    const names = async (directory: string) =>
      (await readdir(directory, { recursive: true, withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => relative(directory, join(entry.parentPath, entry.name)))
    const generated = await names(target.output)
    const existing = await names(committed)
    const paths = [
      "packages/sdk/openapi.json",
      ...new Set([...generated, ...existing].map((file) => join("packages/sdk/js/src/client/gen", file))),
    ].sort()
    const different: string[] = []
    for (const file of paths) {
      const content = (directory: string) =>
        readFile(join(directory, file), "utf8")
          .then((text) => text.replaceAll("\r\n", "\n"))
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined
            throw error
          })
      if ((await content(root)) !== (await content(outputRoot))) different.push(file)
    }
    if (different.length)
      throw new Error(`Generated SDK is out of date; run pnpm generate:sdk:\n${different.join("\n")}`)
  }
} finally {
  if (check) await rm(outputRoot, { recursive: true, force: true })
}
