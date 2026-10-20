import { Agent } from "undici"

/**
 * Connection pool for outbound HTTPS. Uses Node's default trust chain (public root certificates plus those in
 * NODE_EXTRA_CA_CERTS, e.g. a corporate proxy root) and explicitly enables certificate validation.
 *
 * rejectUnauthorized must be set **explicitly**: Node only applies NODE_TLS_REJECT_UNAUTHORIZED when the option is
 * not given. If a user's environment sets it to 0, omitting the option disables validation entirely and a
 * man-in-the-middle could impersonate the update server or a model service. An explicit option wins over the env.
 */
let agent: Agent | undefined

/**
 * Adds the pool above to fetch options. Outbound HTTPS goes through here; a bare fetch would be undermined by
 * NODE_TLS_REJECT_UNAUTHORIZED=0 in the environment. Node's fetch takes no TLS options, so they go in through the
 * dispatcher (an undici pool).
 */
export function withTrustedTls<T extends RequestInit>(init?: T): T {
  agent ??= new Agent({ connect: { rejectUnauthorized: true } })
  // RequestInit has no dispatcher in its type (Node bundles its own undici types, separate from the undici
  // package), but the runtime fetch accepts it
  return { ...(init ?? ({} as T)), dispatcher: agent } as T
}
