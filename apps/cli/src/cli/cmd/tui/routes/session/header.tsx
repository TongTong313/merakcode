import { type Accessor, createMemo, createSignal, Match, Show, Switch } from "solid-js"
import { useRouteData } from "../../context/route"
import { useSync } from "../../context/sync"
import { useTheme } from "../../context/theme"
import { SplitBorder } from "../../component/border"
import type { Session } from "@merakcode/sdk/client"
import { useCommandDialog } from "../../component/dialog-command"
import { useKeybind } from "../../context/keybind"
import { useLocale } from "../../context/locale"
import { useTerminalDimensions } from "@opentui/solid"

const Title = (props: { session: Accessor<Session>; width: Accessor<number> }) => {
  const { theme, syntax } = useTheme()
  const createdTime = createMemo(() => {
    const ts = props.session().time?.created
    if (!ts) return ""
    const date = new Date(ts)
    return date.toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
  })
  // Separator width follows the terminal width minus horizontal padding.
  const separatorWidth = createMemo(() => Math.max(20, props.width() - 8))
  return (
    <box flexDirection="column">
      {/* Title rendered as markdown on the left, muted creation time on the right */}
      <box flexDirection="row" justifyContent="space-between">
        <box flexDirection="row">
          <text fg={theme.primary}>◆ </text>
          <code
            marginLeft={1}
            filetype="markdown"
            drawUnstyledText={false}
            syntaxStyle={syntax()}
            content={props.session().title}
            fg={theme.text}
          />
        </box>
        <Show when={createdTime()}>
          <text fg={theme.textMuted} flexShrink={0}>
            {createdTime()}
          </text>
        </Show>
      </box>
      {/* Separator */}
      <text fg={theme.borderSubtle}>{"━".repeat(separatorWidth())}</text>
    </box>
  )
}

export function Header() {
  const route = useRouteData("session")
  const sync = useSync()
  const session = createMemo(() => sync.session.get(route.sessionID)!)
  const { theme } = useTheme()
  const keybind = useKeybind()
  const locale = useLocale()
  const command = useCommandDialog()
  const [hover, setHover] = createSignal<"parent" | "prev" | "next" | null>(null)
  const dimensions = useTerminalDimensions()
  const width = createMemo(() => dimensions().width)

  return (
    <Show when={session()}>
      <Switch>
        {/* Child session: bordered header */}
        <Match when={session()?.parentID}>
          <box flexShrink={0}>
            <box
              paddingTop={1}
              paddingBottom={1}
              paddingLeft={2}
              paddingRight={1}
              {...SplitBorder}
              border={["left"]}
              borderColor={theme.border}
              flexShrink={0}
              backgroundColor={theme.backgroundPanel}
            >
              <box flexDirection="column" gap={1}>
                <text fg={theme.text}>
                  <b>{locale.t("session.subagent.title")}</b>
                </text>
                <box flexDirection="row" gap={2}>
                  <box
                    onMouseOver={() => setHover("parent")}
                    onMouseOut={() => setHover(null)}
                    onMouseUp={() => command.trigger("session.parent")}
                    backgroundColor={hover() === "parent" ? theme.backgroundElement : theme.backgroundPanel}
                  >
                    <text fg={theme.text}>
                      {locale.t("session.subagent.parent")}{" "}
                      <span style={{ fg: theme.textMuted }}>{keybind.print("session_parent")}</span>
                    </text>
                  </box>
                  <box
                    onMouseOver={() => setHover("prev")}
                    onMouseOut={() => setHover(null)}
                    onMouseUp={() => command.trigger("session.child.previous")}
                    backgroundColor={hover() === "prev" ? theme.backgroundElement : theme.backgroundPanel}
                  >
                    <text fg={theme.text}>
                      {locale.t("session.subagent.previous")}{" "}
                      <span style={{ fg: theme.textMuted }}>{keybind.print("session_child_cycle_reverse")}</span>
                    </text>
                  </box>
                  <box
                    onMouseOver={() => setHover("next")}
                    onMouseOut={() => setHover(null)}
                    onMouseUp={() => command.trigger("session.child.next")}
                    backgroundColor={hover() === "next" ? theme.backgroundElement : theme.backgroundPanel}
                  >
                    <text fg={theme.text}>
                      {locale.t("session.subagent.next")}{" "}
                      <span style={{ fg: theme.textMuted }}>{keybind.print("session_child_cycle")}</span>
                    </text>
                  </box>
                </box>
              </box>
            </box>
          </box>
        </Match>
        {/* Root session: title without a border */}
        <Match when={true}>
          <box flexShrink={0} paddingTop={1}>
            <Title session={session} width={width} />
          </box>
        </Match>
      </Switch>
    </Show>
  )
}
