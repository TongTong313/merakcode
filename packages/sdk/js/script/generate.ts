import { mkdir } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { createClient } from "@hey-api/openapi-ts"
import { format, resolveConfig } from "prettier"
import { Filesystem } from "@merakcode/util/filesystem"
import { Glob } from "@merakcode/util/glob"
import { Process } from "@merakcode/util/process"
import { Runtime } from "@merakcode/util/runtime"

const root = resolve(import.meta.dirname, "../../../..")
const outputIndex = process.argv.indexOf("--output-root")
const outputValue = outputIndex === -1 ? undefined : process.argv[outputIndex + 1]
if (outputIndex !== -1 && (!outputValue || outputValue.startsWith("--"))) {
  throw new Error("--output-root requires a directory")
}
const outputRoot = outputValue ? resolve(outputValue) : root
const target = {
  openapi: join(outputRoot, "packages/sdk/openapi.json"),
  output: join(outputRoot, "packages/sdk/js/src/client/gen"),
  tsconfig: join(root, "packages/sdk/js/tsconfig.json"),
}

// The CLI's generate subcommand prints the OpenAPI spec; run the CLI source with the current runtime and its
// arguments (the source loader)
const engine = Process.spawn([process.execPath, ...Runtime.execArgv(), "./src/index.ts", "generate"], {
  cwd: join(root, "apps/cli"),
  stdout: "pipe",
  stderr: "inherit",
})
const openapi = await new Response(engine.stdout).text()
if ((await engine.exited) !== 0) throw new Error("Failed to generate OpenAPI")
JSON.parse(openapi)
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
