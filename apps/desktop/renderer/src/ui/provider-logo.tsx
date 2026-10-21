import { Show } from "solid-js"

const logos = import.meta.glob<string>("../assets/providers/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
})

/** Bundled logo for a built-in provider, keyed by provider id. Custom providers have none. */
export function providerLogo(id: string): string | undefined {
  return Object.entries(logos).find(([path]) => path.endsWith(`/${id}.svg`))?.[1]
}

/** Built-in providers show their logo. A custom provider shows the first letter of its name. */
export function ProviderLogo(props: { id: string; name: string }) {
  const url = () => providerLogo(props.id)
  return (
    <Show
      when={url()}
      fallback={
        <span class="provider-logo letter" aria-hidden="true">
          {props.name.trim().slice(0, 1).toUpperCase()}
        </span>
      }
    >
      {(href) => <span class="provider-logo" style={{ "--logo": `url("${href()}")` }} aria-hidden="true" />}
    </Show>
  )
}
