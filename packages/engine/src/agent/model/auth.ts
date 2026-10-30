import { Instance } from "../../infra/project/instance"
import { Plugin } from "../plugin"
import { map, filter, pipe, fromEntries, mapValues } from "remeda"
import z from "zod"
import { fn } from "@merakcode/util/fn"
import type { AuthOAuthResult } from "@merakcode/sdk/plugin"
import { NamedError } from "@merakcode/util/error"
import { Auth } from "@merakcode/engine/agent/model/credentials"

export namespace ProviderAuth {
  const state = Instance.state(async () => {
    const methods = pipe(
      await Plugin.list(),
      filter((x) => x.auth?.provider !== undefined),
      map((x) => [x.auth!.provider, x.auth!] as const),
      fromEntries(),
    )
    return { methods, pending: {} as Record<string, AuthOAuthResult> }
  })

  export const Method = z
    .object({
      type: z.union([z.literal("oauth"), z.literal("api")]),
      label: z.string(),
    })
    .meta({
      ref: "ProviderAuthMethod",
    })
  export type Method = z.infer<typeof Method>

  export async function methods() {
    const s = await state().then((x) => x.methods)
    return mapValues(s, (x) =>
      x.methods.map((y): Method => ({
        type: y.type,
        label: y.label,
      })),
    )
  }

  export const Authorization = z
    .object({
      url: z.string(),
      method: z.union([z.literal("auto"), z.literal("code")]),
      instructions: z.string(),
    })
    .meta({
      ref: "ProviderAuthAuthorization",
    })
  export type Authorization = z.infer<typeof Authorization>

  /** One question a plugin asks the user before authorization (pick an option or enter text) */
  export const Prompt = z
    .discriminatedUnion("type", [
      z.object({
        type: z.literal("text"),
        key: z.string(),
        message: z.string(),
        placeholder: z.string().optional(),
      }),
      z.object({
        type: z.literal("select"),
        key: z.string(),
        message: z.string(),
        options: z.array(z.object({ label: z.string(), value: z.string(), hint: z.string().optional() })),
      }),
    ])
    .meta({ ref: "ProviderAuthPrompt" })

  const Inputs = z.record(z.string(), z.string())

  /**
   * The next question to ask: in the plugin's declared order, skipping those whose condition fails; an answered one
   * that fails validation is asked again with the reason. No prompt once all are answered. Conditions and validation
   * are plugin functions that only run in the engine, so the client calls this after every answer.
   */
  export const prompt = fn(
    z.object({ providerID: z.string(), method: z.number(), inputs: Inputs }),
    async (input): Promise<{ prompt?: z.infer<typeof Prompt>; error?: string }> => {
      const auth = await state().then((s) => s.methods[input.providerID])
      const method = auth?.methods[input.method]
      for (const item of method?.type === "oauth" ? (method.prompts ?? []) : []) {
        if (item.condition && !item.condition(input.inputs)) continue
        const shown =
          item.type === "select"
            ? { type: item.type, key: item.key, message: item.message, options: item.options }
            : { type: item.type, key: item.key, message: item.message, placeholder: item.placeholder }
        const value = input.inputs[item.key]
        if (value === undefined) return { prompt: shown }
        const error = item.type === "text" ? item.validate?.(value) : undefined
        if (error) return { prompt: shown, error }
      }
      return {}
    },
  )

  export const authorize = fn(
    z.object({
      providerID: z.string(),
      method: z.number(),
      inputs: Inputs.optional(),
    }),
    async (input): Promise<Authorization | undefined> => {
      const auth = await state().then((s) => s.methods[input.providerID])
      const method = auth.methods[input.method]
      if (method.type === "oauth") {
        const result = await method.authorize(input.inputs)
        await state().then((s) => (s.pending[input.providerID] = result))
        return {
          url: result.url,
          method: result.method,
          instructions: result.instructions,
        }
      }
    },
  )

  export const callback = fn(
    z.object({
      providerID: z.string(),
      method: z.number(),
      code: z.string().optional(),
    }),
    async (input) => {
      const match = await state().then((s) => s.pending[input.providerID])
      if (!match) throw new OauthMissing({ providerID: input.providerID })
      let result

      if (match.method === "code") {
        if (!input.code) throw new OauthCodeMissing({ providerID: input.providerID })
        result = await match.callback(input.code)
      }

      if (match.method === "auto") {
        result = await match.callback()
      }

      if (result?.type === "success") {
        // A plugin may store the credential under another provider id; it reports which one
        const providerID = result.provider ?? input.providerID
        if ("key" in result) await Auth.set(providerID, { type: "api", key: result.key })
        if ("refresh" in result)
          await Auth.set(providerID, {
            type: "oauth",
            access: result.access,
            refresh: result.refresh,
            expires: result.expires,
            ...(result.accountId ? { accountId: result.accountId } : {}),
            ...(result.enterpriseUrl ? { enterpriseUrl: result.enterpriseUrl } : {}),
          })
        return providerID
      }

      throw new OauthCallbackFailed({})
    },
  )

  export const OauthMissing = NamedError.create(
    "ProviderAuthOauthMissing",
    z.object({
      providerID: z.string(),
    }),
  )
  export const OauthCodeMissing = NamedError.create(
    "ProviderAuthOauthCodeMissing",
    z.object({
      providerID: z.string(),
    }),
  )

  export const OauthCallbackFailed = NamedError.create("ProviderAuthOauthCallbackFailed", z.object({}))
}
