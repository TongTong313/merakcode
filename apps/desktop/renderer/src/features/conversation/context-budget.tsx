import type { WindowReport } from "@merakcode/sdk"
import { For } from "solid-js"
import { t } from "../../i18n"

export function ContextBudget(props: { report: WindowReport }) {
  const segments = () => [
    { key: "system", label: t("context.system"), value: props.report.system },
    { key: "tools", label: t("context.tools"), value: props.report.tools },
    { key: "messages", label: t("context.messages"), value: props.report.messages },
    { key: "reserve", label: t("context.reserve"), value: props.report.reserve },
    {
      key: "free",
      label: t("context.free"),
      value: Math.max(0, props.report.window - props.report.total),
    },
  ]
  return (
    <details class="context-budget">
      <summary>
        {t("context.title")} · {props.report.total} / {props.report.window}
      </summary>
      <div
        class="context-bar"
        role="meter"
        aria-label={t("context.title")}
        aria-valuemin={0}
        aria-valuenow={Math.min(props.report.total, props.report.window)}
        aria-valuemax={props.report.window}
      >
        <For each={segments()}>
          {(segment) => (
            <span
              data-segment={segment.key}
              title={`${segment.label}: ${segment.value}`}
              style={{ "flex-grow": Math.max(0, segment.value) }}
            />
          )}
        </For>
      </div>
      <ul>
        <For each={segments()}>
          {(segment) => (
            <li>
              {segment.label}: {segment.value}
            </li>
          )}
        </For>
      </ul>
      <p>
        {t("usage.cacheRead")}: {props.report.cacheRead} · {t("usage.cacheWrite")}: {props.report.cacheWrite}
      </p>
    </details>
  )
}
