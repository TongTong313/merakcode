import { foldGroupUsage, type EngineEvent, type GroupMember, type TaskCard } from "@merakcode/sdk"
import { createMemo, For, Show } from "solid-js"
import { t } from "../../i18n"
import { ContextBudget } from "../conversation/context-budget"

export function GroupUsage(props: { events: EngineEvent[]; members: GroupMember[]; tasks: TaskCard[] }) {
  const totals = createMemo(() => foldGroupUsage(props.events))
  return (
    <section class="usage-table scroll" aria-label={t("usage.title")}>
      <h2>{t("usage.title")}</h2>
      <Show when={totals().rows.length} fallback={<p class="subtle">{t("usage.empty")}</p>}>
        <table>
          <thead>
            <tr>
              <th>{t("usage.task")}</th>
              <th>{t("usage.member")}</th>
              <th>{t("usage.input")}</th>
              <th>{t("usage.output")}</th>
              <th>{t("usage.cacheRead")}</th>
              <th>{t("usage.cacheWrite")}</th>
              <For each={totals().currencies}>{(currency) => <th>{currency}</th>}</For>
              <th>{t("usage.unknownCost")}</th>
            </tr>
          </thead>
          <tbody>
            <For each={totals().rows}>
              {(row) => (
                <tr>
                  <td>{props.tasks.find((task) => task.id === row.task)?.title ?? (row.task || t("group.chat"))}</td>
                  <td>{props.members.find((member) => member.id === row.member)?.name ?? row.member}</td>
                  <td>{row.input}</td>
                  <td>{row.output}</td>
                  <td>{row.cacheRead}</td>
                  <td>{row.cacheWrite}</td>
                  <For each={totals().currencies}>
                    {(currency) => (
                      <td>
                        {row.costs[currency]?.toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 6,
                        }) ?? "—"}
                      </td>
                    )}
                  </For>
                  <td>{row.unknown ? t("usage.unknown") : "—"}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>
      <For each={totals().budgets}>
        {(event) => (
          <section>
            <h3>
              {props.members.find((member) => member.id === event.actor.id)?.name ?? event.actor.id} ·{" "}
              {props.tasks.find((task) => task.id === event.scope.task)?.title ?? t("group.chat")}
            </h3>
            <ContextBudget report={event.payload} />
          </section>
        )}
      </For>
    </section>
  )
}
