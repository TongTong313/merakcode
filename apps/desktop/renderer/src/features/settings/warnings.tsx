import { For, Show } from "solid-js"
import type { ConfigWarning } from "@merakcode/sdk"
import { locale, t } from "../../i18n"
import { bridge } from "../../lib/bridge"
import { explain } from "../../state/error"
import { state } from "../../state/store"
import { Row } from "./layout"

/** What identifies a warning, so the same one is not announced twice. */
export const warningKey = (warning: ConfigWarning) => `${warning.file ?? ""}|${warning.path}|${warning.message}`

/** The warnings that have not been announced yet; they are added to seen. */
export function freshWarnings(warnings: readonly ConfigWarning[], seen: Set<string>) {
  const fresh = warnings.filter((warning) => !seen.has(warningKey(warning)))
  for (const warning of fresh) seen.add(warningKey(warning))
  return fresh
}

/** The entries of the configuration files that were skipped, with the file to open. */
export function ConfigWarnings() {
  const warnings = () => state.config?.warnings ?? []
  return (
    <Show when={warnings().length}>
      <div class="section-title">{t("settings.warnings")}</div>
      <div class="card">
        <For each={warnings()}>
          {(warning) => (
            <Row
              label={warning.path}
              desc={[explain(warning.code, locale())?.title ?? warning.message, warning.file]
                .filter(Boolean)
                .join(" · ")}
            >
              <Show when={warning.file}>
                <button class="button secondary sm" onClick={() => void bridge?.openPath(warning.file!)}>
                  {t("settings.warnings.open")}
                </button>
              </Show>
            </Row>
          )}
        </For>
      </div>
    </Show>
  )
}
