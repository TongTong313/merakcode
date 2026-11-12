import type { TaskCard } from "@merakcode/sdk"
import { createEffect, createSignal, on } from "solid-js"
import { z } from "zod"
import { t } from "../../i18n"
import { client } from "../../state/client"
import { Dialog } from "../../ui/dialog"
import { Switch } from "../../ui/switch"
import { toast } from "../../ui/toast"
import { WorkspacePicker } from "../shell/workspace-picker"

const inputSchema = z.object({
  title: z.string().trim().min(1),
  description: z.string(),
  acceptance: z.array(z.string().min(1)),
  review: z.boolean(),
  project: z.string().min(1),
})

/** A task of its own: a workspace, a title, a description, acceptance criteria and whether it needs a review. */
export function TaskCreate(props: {
  /** The workspace the form starts with */
  directory?: string
  open: boolean
  onClose: () => void
  onCreated: (task: TaskCard) => void
}) {
  const [title, setTitle] = createSignal("")
  const [description, setDescription] = createSignal("")
  const [acceptance, setAcceptance] = createSignal("")
  const [review, setReview] = createSignal(true)
  const [directory, setDirectory] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return
        setTitle("")
        setDescription("")
        setAcceptance("")
        setReview(true)
        setDirectory(props.directory ?? "")
      },
    ),
  )
  const ready = () => !!title().trim() && !!directory() && !busy()
  const create = async () => {
    if (!ready()) return
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
        project: directory(),
      })
      const card = await (await client()).task.create(input)
      props.onCreated(card)
      props.onClose()
    } catch (error) {
      toast({ kind: "error", title: t("error.request", { message: "MRK-6001" }), error })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => !open && props.onClose()}
      title={t("taskCreate.title")}
      description={t("taskCreate.lead")}
      class="task-create-dialog"
      footer={
        <>
          <button class="button secondary" disabled={busy()} onClick={props.onClose}>
            {t("common.cancel")}
          </button>
          <button class="button primary" disabled={!ready()} onClick={() => void create()}>
            {t("taskCreate.submit")}
          </button>
        </>
      }
    >
      <form
        class="dialog-body form"
        onSubmit={(event) => {
          event.preventDefault()
          void create()
        }}
      >
        <WorkspacePicker value={directory()} onChange={setDirectory} disabled={busy()} />
        <label class="field">
          <span>{t("task.title")}</span>
          <input
            class="input"
            aria-label={t("task.title")}
            value={title()}
            disabled={busy()}
            onInput={(event) => setTitle(event.currentTarget.value)}
          />
        </label>
        <label class="field">
          <span>{t("task.description")}</span>
          <textarea
            class="input"
            aria-label={t("task.description")}
            rows={3}
            value={description()}
            disabled={busy()}
            onInput={(event) => setDescription(event.currentTarget.value)}
          />
        </label>
        <label class="field">
          <span>{t("task.acceptance")}</span>
          <textarea
            class="input"
            aria-label={t("task.acceptance")}
            rows={3}
            value={acceptance()}
            disabled={busy()}
            onInput={(event) => setAcceptance(event.currentTarget.value)}
          />
        </label>
        <Switch label={t("task.requireReview")} checked={review()} disabled={busy()} onChange={setReview} />
      </form>
    </Dialog>
  )
}
