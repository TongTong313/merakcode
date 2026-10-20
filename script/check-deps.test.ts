import { describe, expect, test } from "vitest"
import { violations } from "./check-deps"

describe("violations", () => {
  test("the desktop app may not import the engine at all", () => {
    const found = violations([
      {
        path: "apps/desktop/renderer/src/a.ts",
        text: 'import { x } from "./x"\nimport { Session } from "@merakcode/engine/session/index"\n',
      },
      { path: "apps/desktop/main/src/b.ts", text: 'const host = await import("@merakcode/engine/host")\n' },
    ])
    expect(found.map((item) => [item.rule, item.file, item.line])).toEqual([
      ["engine-only-from-cli", "apps/desktop/renderer/src/a.ts", 2],
      ["engine-only-from-cli", "apps/desktop/main/src/b.ts", 1],
    ])
  })

  test("reaching into packages/engine by relative path also counts; the engine's own imports do not", () => {
    const found = violations([
      { path: "packages/client-core/src/a.ts", text: 'import { Log } from "../../engine/src/util/log"\n' },
      { path: "packages/engine/src/b.ts", text: 'import { Log } from "./util/log"\n' },
    ])
    expect(found).toEqual([
      {
        rule: "engine-only-from-cli",
        file: "packages/client-core/src/a.ts",
        line: 1,
        target: "../../engine/src/util/log",
      },
    ])
  })

  test("the CLI reaches the engine only through @merakcode/engine/host, and only from the host commands", () => {
    const host = 'const { EngineHost } = await import("@merakcode/engine/host")\n'
    const internal = 'import { Server } from "@merakcode/engine/server/server"\n'
    const found = violations([
      { path: "apps/cli/src/cli/cmd/serve.ts", text: host },
      { path: "apps/cli/src/cli/cmd/generate.ts", text: host },
      { path: "apps/cli/src/cli/cmd/debug/lsp.ts", text: host },
      { path: "apps/cli/src/cli/cmd/debug/config.ts", text: internal },
      { path: "apps/cli/src/cli/cmd/tui/app.tsx", text: host },
      { path: "apps/cli/src/cli/cmd/run.handler.ts", text: internal },
      { path: "apps/cli/test/agent/agent.test.ts", text: 'import { Agent } from "@merakcode/engine/agent/agent"\n' },
      { path: "apps/cli/script/schema.ts", text: 'import { Config } from "@merakcode/engine/config/config"\n' },
    ])
    expect(found.map((item) => [item.rule, item.file])).toEqual([
      ["apps-engine-host-only", "apps/cli/src/cli/cmd/debug/config.ts"],
      ["client-through-sdk", "apps/cli/src/cli/cmd/tui/app.tsx"],
      ["apps-engine-host-only", "apps/cli/src/cli/cmd/run.handler.ts"],
      ["client-through-sdk", "apps/cli/src/cli/cmd/run.handler.ts"],
      ["apps-engine-host-only", "apps/cli/test/agent/agent.test.ts"],
      ["apps-engine-host-only", "apps/cli/script/schema.ts"],
    ])
  })

  test("modules loaded eagerly from the CLI entry may not import the engine, even through the host entry", () => {
    const found = violations([
      {
        path: "apps/cli/src/index.ts",
        text: 'import "./product-version"\nimport { ServeCommand } from "./cli/cmd/serve"\nimport { Debug } from "./cli/debug"\n',
      },
      // Importing package.json only reads data; its dependencies are not loaded
      { path: "apps/cli/src/product-version.ts", text: 'import pkg from "../package.json"\n' },
      { path: "apps/cli/package.json", text: '{ "dependencies": { "@merakcode/engine": "workspace:*" } }\n' },
      {
        path: "apps/cli/src/cli/cmd/serve.ts",
        text: 'export const ServeCommand = { handler: async () => (await import("@merakcode/engine/host")).EngineHost }\n',
      },
      { path: "apps/cli/src/cli/debug.ts", text: 'import { EngineHost } from "@merakcode/engine/host"\n' },
    ])
    expect(found.map((item) => [item.rule, item.file])).toEqual([
      ["client-through-sdk", "apps/cli/src/cli/debug.ts"],
      ["cli-entry-without-engine", "apps/cli/src/cli/debug.ts"],
    ])
  })

  test("require, side-effect imports and package.json entries count; a string mentioning the name does not", () => {
    const found = violations([
      {
        path: "apps/desktop/main/src/a.ts",
        text: [
          'const name = "@merakcode/engine"',
          'const engine = require("@merakcode/engine/server/server")',
          'import "@merakcode/engine/util/log"',
        ].join("\n"),
      },
      {
        path: "apps/desktop/main/package.json",
        text: JSON.stringify({
          dependencies: { "@merakcode/util": "workspace:*", "@merakcode/engine": "workspace:*" },
        }),
      },
    ])
    expect(found.map((item) => [item.file, item.target])).toEqual([
      ["apps/desktop/main/src/a.ts", "@merakcode/engine/server/server"],
      ["apps/desktop/main/src/a.ts", "@merakcode/engine/util/log"],
      ["apps/desktop/main/package.json", "@merakcode/engine"],
    ])
  })
})
