import type { CollaborationRoleTemplate, CollaborationRoleTemplateChangeData } from "@merakcode/sdk/client"
import { createResource, createSignal, For, Show } from "solid-js"
import { t } from "../../i18n"
import { call, client } from "../../state/client"
import { toast } from "../../ui/toast"
import { Row, Section } from "./layout"

type TemplateChange = CollaborationRoleTemplateChangeData["body"]

export function RoleTemplateSettings(props: {
  templates: readonly CollaborationRoleTemplate[]
  onChange: (change: TemplateChange) => Promise<boolean>
}) {
  const [form, setForm] = createSignal<{ id: string; name: string; role: string; duty: string; editing?: boolean }>()
  const [busy, setBusy] = createSignal(false)
  const begin = (template?: CollaborationRoleTemplate) =>
    setForm({
      id: `custom-${crypto.randomUUID().slice(0, 8)}`,
      name: template?.name ?? "",
      role: template?.role ?? "",
      duty: template?.duty ?? "",
    })
  const save = async () => {
    const current = form()
    if (!current || busy() || !current.name.trim()) return
    setBusy(true)
    try {
      const ok = await props.onChange({
        type: current.editing ? "update" : "add",
        id: current.id,
        template: { name: current.name.trim(), role: current.role.trim(), duty: current.duty.trim() },
      })
      if (ok) setForm(undefined)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <div class="card">
        <For each={props.templates}>
          {(template) => (
            <Row label={template.name} desc={template.description ?? template.duty}>
              <Show when={template.builtin}>
                <span class="badge neutral">{t("settings.badge.builtin")}</span>
              </Show>
              <button class="button ghost sm" onClick={() => begin(template)}>
                {t("settings.collaboration.copyTemplate")}
              </button>
              <Show when={template.editable && !template.builtin}>
                <button
                  class="button ghost sm"
                  aria-label={t("settings.collaboration.edit", { name: template.name })}
                  onClick={() =>
                    setForm({
                      id: template.id,
                      name: template.name,
                      role: template.role,
                      duty: template.duty,
                      editing: true,
                    })
                  }
                >
                  {t("conversation.edit")}
                </button>
              </Show>
              <Show when={template.editable && !template.builtin}>
                <button
                  class="button ghost sm"
                  aria-label={t("settings.removeItem", { name: template.name })}
                  onClick={() => void props.onChange({ type: "remove", id: template.id })}
                >
                  {t("common.remove")}
                </button>
              </Show>
            </Row>
          )}
        </For>
      </div>
      <Show
        when={form()}
        fallback={
          <button class="button secondary" onClick={() => begin()}>
            {t("settings.collaboration.addTemplate")}
          </button>
        }
      >
        <form
          class="card form"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <label class="field">
            {t("group.name")}
            <input
              class="input"
              aria-label={t("group.name")}
              value={form()?.name ?? ""}
              onInput={(event) => setForm({ ...form()!, name: event.currentTarget.value })}
            />
          </label>
          <label class="field">
            {t("group.role")}
            <input
              class="input"
              aria-label={t("group.role")}
              value={form()?.role ?? ""}
              onInput={(event) => setForm({ ...form()!, role: event.currentTarget.value })}
            />
          </label>
          <label class="field">
            {t("group.duty")}
            <textarea
              class="input"
              aria-label={t("group.duty")}
              rows={5}
              value={form()?.duty ?? ""}
              onInput={(event) => setForm({ ...form()!, duty: event.currentTarget.value })}
            />
          </label>
          <div class="row end">
            <button type="button" class="button ghost" disabled={busy()} onClick={() => setForm(undefined)}>
              {t("common.cancel")}
            </button>
            <button type="submit" class="button primary" disabled={busy() || !form()?.name.trim()}>
              {t("common.save")}
            </button>
          </div>
        </form>
      </Show>
    </>
  )
}

export function Collaboration() {
  const [templates, { mutate }] = createResource(() => call(client().collaboration.roleTemplates()))
  return (
    <Section title={t("settings.collaboration")} lead={t("settings.collaboration.desc")}>
      <RoleTemplateSettings
        templates={templates() ?? []}
        onChange={(body) =>
          call(client().collaboration.roleTemplate.change({ body })).then(
            (list) => {
              mutate(list)
              return true
            },
            (error: Error) => {
              toast({ kind: "error", title: t("error.request", { message: error.message }), error })
              return false
            },
          )
        }
      />
    </Section>
  )
}
