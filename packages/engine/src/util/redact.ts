/**
 * Hides secrets in command output before the model sees it (config sandbox.redactSecrets, on by default).
 * It catches well-known key shapes and obvious assignments; it is a safety net, not a guarantee.
 */
export namespace Redact {
  const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
  const TOKENS = [
    /\bsk-[A-Za-z0-9_-]{16,}/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
    /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  ]
  const ASSIGNMENT = /\b([A-Za-z0-9_]*(?:_key|_token|_secret|password))(\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"']+)/gi

  export function secrets(text: string) {
    const masked = TOKENS.reduce(
      (result, pattern) => result.replace(pattern, "<redacted>"),
      text.replace(PRIVATE_KEY, "<redacted private key>"),
    )
    return masked.replace(ASSIGNMENT, (_, name: string, separator: string) => `${name}${separator}<redacted>`)
  }
}
