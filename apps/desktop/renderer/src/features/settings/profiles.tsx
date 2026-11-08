import { ProfileProfileSchema, type ProfileProfile, type ProfileProduct } from "@merakcode/sdk"
import { createEffect, createResource, createSignal, For, Show } from "solid-js"
import { t } from "../../i18n"
import { client } from "../../state/client"
import { localHuman } from "../../state/groups"
import { toast } from "../../ui/toast"
import { Section } from "./layout"

export function Profiles(props: { group?: string } = {}) {
  const [profiles, { refetch }] = createResource(
    async () => (await (await client()).profile.list({ human: localHuman })) ?? [],
  )
  const [draft, setDraft] = createSignal<ProfileProfile>()
  const [products, { refetch: detect }] = createResource(async () => (await (await client()).member.catalog()) ?? [])
  const [environment, setEnvironment] = createSignal("")
  const [checked, setChecked] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const fail = (error: unknown) => toast({ kind: "error", title: t("error.request", { message: "MRK-6001" }), error })
  createEffect(() => {
    draft()
    environment()
    setChecked(false)
  })
  const edit = (profile: ProfileProfile) => {
    setDraft(profile)
    setEnvironment(
      Object.entries(profile.product?.env ?? {})
        .map(([key, value]) => `${key}=${value}`)
        .join("\n"),
    )
  }
  const payload = (profile: ProfileProfile) => {
    if (!profile.product) return ProfileProfileSchema.parse(profile)
    const entries = environment()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
        if (!match) throw new Error("MRK-1001")
        return [match[1]!, match[2]!] as const
      })
    if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error("MRK-1001")
    return ProfileProfileSchema.parse({ ...profile, product: { ...profile.product, env: Object.fromEntries(entries) } })
  }
  const test = async () => {
    const profile = draft()
    if (!profile) return
    const env = environment()
    setBusy(true)
    try {
      await (await client()).member.test({ human: localHuman, profile: payload(profile) })
      if (draft() === profile && environment() === env) setChecked(true)
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }
  const productField = (patch: Partial<ProfileProduct>) =>
    setDraft((profile) => ({ ...profile!, product: { ...profile!.product!, ...patch } }))
  const save = async () => {
    const profile = draft()
    if (!profile) return
    setBusy(true)
    try {
      await (await client()).profile.save({ human: localHuman, profile: payload(profile) })
      await refetch()
      setDraft(undefined)
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }
  const add = async (profile: ProfileProfile) => {
    if (!props.group) return
    setBusy(true)
    try {
      await (
        await client()
      ).member.register({
        group: props.group,
        human: localHuman,
        member: {
          id: "",
          group: props.group,
          kind: "agent",
          name: profile.name,
          agentRole: profile.role,
          profile: profile.id,
          owner: localHuman,
          status: "idle",
        },
      })
      toast({ kind: "success", title: t("group.joined", { names: profile.name }) })
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }
  const field = (key: "name" | "summary" | "duties" | "system", value: string) =>
    setDraft((profile) => ({ ...profile!, [key]: value }))
  return (
    <Section title={t("profiles.title")}>
      <Show when={!draft()}>
        <div class="card profile-card">
          <h3>{t("settings.collaboration.products")}</h3>
          <button class="button secondary sm" disabled={products.loading} onClick={() => void detect()}>
            {t("settings.collaboration.refresh")}
          </button>
          <For each={products.error ? [] : products()}>
            {(product) => (
              <div class="row">
                <strong>{product.name}</strong>
                <span class="subtle">
                  {product.available ? t("settings.collaboration.available") : t("group.unavailable")} {product.version}
                </span>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={profiles.error}>
        <p role="alert">{t("error.request", { message: "MRK-6001" })}</p>
        <button class="button secondary" onClick={() => void refetch()}>
          {t("settings.collaboration.refresh")}
        </button>
      </Show>
      <Show
        when={draft()}
        fallback={
          <For each={profiles()}>
            {(profile) => (
              <div class="card profile-card">
                <strong>{profile.name}</strong>
                <p>{profile.summary}</p>
                <p class="subtle">{profile.duties}</p>
                <div class="row">
                  <button
                    class="button secondary sm"
                    aria-label={t("profiles.copy", { name: profile.name })}
                    onClick={() => edit({ ...structuredClone(profile), id: "" })}
                  >
                    {t("profiles.copy", { name: profile.name })}
                  </button>
                  <Show when={!profile.id.startsWith("builtin-")}>
                    <button
                      class="button secondary sm"
                      aria-label={t("profiles.edit", { name: profile.name })}
                      onClick={() => edit(structuredClone(profile))}
                    >
                      {t("profiles.edit", { name: profile.name })}
                    </button>
                  </Show>
                  <Show when={props.group}>
                    <button
                      class="button secondary sm"
                      disabled={busy()}
                      aria-label={t("profiles.add", { name: profile.name })}
                      onClick={() => void add(profile)}
                    >
                      {t("profiles.add", { name: profile.name })}
                    </button>
                  </Show>
                </div>
              </div>
            )}
          </For>
        }
      >
        <div class="card form">
          <Show when={draft()?.role === "worker"}>
            <label class="field">
              <span>{t("group.product")}</span>
              <select
                class="input"
                aria-label={t("group.product")}
                value={draft()?.product?.kind ?? "builtin"}
                onChange={(event) => {
                  const kind = event.currentTarget.value
                  const detected = products()?.find((item) => item.kind === kind)
                  setDraft((profile) => ({
                    ...profile!,
                    product: kind === "builtin" ? undefined : { kind, binary: detected?.binary ?? "" },
                  }))
                }}
              >
                <option value="builtin">MerakCode</option>
                <option value="claude-code">Claude Code</option>
                <option value="codex">Codex</option>
                <option value="opencode">OpenCode</option>
                <option value="pi">Pi</option>
                <option value="acp">ACP</option>
                <option value="command">{t("settings.collaboration.adapter.command")}</option>
              </select>
            </label>
          </Show>
          <label class="field">
            <span>{t("profiles.name")}</span>
            <input
              class="input"
              aria-label={t("profiles.name")}
              value={draft()?.name ?? ""}
              onInput={(event) => field("name", event.currentTarget.value)}
            />
          </label>
          <label class="field">
            <span>{t("profiles.summary")}</span>
            <input
              class="input"
              aria-label={t("profiles.summary")}
              value={draft()?.summary ?? ""}
              onInput={(event) => field("summary", event.currentTarget.value)}
            />
          </label>
          <label class="field">
            <span>{t("profiles.duties")}</span>
            <textarea
              class="input"
              aria-label={t("profiles.duties")}
              value={draft()?.duties ?? ""}
              onInput={(event) => field("duties", event.currentTarget.value)}
            />
          </label>
          <label class="field">
            <span>{t("profiles.system")}</span>
            <textarea
              class="input"
              aria-label={t("profiles.system")}
              value={draft()?.system ?? ""}
              onInput={(event) => field("system", event.currentTarget.value)}
            />
          </label>
          <Show when={!draft()?.product}>
            <label class="field">
              <span>{t("profiles.provider")}</span>
              <input
                class="input"
                aria-label={t("profiles.provider")}
                value={draft()?.model.provider ?? ""}
                onInput={(event) =>
                  setDraft((profile) => ({
                    ...profile!,
                    model: { ...profile!.model, provider: event.currentTarget.value },
                  }))
                }
              />
            </label>
            <label class="field">
              <span>{t("profiles.model")}</span>
              <input
                class="input"
                aria-label={t("profiles.model")}
                value={draft()?.model.model ?? ""}
                onInput={(event) =>
                  setDraft((profile) => ({
                    ...profile!,
                    model: { ...profile!.model, model: event.currentTarget.value },
                  }))
                }
              />
            </label>
          </Show>
          <Show when={draft()?.product}>
            <label class="field">
              <span>{t("settings.collaboration.command")}</span>
              <input
                class="input"
                aria-label={t("settings.collaboration.command")}
                value={draft()?.product?.binary ?? ""}
                onInput={(event) => productField({ binary: event.currentTarget.value })}
              />
            </label>
            <label class="field">
              <span>{t("settings.collaboration.args")}</span>
              <textarea
                class="input"
                aria-label={t("settings.collaboration.args")}
                value={draft()?.product?.args?.join("\n") ?? ""}
                onInput={(event) => productField({ args: event.currentTarget.value.split(/\r?\n/).filter(Boolean) })}
              />
            </label>
            <label class="field">
              <span>{t("profiles.productModel")}</span>
              <input
                class="input"
                aria-label={t("profiles.productModel")}
                value={draft()?.product?.model ?? ""}
                onInput={(event) => productField({ model: event.currentTarget.value })}
              />
            </label>
            <label class="field">
              <span>{t("profiles.environment")}</span>
              <textarea
                class="input"
                aria-label={t("profiles.environment")}
                value={environment()}
                onInput={(event) => setEnvironment(event.currentTarget.value)}
              />
            </label>
          </Show>
          <button
            class="button secondary"
            aria-label={t("profiles.test")}
            disabled={busy()}
            onClick={() => void test()}
          >
            {t("profiles.test")}
          </button>
          <Show when={checked()}>
            <p role="status">{t("profiles.verified")}</p>
          </Show>
          <div class="row">
            <button class="button secondary" disabled={busy()} onClick={() => setDraft(undefined)}>
              {t("common.cancel")}
            </button>
            <button
              class="button primary"
              aria-label={t("profiles.save")}
              disabled={busy() || !draft()?.name.trim() || (!draft()?.product && !draft()?.model.provider.trim())}
              onClick={() => void save()}
            >
              {t("profiles.save")}
            </button>
          </div>
        </div>
      </Show>
    </Section>
  )
}
