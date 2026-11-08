import type { TaskReport } from "@merakcode/sdk"
import { For, Show } from "solid-js"
import { t } from "../../i18n"
import { Markdown } from "../../ui/markdown"

export function Report(props: { report: TaskReport }) {
  const verdict = () => {
    switch (props.report.verdict) {
      case "done":
        return t("task.report.done")
      case "blocked":
        return t("task.report.blocked")
      case "needs_review":
        return t("task.report.needsReview")
      default:
        return t("task.report.failed")
    }
  }
  return (
    <section class="task-report" aria-label={t("task.report.title")}>
      <h3>{verdict()}</h3>
      <Show when={props.report.synthesized}>
        <p class="subtle">{t("task.report.synthesized")}</p>
      </Show>
      <Markdown text={props.report.summary} />
      <Show when={props.report.changes?.length}>
        <table aria-label={t("task.report.changes")}>
          <thead>
            <tr>
              <th>{t("task.report.path")}</th>
              <th>{t("task.report.kind")}</th>
              <th>{t("task.report.lines")}</th>
            </tr>
          </thead>
          <tbody>
            <For each={props.report.changes}>
              {(change) => (
                <tr>
                  <td class="mono">{change.path}</td>
                  <td>{change.kind}</td>
                  <td>
                    <span class="add">+{change.added}</span> <span class="del">−{change.removed}</span>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>
      <Show when={props.report.checks?.length}>
        <h4>{t("task.report.checks")}</h4>
        <ul>
          <For each={props.report.checks}>
            {(check) => (
              <li>
                <code>{check.command}</code> — {t("task.report.exit", { code: check.exitCode })}
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={props.report.artifacts?.length}>
        <h4>{t("task.report.artifacts")}</h4>
        <ul>
          <For each={props.report.artifacts}>
            {(artifact) => (
              <li>
                {artifact.title} <code>{artifact.path}</code>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={props.report.questions?.length}>
        <h4>{t("task.report.questions")}</h4>
        <ul>
          <For each={props.report.questions}>{(question) => <li>{question}</li>}</For>
        </ul>
      </Show>
      <Show when={props.report.next?.length}>
        <h4>{t("task.report.next")}</h4>
        <ul>
          <For each={props.report.next}>{(step) => <li>{step}</li>}</For>
        </ul>
      </Show>
      <p class="subtle">
        {t("task.report.tokens", { input: props.report.usage.input, output: props.report.usage.output })}
      </p>
      <p class="subtle">
        {props.report.usage.costKnown
          ? `${props.report.usage.cost} ${props.report.usage.currency ?? ""}`
          : t("task.report.unknownCost")}
      </p>
    </section>
  )
}
