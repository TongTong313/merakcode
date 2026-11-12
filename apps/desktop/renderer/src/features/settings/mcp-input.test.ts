import { expect, test } from "vitest"
import { mcpDefinition, pairs, words } from "./mcp-input"

test("a command keeps the text inside double quotes as one word", () => {
  expect(words(`node "C:\\Program Files\\server.mjs" --port 80`)).toEqual([
    "node",
    "C:\\Program Files\\server.mjs",
    "--port",
    "80",
  ])
})

test("environment lines accept KEY=VALUE and Name: value and skip lines without a key", () => {
  expect(pairs("A=1\nAuthorization: Bearer x=y\n=nokey\n\nnothing")).toEqual({ A: "1", Authorization: "Bearer x=y" })
})

test("a command becomes a local server with the program and its arguments split, and lines become its environment", () => {
  expect(mcpDefinition(`node "a b.mjs" --x`, "TOKEN=1")).toEqual({
    type: "local",
    command: "node",
    args: ["a b.mjs", "--x"],
    env: { TOKEN: "1" },
  })
})

test("an address becomes a remote server and the extra lines become headers", () => {
  expect(mcpDefinition("https://example.com/mcp", "Authorization: Bearer t")).toEqual({
    type: "remote",
    url: "https://example.com/mcp",
    headers: { Authorization: "Bearer t" },
  })
})

test("no extra lines means no environment and no headers", () => {
  expect(mcpDefinition("node s.mjs", "")).toEqual({ type: "local", command: "node", args: ["s.mjs"] })
  expect(mcpDefinition("http://127.0.0.1:1/mcp", "")).toEqual({ type: "remote", url: "http://127.0.0.1:1/mcp" })
})
