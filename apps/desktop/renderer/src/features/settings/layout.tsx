import { Show } from "solid-js"

export function Section(props: { title: string; lead?: string; children: unknown }) {
  return (
    <section class="settings-inner" role="region" aria-label={props.title}>
      <h1>{props.title}</h1>
      <Show when={props.lead}>
        <p class="lead">{props.lead}</p>
      </Show>
      {props.children as never}
    </section>
  )
}

export function Row(props: { label: string; desc?: string; children: unknown }) {
  return (
    <div class="setting-row">
      <div class="grow">
        <div class="label">{props.label}</div>
        <Show when={props.desc}>
          <div class="desc">{props.desc}</div>
        </Show>
      </div>
      {props.children as never}
    </div>
  )
}
