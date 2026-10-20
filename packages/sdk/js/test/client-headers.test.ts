import { describe, expect, test } from "vitest"
import { createMerakCodeClient } from "../src/client/index.js"

/**
 * Client-level request headers.
 *
 * The type accepts RequestInit["headers"]: a plain object, Headers or an array of tuples are all valid. When the
 * factory adds the directory / workspace headers it must not drop the caller's own headers (typically
 * authorization). Covers every form × every combination of extra headers, reading the sent headers from a capturing
 * fetch without touching the network.
 */

const ORIGINAL = { authorization: "Bearer fixture", "x-fixture": "retained" }
const FOLDERS = [{ name: "a", path: "/repo/a" }]

const inputs: Record<string, () => HeadersInit> = {
  object: () => ({ ...ORIGINAL }),
  Headers: () => new Headers(ORIGINAL),
  tuple: () => [
    ["authorization", "Bearer fixture"],
    ["x-fixture", "retained"],
  ],
}

const extras: Record<string, { directory?: string; workspaceFolders?: typeof FOLDERS }> = {
  none: {},
  directory: { directory: "/repo/work" },
  workspaceFolders: { workspaceFolders: FOLDERS },
  all: { directory: "/repo/work", workspaceFolders: FOLDERS },
}

async function sent(config: Parameters<typeof createMerakCodeClient>[0]) {
  let captured: Headers | undefined
  const client = createMerakCodeClient({
    baseUrl: "http://merakcode.invalid",
    ...config,
    fetch: (async (request: Request) => {
      captured = request.headers
      return Response.json({ healthy: true, version: "0.0.0" })
    }) as typeof fetch,
  })
  await client.global.health()
  if (!captured) throw new Error("request was not sent")
  return captured
}

describe("all three valid forms of client-level headers", () => {
  for (const [input, headers] of Object.entries(inputs)) {
    for (const [extra, fields] of Object.entries(extras)) {
      test(`${input} with extra ${extra}: keeps all original headers and adds the configured ones`, async () => {
        const result = await sent({ headers: headers(), ...fields })
        expect(result.get("authorization")).toBe("Bearer fixture")
        expect(result.get("x-fixture")).toBe("retained")
        expect(result.get("x-merakcode-directory")).toBe(fields.directory ?? null)
        const folders = result.get("x-merakcode-workspace-folders")
        expect(folders === null ? undefined : JSON.parse(decodeURIComponent(folders))).toEqual(fields.workspaceFolders)
      })
    }
  }

  test("Headers form with a non-ASCII directory: URI-encodes it and keeps the original headers", async () => {
    const result = await sent({ headers: new Headers(ORIGINAL), directory: "/repo/中文" })
    expect(result.get("x-merakcode-directory")).toBe("%2Frepo%2F%E4%B8%AD%E6%96%87")
    expect(result.get("authorization")).toBe("Bearer fixture")
  })

  test("clientRun is sent as x-merakcode-client-run so engine logs can be matched to the client run", async () => {
    const result = await sent({ headers: new Headers(ORIGINAL), clientRun: "run-42" })
    expect(result.get("x-merakcode-client-run")).toBe("run-42")
    expect((await sent({ headers: new Headers(ORIGINAL) })).has("x-merakcode-client-run")).toBe(false)
  })

  test("the directory option wins over a directory header passed by the caller", async () => {
    const result = await sent({
      headers: new Headers({ ...ORIGINAL, "X-Merak-Code-Directory": "/stale" }),
      directory: "/repo/work",
    })
    expect(result.get("x-merakcode-directory")).toBe("/repo/work")
  })
})

/**
 * Plain objects keep the generated client's extended semantics, so they cannot simply be passed through
 * new Headers. These cases guard against converting objects to Headers as well.
 */
describe("plain object headers keep their extended semantics", () => {
  test("array values are sent as multiple values", async () => {
    const result = await sent({ headers: { ...ORIGINAL, "x-multi": ["a", "b"] }, directory: "/repo/work" })
    expect(result.get("x-multi")).toBe("a, b")
  })

  test("headers with an undefined value are not sent", async () => {
    const result = await sent({ headers: { ...ORIGINAL, "x-skip": undefined }, directory: "/repo/work" })
    expect(result.has("x-skip")).toBe(false)
    expect(result.get("authorization")).toBe("Bearer fixture")
  })

  test("headers with a null value are not sent", async () => {
    const result = await sent({ headers: { ...ORIGINAL, "x-drop": null }, directory: "/repo/work" })
    expect(result.has("x-drop")).toBe(false)
    expect(result.get("authorization")).toBe("Bearer fixture")
  })
})
