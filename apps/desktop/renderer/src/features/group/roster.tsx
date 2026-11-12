import Plus from "lucide-solid/icons/plus"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import type { AgentAgent, GroupMember } from "@merakcode/sdk"
import { t } from "../../i18n"
import { client } from "../../state/client"
import { localHuman } from "../../state/groups"
import { Avatar } from "../../ui/avatar"
import { Confirm, Dialog } from "../../ui/dialog"
import { toast } from "../../ui/toast"
import { RemoteMembers } from "../settings/remote"
import { CloudMembers } from "../settings/cloud-members"
import { SandboxStatus } from "../conversation/sandbox-status"

/** Why a name cannot be used, or undefined when it can; the engine checks the same rules. */
export function nameProblem(name: string, taken: readonly string[]) {
  const value = name.trim()
  if (!value) return t("group.nameEmpty")
  if (/[\s@]/u.test(value)) return t("group.nameInvalid")
  if (taken.some((other) => other.toLowerCase() === value.toLowerCase())) return t("group.nameTaken")
}

const failed = (error: unknown) => toast({ kind: "error", title: t("error.request", { message: "MRK-6001" }), error })

/** What the sandbox status of a member needs: the folder it works in, the session it runs and its permission level. */
export type MemberSandbox = { directory: string; sessionID?: string; mode: string; busy: boolean }

function MemberForm(props: {
  member: GroupMember
  sandbox: MemberSandbox
  taken: readonly string[]
  onMessage: () => void
  onRemove?: () => void
}) {
  const [name, setName] = createSignal(props.member.name)
  const [busy, setBusy] = createSignal(false)
  const problem = () => (name().trim() === props.member.name ? undefined : nameProblem(name(), props.taken))
  const changed = () => name().trim() !== props.member.name
  const save = async () => {
    if (problem() || !changed() || busy()) return
    setBusy(true)
    try {
      await (
        await client()
      ).group.renameMember({ group: props.member.group, member: props.member.id, name: name().trim() })
    } catch (error) {
      failed(error)
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      class="member-form"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <label class="member-field">
        <span class="member-label">{t("group.seatName")}</span>
        <input
          class="input"
          aria-label={t("group.seatName")}
          value={name()}
          onInput={(event) => setName(event.currentTarget.value)}
        />
      </label>
      <div class="member-field">
        <SandboxStatus
          group={props.member.group}
          member={props.member.id}
          remote={props.member.remote}
          directory={props.sandbox.directory}
          sessionID={props.sandbox.sessionID}
          mode={props.sandbox.mode}
          busy={props.sandbox.busy}
        />
      </div>
      <Show when={props.member.summary}>
        <p class="subtle">{props.member.summary}</p>
      </Show>
      <Show when={name() && problem()}>
        <p class="member-problem" role="status">
          {problem()}
        </p>
      </Show>
      <div class="member-actions">
        <Show when={props.onRemove}>
          <button type="button" class="button ghost sm danger" onClick={() => props.onRemove?.()}>
            {t("group.remove")}
          </button>
        </Show>
        <button
          type="button"
          class="button secondary sm"
          aria-label={t("group.messageMember", { name: props.member.name })}
          onClick={props.onMessage}
        >
          {t("group.sendMessage")}
        </button>
        <span class="spacer" />
        <button type="submit" class="button primary sm" disabled={!changed() || !!problem() || busy()}>
          {t("group.save")}
        </button>
      </div>
    </form>
  )
}

/** Adds an agent of this machine to the group; the ones that are already in it are marked and cannot be added again. */
function AddMember(props: {
  group: string
  kind?: string
  members: readonly GroupMember[]
  open: boolean
  onClose: () => void
}) {
  const [agents, { refetch }] = createResource(
    () => props.open,
    async (open) =>
      open ? ((await (await client()).agent.list({})) ?? []).filter((agent) => agent.role === "worker") : [],
  )
  const [busy, setBusy] = createSignal("")
  const inGroup = (agent: AgentAgent) => props.members.some((member) => member.agent === agent.id)
  const add = async (agent: AgentAgent) => {
    setBusy(agent.id)
    try {
      await (
        await client()
      ).group.addMember({
        group: props.group,
        member: {
          id: "",
          group: props.group,
          kind: "agent",
          name: nameFor(agent.name, props.members),
          agentRole: "worker",
          agent: agent.id,
          owner: localHuman,
          status: "idle",
        },
      })
      toast({ kind: "success", title: t("group.joined", { names: agent.name }) })
      void refetch()
    } catch (error) {
      failed(error)
    } finally {
      setBusy("")
    }
  }
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => !open && props.onClose()}
      title={t("group.addMember")}
      footer={
        <button class="button secondary" onClick={props.onClose}>
          {t("common.close")}
        </button>
      }
    >
      <div class="dialog-body add-member">
        <For each={agents() ?? []}>
          {(agent) => (
            <article class="card agent-card" data-agent={agent.id}>
              <div class="row">
                <Avatar id={agent.id} name={agent.name} />
                <span class="member-text">
                  <strong class="ellipsis">{agent.name}</strong>
                  <span class="subtle ellipsis">{agent.summary}</span>
                </span>
                <span class="spacer" />
                <Show when={!inGroup(agent)} fallback={<span class="badge neutral">{t("group.alreadyIn")}</span>}>
                  <button
                    class="button secondary sm"
                    aria-label={t("profiles.add", { name: agent.name })}
                    disabled={!!busy()}
                    onClick={() => void add(agent)}
                  >
                    {t("common.add")}
                  </button>
                </Show>
              </div>
            </article>
          )}
        </For>
        <Show when={props.open && props.kind === "cloud"}>
          <CloudMembers group={props.group} />
        </Show>
        <Show when={props.open && props.kind !== "cloud"}>
          <RemoteMembers group={props.group} onAdded={() => void refetch()} />
        </Show>
      </div>
    </Dialog>
  )
}

/** The name of an agent as a member of a group: spaces become hyphens and @ is dropped, so people can @ it. */
export const memberName = (name: string, fallback: string) =>
  name.trim().replace(/@/gu, "").replace(/\s+/gu, "-") || fallback

/** A name for the group that is free: the agent's own, or with a number behind it. */
export function nameFor(name: string, members: readonly GroupMember[]) {
  const base = memberName(name, t("group.unknownMember"))
  const taken = new Set(members.map((member) => member.name.toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) if (!taken.has(`${base}${n}`.toLowerCase())) return `${base}${n}`
}

/** The members of a group: a row each opens its name and actions; the last row adds one. */
export function Roster(props: {
  group: string
  kind?: string
  members: readonly GroupMember[]
  busy: (member: GroupMember) => boolean
  sandbox: (member: GroupMember) => MemberSandbox
  leader: string
  open?: string
  onOpen: (id: string | undefined) => void
  onMessage: (member: GroupMember) => void
}) {
  const [removing, setRemoving] = createSignal<GroupMember>()
  const [adding, setAdding] = createSignal(false)
  const agents = createMemo(() => props.members.filter((member) => member.kind === "agent"))
  const admin = () =>
    props.members.some((member) => member.id === localHuman && (member.role === "owner" || member.role === "admin"))
  const remove = async () => {
    const member = removing()
    setRemoving(undefined)
    if (!member) return
    try {
      await (await client()).group.removeMember({ group: props.group, member: member.id })
    } catch (error) {
      failed(error)
    }
  }
  return (
    <section class="roster" aria-label={t("group.roster")}>
      <h3 class="members-subtitle">{t("group.roster")}</h3>
      <div class="member-list">
        <For each={agents()}>
          {(member) => (
            <div
              class="member"
              classList={{ open: props.open === member.id }}
              id={`member-${props.group}-${member.id}`}
              role="group"
              aria-label={t("group.member", { name: member.name })}
              data-state={props.busy(member) ? "busy" : "idle"}
            >
              <button
                class="member-row"
                aria-label={member.name}
                aria-expanded={props.open === member.id}
                onClick={() => props.onOpen(props.open === member.id ? undefined : member.id)}
              >
                <Avatar id={member.id} name={member.name} />
                <span class="member-text">
                  <span class="member-name">
                    <span class="ellipsis">{member.name}</span>
                    <Show when={member.id === props.leader}>
                      <span class="badge accent">{t("group.leader")}</span>
                    </Show>
                  </span>
                  <span class="member-meta subtle">{t(props.busy(member) ? "group.busy" : "group.idle")}</span>
                </span>
                <Show when={props.busy(member)}>
                  <span class="member-busy" />
                </Show>
              </button>
              <Show when={props.open === member.id}>
                <MemberForm
                  member={member}
                  sandbox={props.sandbox(member)}
                  taken={props.members.filter((other) => other.id !== member.id).map((other) => other.name)}
                  onMessage={() => props.onMessage(member)}
                  onRemove={admin() && member.id !== props.leader ? () => setRemoving(member) : undefined}
                />
              </Show>
            </div>
          )}
        </For>
        <Show when={admin()}>
          <button class="member-add" onClick={() => setAdding(true)}>
            <Plus class="icon icon-sm" />
            {t("group.addMember")}
          </button>
        </Show>
      </div>
      <AddMember
        group={props.group}
        kind={props.kind}
        members={props.members}
        open={adding()}
        onClose={() => setAdding(false)}
      />
      <Confirm
        open={!!removing()}
        title={t("group.removeTitle", { name: removing()?.name ?? "" })}
        description={t("group.removeDetail", { name: removing()?.name ?? "" })}
        confirm={t("group.remove")}
        cancel={t("common.cancel")}
        danger
        onResult={(ok) => (ok ? void remove() : setRemoving(undefined))}
      />
    </section>
  )
}
