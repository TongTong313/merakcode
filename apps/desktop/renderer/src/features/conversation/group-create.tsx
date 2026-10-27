import type { CollaborationGroupSummary, CollaborationRoleTemplate } from "@merakcode/sdk/client"
import { createEffect, createSignal, on, Show } from "solid-js"
import { locale, t } from "../../i18n"
import { call, client } from "../../state/client"
import { Dialog } from "../../ui/dialog"
import { Select } from "../../ui/select"
import { toast } from "../../ui/toast"
import { copyGroup } from "./group-copy"
import { MemberList, type Product, type Seat } from "./members"
import { agentConnections, loadConnections, loadRoleTemplates, roleTemplates } from "../../state/agent-connections"

const leaderDraft = (): Seat => ({
  id: "leader",
  name: t("group.defaultLeader"),
  role: "",
  duty: t("group.defaultDuty"),
  product: "merak",
  leader: true,
  availability: { state: "online" },
})

/** New group: a name and its members, kept locally and sent in one request */
export function GroupCreate(props: {
  directory: string
  open: boolean
  onClose: () => void
  onCreated: (sessionID: string) => void
  /** Test seam: skip the SDK list/product calls and use these instead */
  products?: Product[]
  groups?: CollaborationGroupSummary[]
  roleTemplates?: CollaborationRoleTemplate[]
}) {
  const [title, setTitle] = createSignal("")
  const [seats, setSeats] = createSignal<Seat[]>([])
  const products = () => props.products ?? agentConnections()
  const [groups, setGroups] = createSignal<CollaborationGroupSummary[]>([])
  const [copied, setCopied] = createSignal<{ from: string; skipped: string[] }>()
  const [busy, setBusy] = createSignal(false)
  let added = 0
  let copyField: HTMLDivElement | undefined

  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return
        setTitle("")
        setSeats([leaderDraft()])
        setCopied(undefined)
        if (props.products && props.groups) {
          setGroups(props.groups)
          return
        }
        // Products may have changed since the last time: none are offered until they are checked again
        const failed = (error: Error) => toast({ kind: "error", title: t("error.request", { message: error.message }) })
        void loadConnections().catch(failed)
        void loadRoleTemplates().catch(failed)
        void call(client(props.directory).collaboration.list()).then(setGroups).catch(failed)
      },
    ),
  )

  /** Fills the form from an existing group; it is still edited and created as usual */
  const copy = (sessionID: string) => {
    const group = groups().find((item) => item.sessionID === sessionID)
    if (!group) return
    const result = copyGroup(group, products())
    setTitle(result.title)
    setSeats(result.seats)
    setCopied({ from: sessionID, skipped: result.skipped })
  }

  /** Back to the blank draft from when the dialog opened */
  const clear = () => {
    setTitle("")
    setSeats([leaderDraft()])
    setCopied(undefined)
    queueMicrotask(() => copyField?.querySelector<HTMLButtonElement>("button[aria-haspopup]")?.focus())
  }

  const create = async () => {
    const [leader, ...rest] = seats()
    if (!leader) return
    setBusy(true)
    try {
      const created = await call(
        client(props.directory).collaboration.create({
          title: title().trim() || undefined,
          leader: { name: leader.name, role: leader.role, duty: leader.duty },
          seats: rest.map((seat) => ({ name: seat.name, role: seat.role, duty: seat.duty, product: seat.product })),
        }),
      )
      props.onCreated(created.sessionID)
      props.onClose()
    } catch (error) {
      toast({ kind: "error", title: t("error.request", { message: (error as Error).message }) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => !open && props.onClose()}
      title={t("group.title")}
      description={t("group.lead")}
      class="group-create"
      footer={
        <>
          <button class="button secondary" onClick={props.onClose}>
            {t("common.cancel")}
          </button>
          <button class="button primary" disabled={busy()} onClick={() => void create()}>
            {t("group.create")}
          </button>
        </>
      }
    >
      <div class="dialog-body form">
        {/* Offered once the products are in, since they decide which members can be copied */}
        <Show when={groups().length && products().length}>
          <div class="field" ref={copyField}>
            <span>{t("group.copyFrom")}</span>
            <div class="row">
              <Select
                class="chip outlined"
                label={t("group.copyFrom")}
                placeholder={t("group.copyFromPlaceholder")}
                value={copied()?.from}
                onChange={copy}
                options={groups().map((group) => ({
                  value: group.sessionID,
                  label: group.title,
                  description: group.directory,
                }))}
              />
              <Show when={copied()}>
                <button type="button" class="button ghost sm" title={t("group.copyClearTitle")} onClick={clear}>
                  {t("group.copyClear")}
                </button>
              </Show>
            </div>
          </div>
          <Show when={copied()?.skipped.length}>
            <p class="subtle group-copy-skipped" role="status">
              {t("group.copySkipped", { names: copied()!.skipped.join(locale() === "zh" ? "、" : ", ") })}
            </p>
          </Show>
        </Show>
        <label class="field">
          <span>{t("group.name")}</span>
          <input
            class="input"
            placeholder={t("group.namePlaceholder")}
            value={title()}
            onInput={(event) => setTitle(event.currentTarget.value)}
          />
        </label>
        <MemberList
          seats={seats()}
          products={products()}
          roleTemplates={props.roleTemplates ?? roleTemplates()}
          onSave={(seat, draft) =>
            setSeats((list) =>
              list.map((item) =>
                item.id === seat.id ? { ...item, name: draft.name, role: draft.role, duty: draft.duty } : item,
              ),
            )
          }
          onAdd={(draft) =>
            setSeats((list) => [
              ...list,
              { ...draft, id: `new-${++added}`, leader: false, availability: { state: "online" } },
            ])
          }
          onRemove={(seat) => setSeats((list) => list.filter((item) => item.id !== seat.id))}
        />
      </div>
    </Dialog>
  )
}
