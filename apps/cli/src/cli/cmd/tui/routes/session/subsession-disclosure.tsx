import type { RGBA } from "@opentui/core"
import { createEffect, createSignal, on, Show, type Accessor } from "solid-js"
import { useRenderer, type JSX } from "@opentui/solid"
import type { SessionMessageLoadState } from "../../context/session-message-loader"

interface SubsessionDisclosureControllerOptions {
  sessionID: Accessor<string | undefined>
  ensure(sessionID: string): Promise<void>
  onError?(error: unknown, sessionID: string): void
}

export function createSubsessionDisclosure(options: SubsessionDisclosureControllerOptions) {
  const [expanded, setExpanded] = createSignal(false)

  function load(sessionID: string) {
    return options.ensure(sessionID).catch((error) => options.onError?.(error, sessionID))
  }

  createEffect(
    on(
      () => [expanded(), options.sessionID()] as const,
      ([open, sessionID]) => {
        if (open && sessionID) void load(sessionID)
      },
    ),
  )

  return {
    expanded,
    toggle() {
      if (!options.sessionID()) return
      setExpanded((value) => !value)
    },
    retry() {
      const sessionID = options.sessionID()
      if (sessionID) void load(sessionID)
    },
  }
}

interface SubsessionDisclosureProps {
  id: string
  expanded: boolean
  state: SessionMessageLoadState
  hasContent: boolean
  labels: {
    expand: string
    collapse: string
    loading: string
    empty: string
    failed: string
    retry: string
  }
  colors: {
    text: RGBA
    muted: RGBA
    error: RGBA
    action: RGBA
  }
  onToggle(): void
  onRetry(): void
  children: JSX.Element
}

export function SubsessionDisclosure(props: SubsessionDisclosureProps) {
  const renderer = useRenderer()
  return (
    <>
      <box
        id={`${props.id}-toggle`}
        onMouseUp={(event) => {
          if (renderer.getSelection()?.getSelectedText()) return
          event.stopPropagation()
          props.onToggle()
        }}
        flexShrink={0}
      >
        <text fg={props.colors.text}>
          {props.expanded ? "▼" : "▶"}{" "}
          <span style={{ fg: props.colors.muted }}>{props.expanded ? props.labels.collapse : props.labels.expand}</span>
        </text>
      </box>
      <Show when={props.expanded}>
        <box flexDirection="column" gap={1}>
          <Show when={props.state.status === "idle" || props.state.status === "loading"}>
            <text id={`${props.id}-loading`} fg={props.colors.muted}>
              {props.labels.loading}
            </text>
          </Show>
          <Show when={props.hasContent}>{props.children}</Show>
          <Show when={props.state.status === "loaded" && !props.hasContent}>
            <text id={`${props.id}-empty`} fg={props.colors.muted}>
              {props.labels.empty}
            </text>
          </Show>
          <Show when={props.state.status === "error"}>
            <box
              id={`${props.id}-retry`}
              onMouseUp={(event) => {
                if (renderer.getSelection()?.getSelectedText()) return
                event.stopPropagation()
                props.onRetry()
              }}
              flexShrink={0}
            >
              <text fg={props.colors.error}>
                {props.labels.failed} <span style={{ fg: props.colors.action }}>{props.labels.retry}</span>
              </text>
            </box>
          </Show>
        </box>
      </Show>
    </>
  )
}
