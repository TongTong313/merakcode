import type { GroupGroup, GroupMember } from "@merakcode/sdk"
import { createSignal, For } from "solid-js"
import { z } from "zod"
import { t } from "../../i18n"
import { client } from "../../state/client"
import { localHuman } from "../../state/groups"
import { toast } from "../../ui/toast"

const inputSchema = z.object({
  title: z.string().trim().min(1),
  description: z.string(),
  acceptance: z.array(z.string().min(1)),
  review: z.boolean(),
})

export function CreateTask(props: { group: GroupGroup; members: GroupMember[]; onCreated: () => void }) {
  const [title, setTitle] = createSignal("")
  const [description, setDescription] = createSignal("")
  const [acceptance, setAcceptance] = createSignal("")
  const [review, setReview] = createSignal(true)
  const [assignee, setAssignee] = createSignal(props.group.defaultLeader)
  const [busy, setBusy] = createSignal(false)
  const member = () => props.members.find((member) => member.id === assignee() && member.kind === "agent")
  const create = async () => {
    if (busy() || !member() || !title().trim()) return
    setBusy(true)
    try {
      const input = inputSchema.parse({
        title: title(),
        description: description(),
        acceptance: acceptance()
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
        review: review(),
      })
      await (
        await client()
      ).task.create({
        ...input,
        group: props.group.id,
        human: localHuman,
        ...(member()!.agentRole === "worker" ? { member: assignee() } : { leader: assignee() }),
      })
      props.onCreated()
    } catch (error) {
      toast({ kind: "error", title: t("error.request", { message: "MRK-6001" }), error })
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      class="dialog-body task-create"
      onSubmit={(event) => {
        event.preventDefault()
        void create()
      }}
    >
      <label>
        {t("task.title")}
        <input
          class="input"
          aria-label={t("task.title")}
          value={title()}
          onInput={(event) => setTitle(event.currentTarget.value)}
          disabled={busy()}
          required
        />
      </label>
      <label>
        {t("task.description")}
        <textarea
          class="input"
          aria-label={t("task.description")}
          value={description()}
          onInput={(event) => setDescription(event.currentTarget.value)}
          disabled={busy()}
          rows={3}
        />
      </label>
      <label>
        {t("task.acceptance")}
        <textarea
          class="input"
          aria-label={t("task.acceptance")}
          value={acceptance()}
          onInput={(event) => setAcceptance(event.currentTarget.value)}
          disabled={busy()}
          rows={3}
        />
      </label>
      <label>
        {t("task.assignee")}
        <select
          class="input"
          aria-label={t("task.assignee")}
          value={assignee()}
          onChange={(event) => setAssignee(event.currentTarget.value)}
          disabled={busy()}
        >
          <For each={props.members.filter((member) => member.kind === "agent")}>
            {(member) => <option value={member.id}>{member.name}</option>}
          </For>
        </select>
      </label>
      <label class="row">
        <input
          type="checkbox"
          aria-label={t("task.requireReview")}
          checked={review()}
          onChange={(event) => setReview(event.currentTarget.checked)}
          disabled={busy()}
        />
        {t("task.requireReview")}
      </label>
      <button class="button primary" type="submit" disabled={busy() || !title().trim() || !member()}>
        {t("task.create")}
      </button>
    </form>
  )
}
