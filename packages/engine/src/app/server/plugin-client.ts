import { Plugin } from "../../agent/plugin"
import { createMerakCodeClient } from "@merakcode/sdk/client"
import { getLocalSecret } from "./auth/local-secret"
import { Server } from "./server"
import { Flag } from "../../infra/flag/flag"

/**
 * Adds the local auth header to the plugin's in-process client (matches opencode 1.16.2's
 * `headers: ServerAuth.headers()`).
 *
 * With a password set (`MERAKCODE_SERVER_PASSWORD`), the Basic Auth middleware in `server.ts` answers 401 to
 * requests without credentials. The plugin client goes through `Server.App().fetch` (in-process, no network), but
 * the middleware chain still runs, so plugins reading messages via `input.client` would silently get undefined.
 * This affects both the main process and the worker when CLI `serve` has a password.
 *
 * The secret is read per request (tests change it after the plugin state is created).
 * Requests that already carry authorization are left alone: a plugin may use other credentials for a third party.
 */
function withLocalAuth(input: RequestInfo | URL, init?: RequestInit): Request {
  const request = input instanceof Request && !init ? input : new Request(input as RequestInfo, init)
  if (request.headers.has("authorization")) return request
  const secret = getLocalSecret()
  if (!secret) return request
  const username = Flag.MERAKCODE_SERVER_USERNAME ?? "merakcode"
  const next = new Request(request)
  next.headers.set("authorization", `Basic ${Buffer.from(`${username}:${secret}`).toString("base64")}`)
  return next
}

export function installPluginClient() {
  Plugin.useClient((directory) => ({
    client: createMerakCodeClient({
      baseUrl: "http://localhost:4096",
      directory,
      // @ts-ignore - fetch type incompatibility
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => Server.App().fetch(withLocalAuth(input, init)),
    }),
    serverUrl: Server.url(),
  }))
}
