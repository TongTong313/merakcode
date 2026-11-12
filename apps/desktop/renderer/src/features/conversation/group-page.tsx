import ChevronsLeft from "lucide-solid/icons/chevrons-left"
import ChevronsRight from "lucide-solid/icons/chevrons-right"
import { createEffect, createMemo, createSignal, For, on, Show, untrack } from "solid-js"
import { z } from "zod"
import type { GroupMember } from "@merakcode/sdk"
import { t } from "../../i18n"
import { agents, loadAgents } from "../../state/agents"
import { client } from "../../state/client"
import { groupView, loadGroup, localHuman, markGroupRead } from "../../state/groups"
import { state } from "../../state/store"
import { saveLayout, setUi, ui } from "../../state/ui"
import { Avatar } from "../../ui/avatar"
import { Select } from "../../ui/select"
import { toast } from "../../ui/toast"
import { Breakdown } from "../group/breakdown"
import { GroupChat } from "../group/chat"
import { Roster } from "../group/roster"
import { GroupUsage } from "../group/usage"
import { Frame } from "../shell/frame"
import { Composer } from "./composer"

const initiatives = z.enum(["passive", "normal", "eager"])

/** Who the message is for: the names after an @ in the text, and the member whose "Message" button was pressed. */
export function recipientsOf(text: string, members: readonly GroupMember[], chosen: readonly string[]) {
  const ordered = [...members].sort((a, b) => b.name.length - a.name.length)
  const names = ordered.map((member) => member.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  const found = new Set(chosen)
  if (!names.length) return [...found]
  const pattern = new RegExp(`(?:^|\\s)@(${names.join("|")})(?=$|[\\s,.:;!?，。！？：；])`, "gu")
  for (const match of text.matchAll(pattern)) {
    const member = ordered.find((item) => item.name === match[1])
    if (member) found.add(member.id)
  }
  return [...found]
}

export function GroupConversation(props: { id: string; directory: string }) {
  const [to, setTo] = createSignal<string[]>([])
  const [openMember, setOpenMember] = createSignal<string>()
  const [saving, setSaving] = createSignal(false)
  const collapsed = () => ui.membersCollapsed || ui.panel
  const collapse = (value: boolean) => {
    if (!value) setUi("panel", false)
    setUi("membersCollapsed", value)
    saveLayout()
  }
  const view = () => groupView(props.id)
  const members = () => view()?.members ?? []
  createEffect(() => {
    const id = props.id
    const sequence = view()?.lastSeq ?? 0
    untrack(() => markGroupRead(id, sequence))
  })
  createEffect(
    on(
      () => props.id,
      (id) => {
        setTo([])
        setOpenMember(undefined)
        void loadAgents().catch(() => undefined)
        void loadGroup(id).catch((error) =>
          toast({ kind: "error", title: t("error.request", { message: "MRK-6001" }), error }),
        )
      },
    ),
  )
  const leaderSession = () => view()?.leader?.session
  const leaderBusy = () => !!leaderSession() && state.views[leaderSession()!]?.state.status === "running"
  const busy = (member: GroupMember) => {
    if (member.id === view()?.leader?.member) return leaderBusy()
    return Object.values(view()?.board.columns ?? {})
      .flat()
      .flatMap((card) => card.claims ?? [])
      .some((claim) => claim.member === member.id && claim.status === "active")
  }
  const memberSession = (member: GroupMember) => {
    if (member.id === view()?.leader?.member) return leaderSession()
    return Object.values(view()?.board.columns ?? {})
      .flat()
      .flatMap((card) => card.claims ?? [])
      .findLast((claim) => claim.member === member.id && claim.session)?.session
  }
  const agentMembers = createMemo(() => members().filter((member) => member.kind === "agent"))
  const leader = () => view()?.leader?.member ?? view()?.group?.leader ?? ""
  const archived = () => !!view()?.group?.archived
  const admin = () =>
    members().some((member) => member.id === localHuman && (member.role === "owner" || member.role === "admin"))
  const todos = () => view()?.assignments.todos[leader()] ?? []
  const setInitiative = async (value: string) => {
    const group = view()?.group
    if (!group) return
    setSaving(true)
    try {
      await (
        await client()
      ).group.update({ group: group.id, settings: { ...group.settings, initiative: initiatives.parse(value) } })
    } catch (error) {
      toast({ kind: "error", title: t("error.request", { message: "MRK-6001" }), error })
    } finally {
      setSaving(false)
    }
  }
  return (
    <Frame
      directory={props.directory}
      folder={props.directory}
      title={<span class="title ellipsis">{view()?.group?.name}</span>}
      actions={<span class="chip">{t("group.members", { count: members().length })}</span>}
    >
      <div class="chat-area">
        <div class="chat-main">
          <GroupChat id={props.id} directory={props.directory} />
          <div class="dock">
            <div class="dock-inner">
              <Show when={to().length}>
                <p class="subtle">
                  @{members().find((member) => member.id === to()[0])?.name}
                  <button class="button ghost sm" onClick={() => setTo([])}>
                    {t("common.cancel")}
                  </button>
                </p>
              </Show>
              <Composer
                group
                directory={props.directory}
                sessionID={`group:${props.id}`}
                busy={leaderBusy()}
                disabled={!view()?.group || archived()}
                placeholder={t("group.placeholder")}
                onStop={() => {
                  const session = leaderSession()
                  if (!session) return
                  void (async () => (await client()).session.cancel({ session }))().catch((error) =>
                    toast({ kind: "error", title: t("error.request", { message: "MRK-4001" }), error }),
                  )
                }}
                onSubmit={async ({ text }) => {
                  await (await client()).group.say({ group: props.id, text, to: recipientsOf(text, members(), to()) })
                  setTo([])
                }}
              />
            </div>
          </div>
        </div>
        <aside class="members" classList={{ collapsed: collapsed() }} aria-label={t("group.column")}>
          <div class="members-head">
            <Show when={!collapsed()}>
              <span class="members-title">{t("group.column.title")}</span>
            </Show>
            <button
              class="icon-button sm"
              aria-label={t(collapsed() ? "group.expand" : "group.collapse")}
              title={t(collapsed() ? "group.expand" : "group.collapse")}
              onClick={() => collapse(!collapsed())}
            >
              <Show when={collapsed()} fallback={<ChevronsRight class="icon icon-sm" />}>
                <ChevronsLeft class="icon icon-sm" />
              </Show>
            </button>
          </div>
          <Show
            when={!collapsed()}
            fallback={
              <div class="members-strip scroll">
                <For each={agentMembers()}>
                  {(member) => (
                    <button
                      class="members-face"
                      aria-label={member.name}
                      title={member.name}
                      onClick={() => {
                        collapse(false)
                        setOpenMember(member.id)
                      }}
                    >
                      <Avatar id={member.id} name={member.name} />
                      <Show when={busy(member)}>
                        <span class="member-busy" />
                      </Show>
                    </button>
                  )}
                </For>
              </div>
            }
          >
            <div class="members-body scroll">
              <Breakdown rows={view()?.assignments.tasks ?? []} members={members()} todos={todos()} />
              <Roster
                group={props.id}
                kind={view()?.group?.kind}
                members={members()}
                busy={busy}
                sandbox={(member) => ({
                  directory: props.directory,
                  sessionID: memberSession(member),
                  mode: agents().find((agent) => agent.id === member.agent)?.mode ?? "ask",
                  busy: busy(member),
                })}
                leader={leader()}
                open={openMember()}
                onOpen={setOpenMember}
                onMessage={(member) => setTo([member.id])}
              />
              <details class="member-settings">
                <summary>{t("group.settings")}</summary>
                <Show when={admin()}>
                  <div class="field">
                    <span>{t("group.initiative")}</span>
                    <Select
                      class="chip outlined"
                      label={t("group.initiative")}
                      disabled={saving()}
                      value={view()?.group?.settings?.initiative || "normal"}
                      options={initiatives.options.map((value) => ({
                        value,
                        label: t(`group.initiative.${value}`),
                      }))}
                      onChange={(value) => void setInitiative(value)}
                    />
                  </div>
                </Show>
                <Show when={view()}>
                  {(current) => (
                    <GroupUsage
                      events={current().events}
                      members={current().members}
                      tasks={Object.values(current().board.columns).flat()}
                    />
                  )}
                </Show>
              </details>
            </div>
          </Show>
        </aside>
      </div>
    </Frame>
  )
}
