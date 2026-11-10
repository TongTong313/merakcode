import type { GroupMember } from "@merakcode/sdk"
import { createResource, createSignal, For, Show } from "solid-js"
import { t } from "../../i18n"
import { client } from "../../state/client"
import { groupView, loadGroup, localHuman } from "../../state/groups"
import { toast } from "../../ui/toast"
import { Section } from "./layout"

export function CloudMembers(props: { group: string }) {
  const [busy, setBusy] = createSignal(false)
  const [members, { refetch }] = createResource(async () => {
    const connection = await client()
    await loadGroup(props.group)
    return ((await connection.cloud.members()) ?? []).filter((member) => member.agentRole === "worker")
  })
  const available = () =>
    members()?.filter(
      (member) =>
        !groupView(props.group)?.members.some(
          (existing) => existing.id === member.id && existing.device === member.device,
        ),
    )
  const add = async (member: GroupMember) => {
    setBusy(true)
    try {
      await (await client()).group.addMember({ group: props.group, human: localHuman, member })
      await refetch()
      toast({ kind: "success", title: t("group.joined", { names: member.name }) })
    } catch (error) {
      toast({ kind: "error", title: t("error.request", { message: "MRK-6001" }), error })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Section title={t("profiles.title")}>
      <button class="button secondary sm" disabled={busy() || members.loading} onClick={() => void refetch()}>
        {t("settings.collaboration.refresh")}
      </button>
      <Show when={members.error}>
        <p role="alert">{t("error.request", { message: "MRK-6001" })}</p>
      </Show>
      <For each={available()}>
        {(member) => (
          <div class="card profile-card">
            <strong>{member.name}</strong>
            <p>{member.summary}</p>
            <button
              class="button secondary sm"
              disabled={busy()}
              aria-label={t("profiles.add", { name: member.name })}
              onClick={() => void add(member)}
            >
              {t("profiles.add", { name: member.name })}
            </button>
          </div>
        )}
      </For>
      <Show when={!members.loading && !members.error && !available()?.length}>
        <p class="subtle">{t("cloud.members.empty")}</p>
      </Show>
    </Section>
  )
}
