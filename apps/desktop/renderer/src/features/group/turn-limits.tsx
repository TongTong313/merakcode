import type { GroupGroup } from "@merakcode/sdk"
import { createSignal, For, Show } from "solid-js"
import { z } from "zod"
import { t } from "../../i18n"
import { client } from "../../state/client"
import { summary } from "../../state/error"
import { noticeText } from "./notice"
import { localHuman } from "../../state/groups"

export function TurnLimits(props: { group: GroupGroup; editable: boolean }) {
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal<string>()
  return (
    <fieldset class="turn-limits" disabled={saving()}>
      <legend>{t("group.turns.title")}</legend>
      <For each={["thread", "group"] as const}>
        {(kind) => (
          <label class="field">
            <span>{t(`group.turns.${kind}`)}</span>
            <input
              class="input"
              type="number"
              min="1"
              step="1"
              aria-label={t(`group.turns.${kind}`)}
              value={props.group.settings?.turnsPerMinute?.[kind] ?? (kind === "thread" ? 6 : 30)}
              readOnly={!props.editable}
              onChange={async (event) => {
                if (!props.editable) return
                const input = event.currentTarget
                setSaving(true)
                setError(undefined)
                try {
                  const count = z.coerce.number().int().positive().safeParse(input.value)
                  if (!count.success) throw new Error("MRK-6001")
                  await (
                    await client()
                  ).group.update({
                    group: props.group.id,
                    human: localHuman,
                    settings: {
                      ...props.group.settings,
                      turnsPerMinute: { ...props.group.settings?.turnsPerMinute, [kind]: count.data },
                    },
                  })
                } catch (cause) {
                  setError(noticeText(summary(cause) ?? "MRK-6001"))
                  input.value = String(props.group.settings?.turnsPerMinute?.[kind] ?? (kind === "thread" ? 6 : 30))
                } finally {
                  setSaving(false)
                }
              }}
            />
          </label>
        )}
      </For>
      <Show when={error()}>{(message) => <p role="alert">{message()}</p>}</Show>
    </fieldset>
  )
}
