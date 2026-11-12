import { createSignal, For, Show } from "solid-js"
import type { GroupGroup, TaskCard } from "@merakcode/sdk"
import { t } from "../../i18n"
import { baseName } from "../../lib/route"
import { client } from "../../state/client"
import { groups, groupView } from "../../state/groups"
import { Dialog } from "../../ui/dialog"
import { toast } from "../../ui/toast"
import { groupChoice } from "./bind"
import { emptyBoard } from "@merakcode/sdk"

/** Gives a task that has no group to one of the groups: every group is listed, with what picking it would do. */
export function ChooseGroup(props: {
  task: TaskCard
  open: boolean
  onClose: () => void
  onBound: (group: GroupGroup) => void
}) {
  const [busy, setBusy] = createSignal("")
  const pick = async (group: GroupGroup) => {
    setBusy(group.id)
    try {
      await (await client()).group.bind({ group: group.id, task: props.task.id })
      props.onBound(group)
      props.onClose()
    } catch (error) {
      toast({ kind: "error", title: t("error.request", { message: "MRK-6001" }), error })
    } finally {
      setBusy("")
    }
  }
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => !open && props.onClose()}
      title={t("task.chooseTitle")}
      description={t("task.chooseLead")}
      footer={
        <button class="button secondary" onClick={props.onClose}>
          {t("common.cancel")}
        </button>
      }
    >
      <div class="dialog-body choose-group">
        <Show when={groups().length} fallback={<p class="subtle">{t("task.chooseEmpty")}</p>}>
          <For each={groups().filter((group) => !group.archived)}>
            {(group) => {
              const choice = () => groupChoice(props.task.project, group, groupView(group.id)?.board ?? emptyBoard())
              return (
                <article
                  class="card choose-row"
                  classList={{ busy: choice().busy }}
                  data-group={group.id}
                  data-busy={choice().busy}
                >
                  <div class="row">
                    <span class="member-text">
                      <strong class="ellipsis">{group.name}</strong>
                      <span class="subtle ellipsis" title={group.project.directory}>
                        {baseName(group.project.directory)}
                      </span>
                    </span>
                    <span class="spacer" />
                    <button
                      class="button secondary sm"
                      aria-label={t("task.choose")}
                      disabled={choice().busy || !!busy()}
                      onClick={() => void pick(group)}
                    >
                      {t("task.choose")}
                    </button>
                  </div>
                  <Show when={choice().moves}>
                    <p class="subtle">{t("task.chooseMove")}</p>
                  </Show>
                  <Show when={choice().busy}>
                    <p class="subtle">{t("task.chooseBusy")}</p>
                  </Show>
                </article>
              )
            }}
          </For>
        </Show>
      </div>
    </Dialog>
  )
}
