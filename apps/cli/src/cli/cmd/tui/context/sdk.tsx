import { createMerakCodeClient, type GlobalEvent } from "@merakcode/sdk/client"
import { createSimpleContext } from "./helper"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { batch, createSignal, onCleanup, onMount } from "solid-js"
import { createSDKEvents, type EventSource, type Subscription } from "./sdk-events"
import { Log } from "@merakcode/log/logger"
import { failure } from "@merakcode/log"

/** Event source interface: external consumers can inject a custom event source (e.g. RPC channel) instead of the default SSE. */
export type { EventSource } from "./sdk-events"

export const { use: useSDK, provider: SDKProvider } = createSimpleContext({
  name: "SDK",
  init: (props: {
    url: string
    directory?: string
    fetch?: typeof fetch
    headers?: RequestInit["headers"]
    events?: EventSource
  }) => {
    const abort = new AbortController()
    const sdk = createMerakCodeClient({
      baseUrl: props.url,
      signal: abort.signal,
      directory: props.directory,
      fetch: props.fetch,
      headers: props.headers,
      clientRun: Log.id(),
    })

    // Global event emitter: uses a single "event" channel carrying raw GlobalEvent.
    // useEvent() is responsible for payload unpacking (event routing is keyed by sessionID).
    const emitter = createGlobalEmitter<{
      event: GlobalEvent
    }>()

    const [subscription, setSubscription] = createSignal<Subscription>({ generation: 0, ready: false })
    const events = createSDKEvents({
      signal: abort.signal,
      source: props.events,
      stream: (onSseError) => sdk.global.event({ signal: abort.signal, onSseError }),
      changed: setSubscription,
      emit: (events) => batch(() => events.forEach((event) => emitter.emit("event", event))),
      failed: (error) =>
        Log.create({ source: "product", service: "tui.sdk" }).warn("event subscription failed", failure(error)),
    })
    onMount(() => void events.start())

    onCleanup(() => {
      abort.abort()
      events.close()
    })

    return {
      client: sdk,
      event: emitter,
      subscription,
      baseUrl: props.url,
      /** Current directory path, used by ProjectProvider for initialization. */
      directory: props.directory,
      /** Same fetch as the SDK client; in RPC mode this is needed to access internal routes. */
      fetch: props.fetch ?? globalThis.fetch.bind(globalThis),
    }
  },
})
