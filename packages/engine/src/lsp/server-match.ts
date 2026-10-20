/**
 * Whether the LSP server handles the file extension.
 * Empty extensions mean any extension (a global server).
 */
export function serverHandlesExt(server: { extensions: string[] }, ext: string): boolean {
  return server.extensions.length === 0 || server.extensions.includes(ext)
}
