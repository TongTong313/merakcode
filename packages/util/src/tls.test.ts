// Outbound HTTPS uses Node's default trust chain (public roots + NODE_EXTRA_CA_CERTS) and always validates, even
// with a global NODE_TLS_REJECT_UNAUTHORIZED=0. Tested against a local self-signed HTTPS server, not by inspecting
// the options.
import { afterEach, describe, expect, test } from "vitest"
import { execFile } from "node:child_process"
import { readFileSync } from "node:fs"
import https from "node:https"
import type { AddressInfo } from "node:net"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { withTrustedTls } from "./tls"

// Self-signed certificate for 127.0.0.1 only; its key is public and protects nothing. Regenerate with:
// openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout key.pem -out cert.pem -days 36500 -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
const fixture = path.resolve(import.meta.dirname, "fixture/tls")
const cert = readFileSync(path.join(fixture, "cert.pem"), "utf8")
const key = readFileSync(path.join(fixture, "key.pem"), "utf8")
const register = path.resolve(import.meta.dirname, "../../../script/node/register.mjs")

const saved = process.env.NODE_TLS_REJECT_UNAUTHORIZED
afterEach(() => {
  if (saved === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
  else process.env.NODE_TLS_REJECT_UNAUTHORIZED = saved
})

async function serve() {
  const server = https.createServer({ cert, key }, (req, res) => res.end(req.headers["x-test"] ?? "ok"))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    url: `https://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    [Symbol.asyncDispose]: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** Fetches url with withTrustedTls in a separate Node process (NODE_EXTRA_CA_CERTS is only read at startup) */
async function fetchInChild(url: string, env: Record<string, string>) {
  const code = `const { withTrustedTls } = await import(${JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, "tls.ts")).href)})
const res = await fetch(${JSON.stringify(url)}, withTrustedTls({ headers: { "x-test": "child" } }))
process.stdout.write(await res.text())`
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--import", pathToFileURL(register).href, "--input-type=module", "-e", code],
    { env: { ...process.env, ...env } },
  )
  return stdout
}

describe("fetch trust chain", () => {
  test("fails when the certificate is not trusted", async () => {
    await using server = await serve()
    await expect(fetch(server.url, withTrustedTls())).rejects.toThrow()
  })

  // Behind a corporate proxy, users follow the Node convention of adding its root to NODE_EXTRA_CA_CERTS
  test("trusts certificates in NODE_EXTRA_CA_CERTS and keeps the caller's other options", async () => {
    await using server = await serve()
    expect(await fetchInChild(server.url, { NODE_EXTRA_CA_CERTS: path.join(fixture, "cert.pem") })).toBe("child")
  })

  // With NODE_TLS_REJECT_UNAUTHORIZED=0, a man-in-the-middle could impersonate the update server or model catalog
  test("still validates when the environment disables certificate checks", async () => {
    await using server = await serve()
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"
    await expect(fetch(server.url, withTrustedTls())).rejects.toThrow()
  })
})
