import Eye from "lucide-solid/icons/eye"
import Trash2 from "lucide-solid/icons/trash"
import { createResource, createSignal, For, Show } from "solid-js"
import type { MemoryNote } from "@merakcode/sdk"
import { t } from "../../i18n"
import { client } from "../../state/client"
import { state, updateConfig } from "../../state/store"
import { Switch } from "../../ui/switch"
import { toast } from "../../ui/toast"
import { Row, Section } from "./layout"
import { kindKey, noteTitle } from "./memory-view"

const fail = (error: Error) => toast({ kind: "error", title: t("error.request", { message: error.message }), error })
const project = () => state.folders[0]?.directory

export function Memory() {
  const [notes, { refetch }] = createResource(async () =>
    ((await (await client()).memory.list({ directory: project() })) ?? []).toSorted((a, b) =>
      b.created.localeCompare(a.created),
    ),
  )
  const [open, setOpen] = createSignal<MemoryNote>()
  const view = async (note: MemoryNote) => {
    if (open()?.id === note.id) return setOpen(undefined)
    setOpen(await (await client()).memory.read({ id: note.id }))
  }
  const remove = async (note: MemoryNote) => {
    try {
      await (await client()).memory.delete({ id: note.id })
      if (open()?.id === note.id) setOpen(undefined)
      await refetch()
    } catch (error) {
      fail(error as Error)
    }
  }
  return (
    <Section title={t("settings.memory")} lead={t("settings.memory.desc")}>
      <div class="card">
        <Row label={t("settings.memory.auto")} desc={t("settings.memory.autoDesc")}>
          <Switch
            label={t("settings.memory.auto")}
            hideLabel
            checked={!!state.config?.memory?.autoExtract}
            onChange={(on) => void updateConfig({ memory: { autoExtract: on } }).catch(fail)}
          />
        </Row>
      </div>
      <div class="card">
        <For each={notes() ?? []} fallback={<div class="setting-row subtle">{t("settings.memory.empty")}</div>}>
          {(note) => {
            const name = noteTitle(note.text)
            return (
              <>
                <div class="setting-row">
                  <div class="grow">
                    <div class="label">{name}</div>
                  </div>
                  <Show when={kindKey(note.kind)}>{(key) => <span class="badge neutral">{t(key())}</span>}</Show>
                  <button
                    class="icon-button"
                    aria-label={t("settings.memory.view", { name })}
                    aria-expanded={open()?.id === note.id}
                    onClick={() => void view(note).catch(fail)}
                  >
                    <Eye class="icon icon-sm" />
                  </button>
                  <button
                    class="icon-button"
                    aria-label={t("settings.removeItem", { name })}
                    onClick={() => void remove(note)}
                  >
                    <Trash2 class="icon icon-sm" />
                  </button>
                </div>
                <Show when={open()?.id === note.id}>
                  <pre class="memory-body selectable">{open()?.text}</pre>
                </Show>
              </>
            )
          }}
        </For>
      </div>
    </Section>
  )
}
