export function externalTarget(endpoint?: string) {
  if (!endpoint) throw new Error("Set MERAKCODE_SANDBOX_EXTERNAL_TARGET=http://<external-host>:<port>")
  const target = new URL(endpoint)
  // URL normalizes an explicit HTTP port 80 away; check the original authority for a port.
  const authority = endpoint.split(/[/?#]/, 3)[2] ?? ""
  if (target.protocol !== "http:" || !/:\d+$/.test(authority))
    throw new Error("The external target needs http:// and an explicit port")
  return { hostname: target.hostname, port: Number(target.port || 80) }
}
