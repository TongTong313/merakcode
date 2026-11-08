import type { GroupGroup, ProfileProfile, WorkerProductInfo } from "@merakcode/sdk"
import { createEffect, createSignal, For, on, Show } from "solid-js"
import { t } from "../../i18n"
import { bridge } from "../../lib/bridge"
import { client } from "../../state/client"
import { choice } from "../../state/models"
import { localHuman } from "../../state/groups"
import { Dialog } from "../../ui/dialog"
import { Select } from "../../ui/select"
import { toast } from "../../ui/toast"

export function GroupCreate(props: {
  directory: string
  open: boolean
  onClose: () => void
  onCreated: (group: GroupGroup) => void
}) {
  const [name, setName] = createSignal("")
  const [directory, setDirectory] = createSignal(props.directory)
  const [profiles, setProfiles] = createSignal<ProfileProfile[]>([])
  const [products, setProducts] = createSignal<WorkerProductInfo[]>([])
  const [leader, setLeader] = createSignal("builtin-leader")
  const [workers, setWorkers] = createSignal<string[]>([])
  const [busy, setBusy] = createSignal(false)
  const [loading, setLoading] = createSignal(true)
  const [created, setCreated] = createSignal<GroupGroup>()
  const added = new Set<string>()
  const fail = (error: unknown) => toast({ kind: "error", title: t("error.request", { message: "MRK-6001" }), error })
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return
        setCreated(undefined)
        setLeader("builtin-leader")
        added.clear()
        setName("")
        setDirectory(props.directory)
        setWorkers([])
        setLoading(true)
        void client()
          .then(async (connection) => {
            const [list, catalog] = await Promise.all([
              connection.profile.list({ human: localHuman }),
              connection.member.catalog(),
            ])
            setProfiles(list ?? [])
            setProducts(catalog ?? [])
          })
          .catch(fail)
          .finally(() => setLoading(false))
      },
    ),
  )
  const choices = () => [
    ...profiles().filter((profile) => profile.role === "worker"),
    ...products()
      .filter((product) => product.kind !== "builtin" && product.available)
      .map((product): ProfileProfile => ({
        id: `product:${product.kind}`,
        name: product.name,
        role: "worker",
        summary: "Implement and verify assigned work.",
        duties: "",
        model: { provider: "", model: "" },
        toolPool: "worker.default",
        product: { kind: product.kind, binary: product.binary ?? "" },
      })),
  ]
  const selectedLeader = () => profiles().find((profile) => profile.id === leader())
  const model = () => choice(undefined, directory()).model
  const ready = () =>
    !!directory().trim() &&
    !!selectedLeader() &&
    !!(selectedLeader()?.model.provider || model()) &&
    !loading() &&
    !busy()
  const save = async (profile: ProfileProfile) => {
    if (!profile.id.startsWith("builtin-") && !profile.id.startsWith("product:")) return profile
    const selected = model()
    return (await client()).profile.save({
      human: localHuman,
      profile: {
        ...profile,
        id: "",
        model: profile.product
          ? profile.model
          : { provider: selected?.providerID ?? "", model: selected?.modelID ?? "" },
      },
    })
  }
  const create = async () => {
    if (!ready()) return
    setBusy(true)
    try {
      const connection = await client()
      if (!created()) {
        const profile = await save(selectedLeader()!)
        const id = crypto.randomUUID()
        setCreated(
          await connection.group.create({
            id: "",
            kind: "local",
            name: name().trim() || t("group.title"),
            project: { directory: directory().trim() },
            defaultLeader: id,
            members: [
              { id: localHuman, group: "", kind: "human", name: t("group.you"), role: "owner", status: "idle" },
              {
                id,
                group: "",
                kind: "agent",
                name: profile.name,
                agentRole: "leader",
                profile: profile.id,
                owner: localHuman,
                status: "idle",
              },
            ],
            profiles: [],
          }),
        )
      }
      for (const id of workers()) {
        if (added.has(id)) continue
        const draft = choices().find((profile) => profile.id === id)
        if (!draft) continue
        const profile = await save(draft)
        await connection.group.addMember({
          group: created()!.id,
          member: {
            id: crypto.randomUUID(),
            group: created()!.id,
            kind: "agent",
            name: profile.name,
            agentRole: "worker",
            profile: profile.id,
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
  const pick = async () => {
    const value = await bridge?.openDirectoryPicker({ title: t("sidebar.openProject") })
    const picked = Array.isArray(value) ? value[0] : value
    if (picked) setDirectory(picked)
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
        <label class="field">
          <span>{t("group.name")}</span>
          <input
            class="input"
            aria-label={t("group.name")}
            disabled={busy() || !!created()}
            value={name()}
            onInput={(event) => setName(event.currentTarget.value)}
          />
        </label>
        <label class="field">
          <span>{t("group.directory")}</span>
          <input
            class="input"
            aria-label={t("group.directory")}
            disabled={busy() || !!created()}
            value={directory()}
            onInput={(event) => setDirectory(event.currentTarget.value)}
          />
        </label>
        <button class="button secondary" disabled={busy() || !!created()} onClick={() => void pick().catch(fail)}>
          {t("sidebar.openProject")}
        </button>
        <Show when={loading()}>
          <p role="status">{t("group.checking")}</p>
        </Show>
        <Select
          label={t("group.leader")}
          disabled={busy() || !!created()}
          value={leader()}
          options={profiles()
            .filter((profile) => profile.role === "leader" && !profile.product)
            .map((profile) => ({ value: profile.id, label: profile.name }))}
          onChange={setLeader}
        />
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
        <Show when={!loading() && !selectedLeader()?.model.provider && !model()}>
          <p role="status">{t("group.modelRequired")}</p>
        </Show>
      </div>
    </Dialog>
  )
}
