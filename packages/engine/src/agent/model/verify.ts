import { sortModels } from "@merakcode/util/model"
import { generateText } from "ai"
import { Provider } from "./provider"

/**
 * Checks that a connected provider works by sending a minimal request (a few tokens) to its small model.
 * Used on connect and by "test connection" in settings; errors are the provider's own messages (bad key, no balance,
 * wrong region, etc.)
 */
export namespace ProviderVerify {
  export type Result = { ok: true; model: string } | { ok: false; error: string }

  export async function run(providerID: string): Promise<Result> {
    const providers = await Provider.list()
    const provider = providers[providerID]
    if (!provider) return { ok: false, error: `provider is not connected: ${providerID}` }
    const model =
      (await Provider.getSmallModel(providerID)) ??
      (await (async () => {
        const [first] = sortModels(Object.values(provider.models))
        return first ? Provider.getModel(providerID, first.id) : undefined
      })())
    if (!model) return { ok: false, error: `provider has no models: ${providerID}` }
    return generateText({
      model: await Provider.getLanguage(model),
      prompt: "Reply with OK.",
      maxOutputTokens: 16,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(30_000),
    })
      .then((): Result => ({ ok: true, model: model.id }))
      .catch((error: unknown): Result => ({ ok: false, error: message(error) }))
  }

  /** In AI SDK errors the provider's original text is in responseBody / data; message often has only the status code */
  function message(error: unknown) {
    if (!(error instanceof Error)) return String(error)
    const detail = error as Error & { responseBody?: string; data?: { error?: { message?: string } } }
    const fromData = detail.data?.error?.message
    if (fromData) return fromData
    if (detail.responseBody) {
      try {
        const parsed = JSON.parse(detail.responseBody) as { error?: { message?: string }; message?: string }
        return parsed.error?.message ?? parsed.message ?? error.message
      } catch {
        return detail.responseBody.slice(0, 500)
      }
    }
    return error.message
  }
}
