/** Evidence-based categories, not automatic blame assignment. No request/response payloads. */
export function failure(error: unknown, aborted = false) {
  try {
    const value = error && typeof error === "object" ? (error as Record<string, unknown>) : {}
    const cause = value.cause && typeof value.cause === "object" ? (value.cause as Record<string, unknown>) : {}
    const status =
      typeof value.statusCode === "number"
        ? value.statusCode
        : typeof value.status === "number"
          ? value.status
          : undefined
    const code = typeof value.code === "string" ? value.code : typeof cause.code === "string" ? cause.code : undefined
    const name = typeof value.name === "string" ? value.name : "UnknownError"
    const category =
      aborted || name === "AbortError"
        ? "cancelled"
        : status === 401 || status === 403
          ? "authentication_or_permission"
          : status === 429
            ? "rate_limit"
            : status && status >= 500
              ? "upstream_service"
              : status && status >= 400
                ? "request_rejected"
                : /ETIMEDOUT|UND_ERR_.*TIMEOUT/.test(code ?? "") || /TimeoutError$/.test(name)
                  ? "timeout"
                  : /ECONN|ENOTFOUND|EAI_AGAIN|CERT_|TLS_|ERR_TLS/.test(code ?? "")
                    ? "network_or_tls"
                    : /JSONParse|TypeValidation|InvalidResponse|NoObjectGenerated|InvalidTool|NoSuchTool/.test(name)
                      ? "response_or_tool_protocol"
                      : "unknown"
    return {
      category,
      error_name: name,
      error_code: code,
      status,
      retryable: typeof value.isRetryable === "boolean" ? value.isRetryable : undefined,
    }
  } catch {
    return { category: "unknown", error_name: "UninspectableError" }
  }
}
