import { expect, test } from "vitest"
import { mentioned, registered } from "./check-docs"

test("finds merak and pnpm dev commands only inside code", () => {
  const markdown = [
    "Run merak doctor in prose is not checked.",
    "Use `merak doctor` and `merak sandbox setup`, or `merak upgrade --check`.",
    "```sh",
    'merak run "fix it"',
    "pnpm dev serve --port 4096",
    "merak --version",
    "const merak = await createMerakCode()",
    "await merak.close()",
    "```",
    "```text",
    "apps/cli   the merak program and terminal UI",
    "```",
  ].join("\n")
  expect(mentioned(markdown)).toEqual([["doctor"], ["sandbox", "setup"], ["upgrade"], ["run"], ["serve"]])
})

test("reads command names and aliases from yargs help", () => {
  const help = [
    "Commands:",
    "  merak completion          generate completion script",
    "  merak [project]           start MerakCode TUI                              [default]",
    "  merak upgrade [target]    Check for updates and upgrade MerakCode to the latest version",
    "                                                                     [aliases: update]",
    "  merak plugin              manage plugins                  [aliases: plugins, plug]",
    "  merak sandbox status      sandbox status",
    "",
    "Options:",
    "  -h, --help  Show help",
  ].join("\n")
  expect(registered(help)).toEqual(["completion", "upgrade", "update", "plugin", "plugins", "plug", "status"])
})
