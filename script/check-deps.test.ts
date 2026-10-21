import { describe, expect, test } from "vitest"
import { violations } from "./check-deps"

const host = 'const { EngineHost } = await import("@merakcode/engine/host")\n'

describe("violations", () => {
  test("the desktop app may not import the engine at all", () => {
    const found = violations([
      {
        path: "apps/desktop/renderer/src/a.ts",
        text: 'import { x } from "./x"\nimport { Session } from "@merakcode/engine/session/index"\n',
      },
      { path: "apps/desktop/main/src/b.ts", text: host },
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

  test("every app except the CLI is bound, including apps added later", () => {
    const found = violations([
      { path: "apps/web/src/a.ts", text: 'import { Session } from "@merakcode/engine/session/index"\n' },
      { path: "apps/web/package.json", text: '{ "dependencies": { "@merakcode/engine": "workspace:*" } }\n' },
    ])
    expect(found.map((item) => [item.rule, item.file])).toEqual([
      ["engine-only-from-cli", "apps/web/src/a.ts"],
      ["engine-only-from-cli", "apps/web/package.json"],
    ])
  })

  test("the CLI reaches the engine only through @merakcode/engine/host, and only from the host commands", () => {
    const internal = 'import { Server } from "@merakcode/engine/server/server"\n'
    const found = violations([
      { path: "apps/cli/src/cli/cmd/serve.ts", text: host },
      { path: "apps/cli/src/cli/cmd/generate.ts", text: host },
      { path: "apps/cli/src/cli/cmd/debug/host.ts", text: host },
      { path: "apps/cli/src/cli/cmd/debug/lsp.ts", text: host },
      { path: "apps/cli/src/cli/cmd/acp.ts", text: host },
      { path: "apps/cli/src/cli/cmd/run.handler.ts", text: internal },
      { path: "apps/cli/test/agent/agent.test.ts", text: 'import { Agent } from "@merakcode/engine/agent/agent"\n' },
      { path: "apps/cli/script/schema.ts", text: 'import { Config } from "@merakcode/engine/config/config"\n' },
    ])
    expect(found.map((item) => [item.rule, item.file])).toEqual([
      ["client-through-sdk", "apps/cli/src/cli/cmd/debug/lsp.ts"],
      ["client-through-sdk", "apps/cli/src/cli/cmd/acp.ts"],
      ["apps-engine-host-only", "apps/cli/src/cli/cmd/run.handler.ts"],
      ["client-through-sdk", "apps/cli/src/cli/cmd/run.handler.ts"],
      ["apps-engine-host-only", "apps/cli/test/agent/agent.test.ts"],
      ["apps-engine-host-only", "apps/cli/script/schema.ts"],
    ])
  })

  test("only the entry and the debug commands import a host file, so no client runs the engine in its process", () => {
    const found = violations([
      {
        path: "apps/cli/src/index.ts",
        text: 'import { ServeCommand } from "./cli/cmd/serve"\nimport { DebugCommand } from "./cli/cmd/debug"\n',
      },
      { path: "apps/cli/src/cli/cmd/serve.ts", text: host },
      { path: "apps/cli/src/cli/cmd/debug/index.ts", text: 'import { LSPCommand } from "./lsp"\n' },
      { path: "apps/cli/src/cli/cmd/debug/lsp.ts", text: 'import { host } from "./host"\n' },
      { path: "apps/cli/src/cli/cmd/debug/host.ts", text: host },
      { path: "apps/cli/src/cli/cmd/mcp.ts", text: 'import { ServeCommand } from "./serve"\n' },
      { path: "apps/cli/src/cli/cmd/run.ts", text: 'import { host } from "./debug/host.js"\n' },
    ])
    expect(found.map((item) => [item.rule, item.file, item.target])).toEqual([
      ["hosts-only-from-entry", "apps/cli/src/cli/cmd/mcp.ts", "./serve"],
      ["hosts-only-from-entry", "apps/cli/src/cli/cmd/run.ts", "./debug/host.js"],
    ])
  })

  test("nothing outside the CLI imports it, so its host commands cannot be borrowed", () => {
    const found = violations([
      { path: "apps/desktop/main/src/a.ts", text: 'import { ServeCommand } from "../../../cli/src/cli/cmd/serve"\n' },
      { path: "apps/cli/src/cli/cmd/serve.ts", text: host },
      { path: "packages/sdk/js/src/b.ts", text: 'import { RunCommand } from "merakcode/src/cli/cmd/run"\n' },
    ])
    expect(found.map((item) => [item.rule, item.file])).toEqual([
      ["cli-only-from-cli", "apps/desktop/main/src/a.ts"],
      ["cli-only-from-cli", "packages/sdk/js/src/b.ts"],
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

  test("template literals, createRequire, resolve and type imports count; comments do not", () => {
    const found = violations([
      {
        path: "apps/desktop/main/src/a.ts",
        text: [
          'import { createRequire } from "node:module"',
          '// import("@merakcode/engine/host") is what the desktop app must never do',
          "const a = await import(`@merakcode/engine/host`)",
          'const b = createRequire(import.meta.url)("@merakcode/engine/host")',
          'const c = require.resolve("@merakcode/engine/host")',
          'const d = import.meta.resolve("@merakcode/engine/host")',
          'type E = import("@merakcode/engine/host").EngineHost',
        ].join("\n"),
      },
    ])
    expect(found.map((item) => [item.rule, item.line])).toEqual([
      ["engine-only-from-cli", 3],
      ["engine-only-from-cli", 4],
      ["engine-only-from-cli", 5],
      ["engine-only-from-cli", 6],
      ["engine-only-from-cli", 7],
    ])
  })

  test("package.json aliases, paths and import maps count as what they install", () => {
    const found = violations([
      {
        path: "apps/desktop/main/package.json",
        text: [
          "{",
          '  "imports": { "#engine/*": "@merakcode/engine/*" },',
          '  "dependencies": {',
          '    "@merakcode/sdk": "workspace:*",',
          '    "core": "workspace:@merakcode/engine@*",',
          '    "published": "npm:@merakcode/engine@^1.0.0",',
          '    "local": "link:../../../packages/engine"',
          "  }",
          "}",
        ].join("\n"),
      },
    ])
    expect(found.map((item) => [item.line, item.target])).toEqual([
      [2, "@merakcode/engine/*"],
      [5, "@merakcode/engine"],
      [6, "@merakcode/engine"],
      [7, "../../../packages/engine"],
    ])
  })

  test("shipped code may not load a module whose name is computed at runtime", () => {
    const computed = [
      'const name = "@merakcode/" + "engine/host"',
      "await import(name)",
      "require(name)",
      "await import(`./locales/${name}.json`)",
    ].join("\n")
    const found = violations([
      { path: "apps/desktop/main/src/a.ts", text: computed },
      { path: "apps/desktop/main/e2e/fixture.ts", text: computed },
      { path: "packages/util/src/a.test.ts", text: computed },
    ])
    expect(found.map((item) => [item.file, item.line, item.target])).toEqual([
      ["apps/desktop/main/src/a.ts", 2, "computed import()"],
      ["apps/desktop/main/src/a.ts", 3, "computed require()"],
      ["apps/desktop/main/src/a.ts", 4, "computed import()"],
    ])
  })

  test("clients send requests to the engine through the SDK's typed client", () => {
    const found = violations([
      {
        path: "apps/cli/src/cli/cmd/a.ts",
        text: [
          'import http from "node:http"',
          'const runs = await sdk.fetch(new URL("/workflow", sdk.baseUrl))',
          'const logs = await fetch("http://127.0.0.1:4096/log")',
          "void refetch()",
          "const listed = await sdk.client.workflow.list({ sessionID })",
        ].join("\n"),
      },
      { path: "apps/desktop/renderer/src/a.tsx", text: 'const events = new EventSource("/event")\n' },
      { path: "apps/cli/src/cli/installation/release.ts", text: 'const res = await fetch("https://github.com")\n' },
      { path: "packages/sdk/js/src/a.ts", text: "const res = await fetch(request)\n" },
    ])
    expect(found.map((item) => [item.file, item.line, item.target])).toEqual([
      ["apps/cli/src/cli/cmd/a.ts", 1, "node:http"],
      ["apps/cli/src/cli/cmd/a.ts", 2, "fetch()"],
      ["apps/cli/src/cli/cmd/a.ts", 3, "fetch()"],
      ["apps/desktop/renderer/src/a.tsx", 1, "new EventSource()"],
    ])
  })

  test("clients read the engine's config and data only in the listed files", () => {
    const found = violations([
      {
        path: "apps/desktop/main/src/a.ts",
        text: [
          'import { Paths, globalConfigFile } from "@merakcode/util/paths"',
          'import * as paths from "@merakcode/util/paths"',
          'import { peekGlobalConfig } from "@merakcode/util/config-peek"',
          'const sessions = path.join(Paths.data, "storage")',
          "const { worktrees, cache } = Paths",
          "const config = paths.globalConfigFile()",
          'app.setPath("sessionData", Paths.cache)',
        ].join("\n"),
      },
      { path: "apps/cli/src/cli/i18n.ts", text: 'import { peekGlobalConfig } from "@merakcode/util/config-peek"\n' },
      { path: "apps/cli/src/cli/upgrade.ts", text: 'import { peekGlobalConfig } from "@merakcode/util/config-peek"\n' },
      { path: "apps/cli/src/cli/doctor.ts", text: 'import { globalConfigFile } from "@merakcode/util/paths"\n' },
    ])
    expect(found.map((item) => [item.file, item.line, item.target])).toEqual([
      ["apps/desktop/main/src/a.ts", 1, "@merakcode/util/paths#globalConfigFile"],
      ["apps/desktop/main/src/a.ts", 3, "@merakcode/util/config-peek"],
      ["apps/desktop/main/src/a.ts", 4, "@merakcode/util/paths#Paths.data"],
      ["apps/desktop/main/src/a.ts", 5, "@merakcode/util/paths#Paths.worktrees"],
      ["apps/desktop/main/src/a.ts", 6, "@merakcode/util/paths#globalConfigFile"],
      ["apps/cli/src/cli/upgrade.ts", 1, "@merakcode/util/config-peek"],
    ])
  })
})
