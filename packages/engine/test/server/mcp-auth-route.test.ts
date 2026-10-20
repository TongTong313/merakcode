import { describe, expect, test } from "vitest"
import { Http } from "@merakcode/util/http"
import { Config } from "@merakcode/engine/config/config"
import { Server } from "@merakcode/engine/server/server"
import { tmpdir } from "../fixture/fixture"

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

/** Local fake OAuth server so start and callback never reach the network */
async function fakeOAuth() {
  const seen: string[] = []
  let origin = ""
  const server = await Http.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      const authorization = req.headers.get("authorization") ?? ""
      if (authorization) seen.push(authorization)
      if (url.pathname === "/mcp") {
        if (!authorization.startsWith("Bearer ")) {
          return new Response("unauthorized", {
            status: 401,
            headers: {
              "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
            },
          })
        }
        return json({ ok: true })
      }
      if (url.pathname === "/.well-known/oauth-protected-resource") {
        return json({
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
        })
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        })
      }
      if (url.pathname === "/register") return json({ client_id: "test-client", redirect_uris: [] })
      if (url.pathname === "/token") {
        return json({ access_token: "tok-1", token_type: "Bearer", expires_in: 3600 })
      }
      return new Response("not found", { status: 404 })
    },
  })
  origin = `http://127.0.0.1:${server.port}`
  return { url: `${origin}/mcp`, seen, stop: () => server.stop(true) }
}

async function auth(directory: string, name: string, init?: RequestInit) {
  const dir = encodeURIComponent(directory)
  return Server.App().request(`http://localhost/mcp/${name}/auth?directory=${dir}`, { method: "POST", ...init })
}

describe("mcp oauth routes", () => {
  test("starting auth for an unknown server returns 404", async () => {
    await using tmp = await tmpdir()
    const response = await auth(tmp.path, "missing")
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ name: "McpServerNotFoundError" })
  })

  test("a remote server with oauth: false refuses auth", async () => {
    await using tmp = await tmpdir({
      config: {
        mcp: { headerOnly: { type: "remote", url: "https://example.com/mcp", oauth: false, enabled: true } },
      },
    })
    const response = await auth(tmp.path, "headerOnly")
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ name: "McpUnsupportedOAuthError" })
  })

  test("a remote server that allows OAuth returns an authorization URL", async () => {
    const fake = await fakeOAuth()
    await using tmp = await tmpdir({
      config: { mcp: { remote: { type: "remote", url: fake.url, enabled: true } } },
    })
    process.env.MERAKCODE_MCP_OAUTH_DIR = tmp.path
    try {
      const response = await auth(tmp.path, "remote")
      expect(response.status).toBe(200)
      const body = (await response.json()) as { authorizationUrl: string; oauthState: string }
      expect(body.authorizationUrl).toContain("/authorize")
      expect(body.oauthState.length).toBeGreaterThan(0)
    } finally {
      await fake.stop()
      delete process.env.MERAKCODE_MCP_OAUTH_DIR
    }
  })

  test("a token from the auth code can be removed, and later connections no longer send it", async () => {
    const fake = await fakeOAuth()
    await using tmp = await tmpdir({
      config: { mcp: { remote: { type: "remote", url: fake.url, enabled: true, transport: "http" } } },
    })
    process.env.MERAKCODE_MCP_OAUTH_DIR = tmp.path
    const dir = encodeURIComponent(tmp.path)
    try {
      const started = await auth(tmp.path, "remote")
      expect(started.status).toBe(200)
      const callback = await Server.App().request(`http://localhost/mcp/remote/auth/callback?directory=${dir}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "from-browser" }),
      })
      expect(callback.status).toBe(200)
      fake.seen.length = 0
      await Server.App().request(`http://localhost/mcp/remote/connect?directory=${dir}`, { method: "POST" })
      expect(fake.seen.some((header) => header.includes("tok-1"))).toBe(true)
      const removed = await Server.App().request(`http://localhost/mcp/remote/auth?directory=${dir}`, {
        method: "DELETE",
      })
      expect(removed.status).toBe(200)
      expect(await removed.json()).toEqual({ success: true })
      fake.seen.length = 0
      await Server.App().request(`http://localhost/mcp/remote/connect?directory=${dir}`, { method: "POST" })
      expect(fake.seen.some((header) => header.includes("tok-1"))).toBe(false)
    } finally {
      await fake.stop()
      delete process.env.MERAKCODE_MCP_OAUTH_DIR
    }
  })

  test("auth wait picks up a browser callback that arrived first and connects with the exchanged token", async () => {
    const fake = await fakeOAuth()
    await using tmp = await tmpdir({
      config: { mcp: { remote: { type: "remote", url: fake.url, enabled: true, transport: "http" } } },
    })
    process.env.MERAKCODE_MCP_OAUTH_DIR = tmp.path
    const dir = encodeURIComponent(tmp.path)
    try {
      const started = (await auth(tmp.path, "remote").then((response) => response.json())) as {
        authorizationUrl: string
        oauthState: string
      }
      // The browser redirects back to the local callback after authorization
      const redirect = new URL(new URL(started.authorizationUrl).searchParams.get("redirect_uri")!)
      redirect.searchParams.set("code", "from-browser")
      redirect.searchParams.set("state", started.oauthState)
      expect((await fetch(redirect)).status).toBe(200)

      fake.seen.length = 0
      const waited = await Server.App().request(`http://localhost/mcp/remote/auth/wait?directory=${dir}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: started.oauthState }),
      })
      expect(waited.status).toBe(200)
      // The fake server is not real MCP so the connection fails, but it was attempted with the new token
      expect(fake.seen.some((header) => header.includes("tok-1"))).toBe(true)
    } finally {
      await fake.stop()
      delete process.env.MERAKCODE_MCP_OAUTH_DIR
    }
  })

  test("a remote MCP config with a receipt fails validation", () => {
    const parsed = Config.Mcp.safeParse({
      type: "remote",
      url: "https://example.com/mcp",
      enabled: true,
      transport: "sse",
      receipt: { source: "some-market" },
    })
    expect(parsed.success).toBe(false)
  })
})
