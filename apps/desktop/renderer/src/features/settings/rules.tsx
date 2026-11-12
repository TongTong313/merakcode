import Pencil from "lucide-solid/icons/pencil"
import Trash2 from "lucide-solid/icons/trash"
import { createResource, createSignal, For, Show } from "solid-js"
import type { ProtocolRuleView } from "@merakcode/sdk"
import { t } from "../../i18n"
import { client } from "../../state/client"
import { state } from "../../state/store"
import { toast } from "../../ui/toast"
import { Row, Section } from "./layout"
import { kindKey, newRuleBody, ruleName } from "./rules-input"

const fail = (error: Error) => toast({ kind: "error", title: t("error.request", { message: error.message }), error })
const project = () => state.folders[0]?.directory
const base = (path: string) => path.split(/[\\/]/).pop() ?? path

/** Rule editor; the caller closes it after a successful save. */
function RuleEditor(props: {
  label: string
  text: string
  rows: number
  onSave: (text: string) => void
  onCancel: () => void
}) {
  const [text, setText] = createSignal(props.text)
  return (
    <div class="setting-row rule-editor">
      <textarea
        class="input mono"
        rows={props.rows}
        aria-label={props.label}
        value={text()}
        onInput={(event) => setText(event.currentTarget.value)}
        autofocus
      />
      <div class="row end">
        <button class="button ghost sm" onClick={() => props.onCancel()}>
          {t("common.cancel")}
        </button>
        <button class="button primary sm" disabled={!text().trim()} onClick={() => props.onSave(text())}>
          {t("common.save")}
        </button>
      </div>
    </div>
  )
}

export function Rules() {
  const [snapshot, { refetch }] = createResource(() =>
    client().then((connection) => connection.rules.read({ directory: project() })),
  )
  const personal = () => snapshot()?.personal ?? []
  const files = () => snapshot()?.rules ?? []
  const [draft, setDraft] = createSignal("")
  const [filename, setFilename] = createSignal("")
  /** Entry being edited: user:<index> for a personal rule, the rule's name for a rule file. */
  const [editing, setEditing] = createSignal<string>()
  const change = async (params: Parameters<Awaited<ReturnType<typeof client>>["rules"]["change"]>[0]) => {
    try {
      await (await client()).rules.change({ directory: project(), ...params })
      await refetch()
      return true
    } catch (error) {
      fail(error as Error)
      return false
    }
  }
  const replacePersonal = (next: string[]) => change({ personal: next })
  const save = async (done: Promise<boolean>) => {
    if (await done) setEditing(undefined)
  }
  const add = async () => {
    if (await replacePersonal([...personal(), draft().trim()])) setDraft("")
  }
  /** A new rule file opens for editing right away. */
  const create = async () => {
    const name = ruleName(filename())
    if (!name) return fail(new Error("MRK-3001"))
    if (!(await change({ file: { name, body: newRuleBody() } }))) return
    setFilename("")
    setEditing(name)
  }
  return (
    <Section title={t("settings.rules")} lead={t("settings.rules.desc")}>
      <div class="section-title">{t("settings.rules.user")}</div>
      <div class="card">
        <For each={personal()}>
          {(rule, index) => {
            const key = `user:${index()}`
            const name = () => t("settings.rules.userItem", { n: index() + 1 })
            return (
              <Show
                when={editing() === key}
                fallback={
                  <div class="setting-row">
                    <div class="grow rule-text">{rule}</div>
                    <button
                      class="icon-button"
                      aria-label={t("settings.editItem", { name: name() })}
                      onClick={() => setEditing(key)}
                    >
                      <Pencil class="icon icon-sm" />
                    </button>
                    <button
                      class="icon-button"
                      aria-label={t("settings.removeItem", { name: name() })}
                      onClick={() => void replacePersonal(personal().filter((_, at) => at !== index()))}
                    >
                      <Trash2 class="icon icon-sm" />
                    </button>
                  </div>
                }
              >
                <RuleEditor
                  label={name()}
                  text={rule}
                  rows={3}
                  onSave={(text) =>
                    void save(replacePersonal(personal().map((item, at) => (at === index() ? text.trim() : item))))
                  }
                  onCancel={() => setEditing(undefined)}
                />
              </Show>
            )
          }}
        </For>
        <div class="setting-row">
          <textarea
            class="input grow"
            rows={2}
            aria-label={t("settings.rules.new")}
            placeholder={t("settings.rules.newPlaceholder")}
            value={draft()}
            onInput={(event) => setDraft(event.currentTarget.value)}
          />
          <button class="button primary" disabled={!draft().trim()} onClick={() => void add()}>
            {t("common.add")}
          </button>
        </div>
      </div>
      <div class="section-title">{t("settings.rules.project")}</div>
      <div class="card">
        <Show when={snapshot()?.instructions}>
          <Row label="AGENTS.md" desc={t("settings.rules.always")}>
            {null}
          </Row>
        </Show>
        <For each={files()}>
          {(file: ProtocolRuleView) => (
            <Show
              when={editing() === file.name}
              fallback={
                <div class="setting-row">
                  <div class="grow">
                    <div class="label mono">{base(file.path)}</div>
                    <div class="desc">
                      {[kindKey(file.kind) ? t(kindKey(file.kind)!) : undefined, file.description]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  </div>
                  <Show when={!file.truncated}>
                    <button
                      class="icon-button"
                      aria-label={t("settings.editItem", { name: base(file.path) })}
                      onClick={() => setEditing(file.name)}
                    >
                      <Pencil class="icon icon-sm" />
                    </button>
                  </Show>
                  <button
                    class="icon-button"
                    aria-label={t("settings.removeItem", { name: base(file.path) })}
                    onClick={() => void change({ file: { name: file.name } })}
                  >
                    <Trash2 class="icon icon-sm" />
                  </button>
                </div>
              }
            >
              <RuleEditor
                label={base(file.path)}
                text={file.body}
                rows={12}
                onSave={(body) => void save(change({ file: { name: file.name, body } }))}
                onCancel={() => setEditing(undefined)}
              />
            </Show>
          )}
        </For>
        <div class="setting-row">
          <input
            class="input grow mono"
            aria-label={t("settings.rules.filename")}
            placeholder={t("settings.rules.filenamePlaceholder")}
            value={filename()}
            onInput={(event) => setFilename(event.currentTarget.value)}
            onKeyDown={(event) => event.key === "Enter" && filename().trim() && void create()}
          />
          <button class="button secondary" disabled={!filename().trim()} onClick={() => void create()}>
            {t("settings.rules.create")}
          </button>
        </div>
      </div>
    </Section>
  )
}
