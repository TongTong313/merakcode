import type { AgentAgent, GroupGroup, GroupListing, GroupMember, ProtocolCloudStatus, TaskCard } from "@merakcode/sdk"
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { locale, t } from "../../i18n"
import { agents, loadAgents } from "../../state/agents"
import { client } from "../../state/client"
import { groupView, loadGroup, localHuman } from "../../state/groups"
import { Dialog } from "../../ui/dialog"
import { Segmented } from "../../ui/segmented"
import { Select } from "../../ui/select"
import { Switch } from "../../ui/switch"
import { toast } from "../../ui/toast"
import { WorkspacePicker } from "../shell/workspace-picker"
import { canLead } from "../agents/draft"
import { nameFor } from "../group/roster"
import { copyGroup } from "./group-copy"

const cloudMemberKey = (member: GroupMember) => JSON.stringify([member.device, member.group, member.id])

export function GroupCreate(props: {
  directory: string
  open: boolean
  onClose: () => void
  onCreated: (group: GroupGroup) => void
  /** The task this group is made for: its workspace is the group's and cannot be changed, and the group takes it */
  task?: TaskCard
}) {
  const [name, setName] = createSignal("")
  const [directory, setDirectory] = createSignal(props.directory)
  const [leader, setLeader] = createSignal("")
  const [workers, setWorkers] = createSignal<string[]>([])
  const [busy, setBusy] = createSignal(false)
  const [loading, setLoading] = createSignal(true)
  const [created, setCreated] = createSignal<GroupGroup>()
  const [kind, setKind] = createSignal<"local" | "cloud">("local")
  const [cloud, setCloud] = createSignal<ProtocolCloudStatus>()
  const [cloudMembers, setCloudMembers] = createSignal<GroupMember[]>([])
  const [sharing, setSharing] = createSignal(false)
  const [listed, setListed] = createSignal<GroupListing[]>([])
  const [copied, setCopied] = createSignal<{ from: string; skipped: string[] }>()
  const added = new Set<string>()
  const taken: string[] = [t("group.you")]
  const fail = (error: unknown) => toast({ kind: "error", title: t("error.request", { message: "MRK-6001" }), error })
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return
        setCreated(undefined)
        setKind("local")
        setCloud(undefined)
        setCloudMembers([])
        setSharing(false)
        setLeader("")
        setCopied(undefined)
        added.clear()
        taken.length = 1
        setName("")
        setDirectory(props.task?.project ?? props.directory)
        setWorkers([])
        setLoading(true)
        void client()
          .then(async (connection) => {
            const [, status, groups] = await Promise.all([
              loadAgents(),
              connection.cloud.status(),
              connection.group.list(),
            ])
            setCloud(status)
            setListed(groups ?? [])
            const first = agents().find((agent) => !agent.disabled && canLead(agent))
            setLeader(agents().find((agent) => agent.id === "builtin-merakcode")?.id ?? first?.id ?? "")
            setLoading(false)
            const members = status.account ? await connection.cloud.members() : []
            setCloudMembers((members ?? []).filter((member) => member.agentRole === "worker"))
          })
          .catch(fail)
          .finally(() => setLoading(false))
      },
    ),
  )
  // No agent is a Leader or a member by nature: any agent can take either seat, the Leader seat only when it can lead.
  const leaders = createMemo(() => agents().filter((agent) => !agent.disabled && canLead(agent)))
  const choices = (): AgentAgent[] =>
    kind() === "cloud"
      ? cloudMembers().map((member) => ({
          id: cloudMemberKey(member),
          name: member.name,
          shared: true,
          summary: member.summary ?? "",
          duties: "",
          model: { provider: "", model: "" },
          toolPool: "worker.default",
        }))
      : agents().filter((agent) => !agent.disabled)
  const selectedLeader = () => leaders().find((agent) => agent.id === leader())
  const ready = () =>
    (kind() === "local" || (!!cloud()?.account && sharing())) &&
    !!directory().trim() &&
    !!selectedLeader() &&
    !loading() &&
    !busy()
  const copy = (id: string) => {
    const source = listed().find((item) => item.id === id)
    if (!source) return
    void loadGroup(id)
      .then(() => {
        const result = copyGroup({ name: source.name, members: groupView(id)?.members ?? [] }, agents())
        setName(result.name)
        setWorkers(result.workers)
        setCopied({ from: id, skipped: result.skipped })
      })
      .catch(fail)
  }
  const create = async () => {
    if (!ready()) return
    setBusy(true)
    try {
      const connection = await client()
      if (!created()) {
        const profile = selectedLeader()!
        const leaderName = nameFor(
          profile.name,
          taken.map((name) => ({ name }) as GroupMember),
        )
        const id = crypto.randomUUID()
        taken.push(leaderName)
        setCreated(
          await connection.group.create({
            id: "",
            kind: kind(),
            name: name().trim() || props.task?.title || t("group.title"),
            project: { directory: directory().trim() },
            leader: id,
            ...(props.task ? { task: props.task.id } : {}),
            members: [
              { id: localHuman, group: "", kind: "human", name: t("group.you"), role: "owner", status: "idle" },
              {
                id,
                group: "",
                kind: "agent",
                name: leaderName,
                agentRole: "leader",
                agent: profile.id,
                owner: localHuman,
                status: "idle",
              },
            ],
          }),
        )
      }
      for (const id of workers()) {
        if (added.has(id)) continue
        if (kind() === "cloud") {
          const member = cloudMembers().find((member) => cloudMemberKey(member) === id)
          if (member) {
            await connection.group.addMember({ group: created()!.id, member })
            added.add(id)
          }
          continue
        }
        const profile = choices().find((agent) => agent.id === id)
        if (!profile) continue
        // The same agent can hold several seats, so a seat's name is made free among the ones taken
        const seatName = nameFor(
          profile.name,
          taken.map((name) => ({ name }) as GroupMember),
        )
        taken.push(seatName)
        await connection.group.addMember({
          group: created()!.id,
          member: {
            id: crypto.randomUUID(),
            group: created()!.id,
            kind: "agent",
            name: seatName,
            agentRole: "worker",
            agent: profile.id,
            owner: localHuman,
            status: "idle",
          },
        })
        added.add(id)
      }
      props.onCreated(created()!)
      props.onClose()
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => !open && props.onClose()}
      title={t("groupCreate.title")}
      description={props.task ? t("groupCreate.fromTask", { title: props.task.title }) : t("groupCreate.lead")}
      class="group-create"
      footer={
        <>
          <button class="button secondary" disabled={busy()} onClick={props.onClose}>
            {t("common.cancel")}
          </button>
          <button class="button primary" disabled={!ready()} onClick={() => void create()}>
            {t("group.create")}
          </button>
        </>
      }
    >
      <div class="dialog-body form">
        <fieldset class="field" disabled={busy() || !!created() || !!props.task}>
          <legend>{t("group.kind")}</legend>
          <Segmented
            label={t("group.kind")}
            options={(["local", "cloud"] as const).map((value) => ({
              value,
              label: t(`group.kind.${value}`),
              disabled: value === "cloud" && !cloud()?.account,
            }))}
            value={kind()}
            onChange={(value) => {
              setKind(value)
              setWorkers([])
            }}
          />
          <Show when={!cloud()?.account}>
            <p class="subtle">{t("group.cloud.loginRequired")}</p>
          </Show>
        </fieldset>
        <Show when={kind() === "cloud"}>
          <Switch
            label={t("group.cloud.consent")}
            checked={sharing()}
            disabled={busy() || !!created()}
            onChange={setSharing}
          />
          <p class="subtle">{t("group.cloud.data")}</p>
        </Show>
        <WorkspacePicker value={directory()} onChange={setDirectory} disabled={busy() || !!created() || !!props.task} />
        <Show when={props.task}>
          <p class="subtle">{t("workspace.fixed")}</p>
        </Show>
        <Show when={listed().length && !props.task && !created()}>
          <div class="field">
            <span>{t("group.copyFrom")}</span>
            <Select
              class="chip outlined"
              label={t("group.copyFrom")}
              placeholder={t("group.copyFromPlaceholder")}
              value={copied()?.from}
              options={listed().map((item) => ({
                value: item.id,
                label: item.name,
                description: item.project.directory,
              }))}
              onChange={copy}
            />
            <Show when={copied()?.skipped.length}>
              <p class="subtle group-copy-skipped" role="status">
                {t("group.copySkipped", { names: copied()!.skipped.join(locale() === "zh" ? "、" : ", ") })}
              </p>
            </Show>
          </div>
        </Show>
        <label class="field">
          <span>{t("group.name")}</span>
          <input
            class="input"
            aria-label={t("group.name")}
            placeholder={t("group.namePlaceholder")}
            disabled={busy() || !!created()}
            value={name()}
            onInput={(event) => setName(event.currentTarget.value)}
          />
        </label>
        <Show when={loading()}>
          <p role="status">{t("group.checking")}</p>
        </Show>
        <Show when={!loading() && !leaders().length}>
          <p class="member-problem" role="status">
            {t("groupCreate.noLeader")}
          </p>
        </Show>
        <div class="field">
          <span>{t("group.leader")}</span>
          <Select
            class="chip outlined"
            label={t("group.leader")}
            disabled={busy() || !!created()}
            value={leader() || undefined}
            options={leaders().map((agent) => ({ value: agent.id, label: agent.name, description: agent.summary }))}
            onChange={(value) => {
              setLeader(value)
            }}
          />
        </div>
        <div class="field">
          <span>{t("groupCreate.members")}</span>
          <Show when={choices().length || loading()} fallback={<p class="subtle">{t("groupCreate.noWorkers")}</p>}>
            <For each={choices()}>
              {(profile) => (
                <label class="row">
                  <input
                    type="checkbox"
                    disabled={busy() || !!created()}
                    aria-label={t("group.selectProfile", { name: profile.name })}
                    checked={workers().includes(profile.id)}
                    onChange={(event) =>
                      setWorkers((items) =>
                        event.currentTarget.checked ? [...items, profile.id] : items.filter((id) => id !== profile.id),
                      )
                    }
                  />
                  <span>{profile.name}</span>
                  <span class="subtle">{profile.summary}</span>
                </label>
              )}
            </For>
          </Show>
        </div>
      </div>
    </Dialog>
  )
}
