import { ProtocolImportResultSchema, type ProtocolImportCounts } from "@merakcode/sdk"
import { For, Show } from "solid-js"
import { locale, t, type Key } from "../../i18n"
import { explain } from "../../state/error"
import { importProgress } from "../../state/import"

const classes: Record<keyof ProtocolImportCounts, Key> = {
  sessions: "import.class.sessions",
  messages: "import.class.messages",
  groups: "import.class.groups",
  agents: "import.class.agents",
  roles: "import.class.roles",
  plans: "import.class.plans",
  memories: "import.class.memories",
  todos: "import.class.todos",
  blobs: "import.class.blobs",
}

const kinds: Record<string, Key> = {
  session: "import.kind.session",
  plan: "import.kind.plan",
  memory: "import.kind.memory",
  group: "import.kind.group",
  todo: "import.kind.todo",
  config: "import.kind.config",
  agent: "import.kind.agent",
  role: "import.kind.role",
}

/** The notice the engine sends when an import ends: counts per kind, what was skipped and why, hand-written adapters. */
export function describeImport(text: string, count: number) {
  const parsed = (() => {
    try {
      return ProtocolImportResultSchema.safeParse(JSON.parse(text))
    } catch {
      return undefined
    }
  })()
  if (!parsed?.success) return
  const skipped = (parsed.data.skipped ?? []).map(({ kind, id, code, reason }) => ({ kind, id, code, reason }))
  return {
    counts: (Object.keys(classes) as (keyof ProtocolImportCounts)[])
      .map((kind) => ({ kind, count: parsed.data.imported[kind] }))
      .filter((entry) => entry.count > 0),
    skipped,
    // The notice lists only the first skipped items; its count says how many there were
    hidden: Math.max(0, count - skipped.length),
    adapters: parsed.data.adapters ?? [],
  }
}

/** The finished import in the inbox: what came in, then what was left out with the title of each cause. */
export function ImportSummary(props: { text: string; count: number }) {
  const summary = () => describeImport(props.text, props.count)
  return (
    <Show when={summary()} fallback={<p>{props.text}</p>}>
      {(done) => (
        <div class="import-summary">
          <p>
            <Show when={done().counts.length} fallback={t("import.nothing")}>
              {t("import.imported")}
              {": "}
              {done()
                .counts.map((entry) => `${t(classes[entry.kind])} ${entry.count}`)
                .join(t("import.separator"))}
            </Show>
          </p>
          <Show when={done().skipped.length || done().hidden}>
            <details>
              <summary>{t("import.skipped", { count: done().skipped.length + done().hidden })}</summary>
              <ul>
                <For each={done().skipped}>
                  {(item) => (
                    <li>
                      <span>{t(kinds[item.kind] ?? "import.kind.other")}</span> <code>{item.id}</code>
                      {" · "}
                      <span>{explain(item.code, locale())?.title ?? item.code}</span>
                      {" · "}
                      <span class="subtle">{item.code}</span>
                    </li>
                  )}
                </For>
              </ul>
              <Show when={done().hidden}>
                <p class="subtle">{t("import.hidden", { count: done().hidden })}</p>
              </Show>
            </details>
          </Show>
          <Show when={done().adapters.length}>
            <p class="subtle">{t("import.adapters", { names: done().adapters.join(", ") })}</p>
          </Show>
        </div>
      )}
    </Show>
  )
}

/** A bar over the home page while the engine imports the data of an earlier version. */
export function ImportBar() {
  return (
    <Show when={importProgress().running}>
      <section class="import-bar" aria-label={t("import.title")}>
        <div class="row">
          <span>{t("import.running")}</span>
          <span class="spacer" />
          <span class="subtle">
            {t("import.count", { done: importProgress().done, total: importProgress().total })}
          </span>
        </div>
        <div
          class="progress"
          role="progressbar"
          aria-label={t("import.title")}
          aria-valuemin={0}
          aria-valuemax={importProgress().total}
          aria-valuenow={importProgress().done}
        >
          <span style={{ width: `${(100 * importProgress().done) / Math.max(1, importProgress().total)}%` }} />
        </div>
      </section>
    </Show>
  )
}
