/**
 * OAuth for remote MCP servers (matches the four mcp.auth routes of OpenCode v1.16.2).
 * Tokens are only stored in the local data directory, never in logs, events or config output.
 */
import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { randomBytes } from "node:crypto"
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js"
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js"
import { NamedError } from "@merakcode/util/error"
import z from "zod/v4"
import { Global } from "../global"
import { Log } from "@merakcode/log/logger"
import type { Config } from "../config/config"
import { Filesystem } from "@merakcode/util/filesystem"
import { Http } from "@merakcode/util/http"
import { Text } from "../util/text"

const log = Log.create({ service: "mcp.oauth" })

export const McpServerNotFoundError = NamedError.create("McpServerNotFoundError", z.object({ name: z.string() }))
export const McpUnsupportedOAuthError = NamedError.create("McpUnsupportedOAuthError", z.object({ name: z.string() }))

type OAuthConfig = Exclude<Extract<Config.Mcp, { type: "remote" }>["oauth"], false | undefined>
type Stored = {
  client?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  codeVerifier?: string
  state?: string
}

const waiters = new Map<string, (code: string) => void>()
/** Holds codes whose callback arrives before anyone waits (the client opens the browser first, then waits) */
const early = new Map<string, string>()
let callbackPort: number | undefined

function storeRoot() {
  return process.env.MERAKCODE_MCP_OAUTH_DIR || join(Global.Path.data, "mcp-oauth")
}

function storePath(name: string) {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "server"
  return join(storeRoot(), `${safe}.json`)
}

async function readStore(name: string): Promise<Stored> {
  const text = await Filesystem.readText(storePath(name)).catch(() => "")
  if (!text) return {}
  try {
    return JSON.parse(text) as Stored
  } catch {
    return {}
  }
}

async function writeStore(name: string, data: Stored) {
  const path = storePath(name)
  await mkdir(dirname(path), { recursive: true })
  await Filesystem.write(path, JSON.stringify(data))
}

/** Receives the code when the authorization server redirects the browser here. Codes are never logged. */
async function ensureCallback(): Promise<number> {
  if (callbackPort) return callbackPort
  const fixed = Number(process.env.MERAKCODE_MCP_OAUTH_CALLBACK_PORT)
  // The callback opens in a browser with no Instance context to read the locale from, so the page language is fixed
  // when the server starts
  const lang = await Text.lang()
  const server = await Http.serve({
    hostname: "127.0.0.1",
    port: Number.isInteger(fixed) && fixed > 0 ? fixed : 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname !== "/mcp/oauth/callback") return new Response("not found", { status: 404 })
      const code = url.searchParams.get("code")
      const state = url.searchParams.get("state")
      const error = url.searchParams.get("error")
      if (error) {
        log.warn("mcp oauth callback rejected", { category: "authentication_or_permission", outcome: error })
        return new Response(
          Text.format(
            {
              zh: "授权没有完成，请回到 MerakCode 重试。",
              en: "Authorization was not completed. Go back to MerakCode and try again.",
            },
            lang,
          ),
          { headers: { "content-type": "text/plain; charset=utf-8" } },
        )
      }
      if (code && state) {
        const waiter = waiters.get(state)
        waiters.delete(state)
        if (waiter) waiter(code)
        else {
          early.set(state, code)
          // If nobody comes to wait (the client quit), expire after 5 minutes like a wait
          setTimeout(() => early.delete(state), 300_000).unref()
        }
        log.info("mcp oauth callback received", { outcome: "code" })
      }
      return new Response(
        Text.format(
          { zh: "授权完成，可以回到 MerakCode。", en: "Authorization complete. You can return to MerakCode." },
          lang,
        ),
        { headers: { "content-type": "text/plain; charset=utf-8" } },
      )
    },
  })
  const port = server.port
  callbackPort = port
  log.info("mcp oauth callback listening", { port })
  return port
}

function redirectUrl(port: number) {
  return `http://127.0.0.1:${port}/mcp/oauth/callback`
}

function provider(
  name: string,
  oauth: OAuthConfig | undefined,
  port: number,
  issueTokens: boolean,
): OAuthClientProvider {
  let pendingState = ""
  return {
    get redirectUrl() {
      return redirectUrl(port)
    },
    get clientMetadata() {
      return {
        redirect_uris: [redirectUrl(port)],
        client_name: "MerakCode",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: oauth?.clientSecret ? "client_secret_post" : "none",
      }
    },
    state() {
      pendingState = randomBytes(16).toString("base64url")
      return pendingState
    },
    async clientInformation() {
      if (oauth?.clientId) return { client_id: oauth.clientId, client_secret: oauth.clientSecret }
      return (await readStore(name)).client
    },
    async saveClientInformation(info) {
      const current = await readStore(name)
      await writeStore(name, { ...current, client: info })
    },
    async tokens() {
      if (!issueTokens) return
      return (await readStore(name)).tokens
    },
    async saveTokens(tokens) {
      const current = await readStore(name)
      await writeStore(name, { ...current, tokens })
    },
    // Connecting only reuses and refreshes stored tokens; begin() wraps this to capture the authorization URL and
    // return it to the caller
    redirectToAuthorization() {},
    async saveCodeVerifier(codeVerifier) {
      const current = await readStore(name)
      await writeStore(name, { ...current, codeVerifier, state: pendingState })
    },
    async codeVerifier() {
      const verifier = (await readStore(name)).codeVerifier
      if (!verifier) throw new Error("missing code verifier")
      return verifier
    },
    async invalidateCredentials(scope) {
      if (scope === "tokens" || scope === "all") {
        const current = await readStore(name)
        await writeStore(name, { ...current, tokens: undefined })
      }
    },
  }
}

/**
 * Auth provider for the transport, carrying the stored tokens.
 *
 * Only returned when needed: when the user configured `oauth: {...}` or the server was authorized before (client or
 * tokens stored locally). Otherwise returns undefined and the transport only uses headers. With an authProvider, the
 * MCP SDK runs OAuth discovery on 401, turning a wrong header token into unrelated authorization errors; and this
 * function calls `ensureCallback()`, which opens a localhost port that no process should open just in case.
 * Actual authorization goes through CLI `merak mcp auth <name>` or the `/mcp/:name/auth*` routes
 * (MCP.startAuth → begin), which start the callback server themselves.
 */
export async function transportProvider(name: string, oauth: OAuthConfig | undefined) {
  const stored = await readStore(name)
  if (!oauth && !stored.tokens && !stored.client) return undefined
  const port = await ensureCallback()
  return provider(name, oauth, port, true)
}

export async function begin(name: string, url: string, oauth: OAuthConfig | undefined) {
  const port = await ensureCallback()
  const current = provider(name, oauth, port, false)
  let pendingUrl = ""
  let pendingState = ""
  const wrapped: OAuthClientProvider = {
    ...current,
    state() {
      const state = current.state?.() ?? randomBytes(16).toString("base64url")
      pendingState = typeof state === "string" ? state : ""
      return state
    },
    redirectToAuthorization(target) {
      pendingUrl = target.toString()
      current.redirectToAuthorization(target)
    },
  }
  try {
    const result = await auth(wrapped, { serverUrl: url, scope: oauth?.scope })
    log.info("mcp oauth started", { name, outcome: result === "REDIRECT" ? "redirect" : result })
    if (!pendingUrl) throw new Error("authorization url missing")
    const state = new URL(pendingUrl).searchParams.get("state") ?? pendingState
    return { authorizationUrl: pendingUrl, oauthState: state }
  } catch (error) {
    log.error("mcp oauth failed", {
      name,
      stage: "start",
      category: "upstream_service",
      error_name: error instanceof Error ? error.name : "Error",
    })
    throw error
  }
}

export async function exchange(name: string, url: string, code: string, oauth: OAuthConfig | undefined) {
  const port = callbackPort ?? (await ensureCallback())
  const current = provider(name, oauth, port, true)
  try {
    await auth(current, { serverUrl: url, authorizationCode: code, scope: oauth?.scope })
    log.info("mcp oauth completed", { name, outcome: "tokens" })
  } catch (error) {
    log.error("mcp oauth failed", {
      name,
      stage: "callback",
      category: "authentication_or_permission",
      error_name: error instanceof Error ? error.name : "Error",
    })
    throw error
  }
}

export async function remove(name: string) {
  const { unlink } = await import("node:fs/promises")
  await unlink(storePath(name)).catch(() => undefined)
  log.info("mcp oauth removed", { name, outcome: "removed" })
}

export async function waitForBrowserCode(state: string, timeoutMs = 300_000) {
  const arrived = early.get(state)
  early.delete(state)
  if (arrived) return arrived
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(state)
      reject(new Error("mcp oauth timed out"))
    }, timeoutMs)
    waiters.set(state, (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}

export function oauthOptions(mcp: Config.Mcp): OAuthConfig | undefined {
  if (mcp.type !== "remote" || !mcp.oauth) return
  return mcp.oauth
}
