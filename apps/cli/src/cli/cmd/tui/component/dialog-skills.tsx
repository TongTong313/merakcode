import { TextAttributes } from "@opentui/core"
import { useTheme, selectedForeground } from "../context/theme"
import { useDialog, useDialogKeyboard } from "../ui/dialog"
import { useSDK } from "../context/sdk"
import { useLocale } from "../context/locale"
import { useToast } from "../ui/toast"
import { useProject } from "../context/project"
import { createStore } from "solid-js/store"
import { createEffect, createMemo, createResource, For, Show, type Accessor, createSignal } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { InputRenderable, ScrollBoxRenderable } from "@opentui/core"
import { InstallTargetDialog, type InstallTarget } from "./dialog-install-target"
import {
  skillIsProject,
  clampSkillIndex,
  skillDialogDefaultTab,
  skillDialogTabs,
  skillUninstallTransition,
  skillDescMaxWidth,
  truncateSkillDesc,
  type SkillDialogTab,
} from "./dialog-skills-core"

type TabType = SkillDialogTab

type InstalledSkill = {
  name: string
  description: string
  location: string
  content: string
  scope?: "global" | "project" | "builtin"
}

// A skill listed from a remote Git repository.
type RemoteMarketSkill = {
  name: string
  description: string
  repoPath: string
  path?: string
  files: string[]
}

type RemoteInstallSource =
  { type: "github"; url: string; owner: string; repo: string; branch?: string } | { type: "url"; url: string }

function errorMsg(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === "object" && err) {
    const obj = err as Record<string, unknown>
    if (typeof obj.data === "object" && obj.data) {
      const data = obj.data as Record<string, unknown>
      if (typeof data.message === "string") return data.message
      if (typeof data.error === "string") return data.error
    }
    if (typeof obj.message === "string") return obj.message
    if (typeof obj.error === "string") return obj.error
  }
  return String(err)
}

function TabHeader(props: { activeTab: TabType; onSwitch: (tab: TabType) => void; installedCount?: number }) {
  const { theme } = useTheme()
  const locale = useLocale()
  const fg = selectedForeground(theme)

  const labels = {
    remote: () => locale.t("skills.tab.remote"),
    installed: () => locale.t("skills.tab.installed"),
  } satisfies Record<TabType, () => string>
  const count = (key: TabType) => {
    if (key === "installed") return () => props.installedCount ?? 0
    return undefined
  }
  const tabs = skillDialogTabs.map((key) => ({ key, label: labels[key], count: count(key) }))

  return (
    <box flexDirection="column">
      {/* Tab buttons */}
      <box flexDirection="row" gap={0}>
        <For each={tabs}>
          {(tab) => {
            const isActive = () => props.activeTab === tab.key
            const count = tab.count?.() ?? 0
            return (
              <box
                onMouseUp={() => props.onSwitch(tab.key)}
                backgroundColor={isActive() ? theme.primary : undefined}
                paddingLeft={3}
                paddingRight={3}
                paddingTop={0}
                paddingBottom={0}
                borderStyle={isActive() ? undefined : undefined}
                borderColor={theme.border}
              >
                <text fg={isActive() ? fg : theme.text} attributes={isActive() ? TextAttributes.BOLD : undefined}>
                  {tab.label()}
                  {count > 0 ? ` (${count})` : ""}
                </text>
              </box>
            )
          }}
        </For>
      </box>
      {/* Separator */}
      <box height={1} backgroundColor={theme.border} />
    </box>
  )
}

function SearchInput(props: {
  value: Accessor<string>
  onInput: (value: string) => void
  onSubmit?: () => void
  placeholder?: string
}) {
  const { theme } = useTheme()
  const locale = useLocale()
  let input: InputRenderable

  return (
    <box flexDirection="row" alignItems="center" gap={1} paddingLeft={2} paddingRight={2} paddingTop={1}>
      <text fg={theme.textMuted}>🔍</text>
      <box flexGrow={1}>
        <input
          onInput={(e) => props.onInput(e)}
          onSubmit={() => props.onSubmit?.()}
          focusedBackgroundColor={theme.backgroundPanel}
          cursorColor={theme.primary}
          focusedTextColor={theme.text}
          placeholderColor={theme.textMuted}
          ref={(r: InputRenderable) => {
            input = r
            setTimeout(() => {
              if (!input || input.isDestroyed) return
              input.focus()
            }, 1)
          }}
          placeholder={props.placeholder ?? locale.t("skills.search.placeholder")}
        />
      </box>
      <Show when={props.value()}>
        <text fg={theme.textMuted} onMouseUp={() => props.onInput("")}>
          ✕
        </text>
      </Show>
    </box>
  )
}

function SkillRow(props: {
  name: string
  description: string
  location?: string
  isProject?: boolean
  isInstalled?: boolean
  isBuiltin?: boolean
  danger?: boolean
  active: boolean
  onMouseUp: () => void
  onMouseOver: () => void
  extraInfo?: string
}) {
  const { theme } = useTheme()
  const locale = useLocale()
  const fg = () => selectedForeground(theme, props.danger ? theme.error : undefined)
  const dimensions = useTerminalDimensions()

  const truncatedDesc = () => truncateSkillDesc(props.description ?? "", skillDescMaxWidth(dimensions().width, 55))

  return (
    <box
      flexDirection="column"
      gap={0}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={0}
      paddingBottom={0}
      backgroundColor={props.danger ? theme.error : props.active ? theme.primary : undefined}
      onMouseUp={props.onMouseUp}
      onMouseOver={props.onMouseOver}
    >
      <box flexDirection="row" gap={1} alignItems="center">
        {/* Installed marker */}
        <Show when={props.isInstalled}>
          <text fg={props.active ? fg() : theme.success} attributes={TextAttributes.BOLD}>
            ✓
          </text>
        </Show>
        {/* Name */}
        <text
          fg={props.active ? fg() : props.isInstalled ? theme.success : theme.text}
          attributes={TextAttributes.BOLD}
          wrapMode="none"
          overflow="hidden"
        >
          {props.name}
        </text>
        {/* Built-in tag */}
        <Show when={props.isBuiltin}>
          <text fg={props.active ? fg() : theme.warning} attributes={TextAttributes.ITALIC} wrapMode="none">
            [{locale.t("skills.builtin")}]
          </text>
        </Show>
        {/* Location tag */}
        <Show when={props.isProject !== undefined && !props.isBuiltin}>
          <text fg={props.active ? fg() : theme.primary} attributes={TextAttributes.ITALIC} wrapMode="none">
            [{props.isProject ? locale.t("skills.location.project") : locale.t("skills.location.global")}]
          </text>
        </Show>
        {/* Extra info such as version or download count */}
        <Show when={props.extraInfo}>
          <text fg={props.active ? fg() : theme.textMuted} wrapMode="none">
            · {props.extraInfo}
          </text>
        </Show>
      </box>
      {/* Description */}
      <Show when={truncatedDesc()}>
        <text fg={props.active ? fg() : theme.textMuted} paddingLeft={props.isInstalled ? 3 : 2} wrapMode="word">
          {truncatedDesc()}
        </text>
      </Show>
    </box>
  )
}

function EmptyState(props: { icon: string; title: string; hint?: string }) {
  const { theme } = useTheme()

  return (
    <box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1} gap={1} paddingTop={3}>
      <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>
        {props.icon}
      </text>
      <text fg={theme.textMuted}>{props.title}</text>
      <Show when={props.hint}>
        <text fg={theme.textMuted}>{props.hint}</text>
      </Show>
    </box>
  )
}

function InstalledTab(props: {
  selectedIndex: Accessor<number>
  setSelectedIndex: (index: number) => void
  installedCount: Accessor<number>
  refreshTrigger: number
  onUninstallSuccess: () => void
}) {
  const { theme } = useTheme()
  const locale = useLocale()
  const sdk = useSDK()
  const dimensions = useTerminalDimensions()
  const toast = useToast()
  const project = useProject()

  const [search, setSearch] = createSignal("")
  const [uninstallConfirm, setUninstallConfirm] = createSignal<string>()
  const [uninstalling, setUninstalling] = createSignal<string>()

  const [installedSkills, { mutate, refetch }] = createResource(async () => {
    const res = await sdk.client.app.skills({})
    return (res.data ?? []) as InstalledSkill[]
  })

  const matches = (skill: InstalledSkill, query: string) =>
    !query || skill.name.toLowerCase().includes(query) || (skill.description ?? "").toLowerCase().includes(query)

  const filtered = createMemo(() => {
    const q = search().toLowerCase().trim()
    return (installedSkills() ?? []).filter((skill) => matches(skill, q))
  })

  const handleSearch = (value: string) => {
    setSearch(value)
    setUninstallConfirm(undefined)
    props.setSelectedIndex(0)
  }

  const list = () => filtered()
  const maxHeight = () => Math.floor(dimensions().height / 2) - 14
  let scroll: ScrollBoxRenderable

  const skillID = (skill: InstalledSkill) => `${skill.location}\u0000${skill.name}`

  const handleUninstall = async (skill: InstalledSkill) => {
    const id = skillID(skill)
    if (uninstalling()) return
    setUninstalling(id)
    try {
      await sdk.client.skill.uninstall(
        {
          name: skill.name,
          location: skill.location,
          directory: project.directory(),
        },
        { throwOnError: true },
      )
      const current = (installedSkills() ?? []).filter((item) => skillID(item) !== id)
      mutate(current)
      toast.show({ variant: "success", message: locale.t("skills.uninstall.success", { name: skill.name }) })
      const next = (await Promise.resolve(refetch()).catch(() => current)) ?? current
      const count = next.filter((item) => matches(item, search().toLowerCase().trim())).length
      props.setSelectedIndex(clampSkillIndex(props.selectedIndex(), count))
      props.onUninstallSuccess()
    } catch (e) {
      toast.show({ variant: "error", message: errorMsg(e) })
    } finally {
      setUninstallConfirm(undefined)
      setUninstalling(undefined)
    }
  }

  // The first Ctrl+P asks for confirmation; a second press on the same item uninstalls it.
  const confirmUninstall = () => {
    const skill = list()[props.selectedIndex()]
    if (!skill || skill.location.startsWith("<builtin>") || uninstalling()) return
    const id = skillID(skill)
    const transition = skillUninstallTransition(uninstallConfirm(), "press", id)
    setUninstallConfirm(transition.confirm)
    if (transition.remove === id) void handleUninstall(skill)
  }

  const select = (index: number) => {
    setUninstallConfirm(undefined)
    props.setSelectedIndex(index)
  }

  const scrollToSelected = () => {
    if (!scroll) return
    const children = scroll.getChildren()
    const idx = props.selectedIndex()
    if (idx < 0 || idx >= children.length) return
    const target = children[idx]
    const y = target.y - scroll.y
    if (y >= scroll.height) {
      scroll.scrollBy(y - scroll.height + 1)
    } else if (y < 0) {
      scroll.scrollBy(y)
    }
  }

  useDialogKeyboard((evt) => {
    const listLen = list().length
    if (listLen === 0) return

    if (evt.name === "up" || evt.name === "k") {
      if (props.selectedIndex() > 0) {
        select(props.selectedIndex() - 1)
      }
      evt.preventDefault()
      return
    }
    if (evt.name === "down" || evt.name === "j") {
      if (props.selectedIndex() < listLen - 1) {
        select(props.selectedIndex() + 1)
      }
      evt.preventDefault()
      return
    }
    if (evt.ctrl && evt.name === "p") {
      confirmUninstall()
      evt.preventDefault()
      return
    }
  })

  createEffect(() => {
    props.selectedIndex() // tracked dependency
    scrollToSelected()
  })

  return (
    <box flexDirection="column" flexGrow={1}>
      <SearchInput value={search} onInput={handleSearch} />

      <Show when={installedSkills.loading}>
        <box paddingLeft={2} paddingRight={2} paddingTop={1}>
          <text fg={theme.textMuted}>{locale.t("common.loading")}...</text>
        </box>
      </Show>

      <Show when={!installedSkills.loading && list().length === 0 && search()}>
        <EmptyState icon="🔍" title={locale.t("select.noResults")} hint={locale.t("skills.empty.hint")} />
      </Show>

      <Show when={!installedSkills.loading && list().length === 0 && !search()}>
        <EmptyState icon="📦" title={locale.t("skills.empty")} hint={locale.t("skills.empty.hint")} />
      </Show>

      <Show when={!installedSkills.loading && list().length > 0}>
        <scrollbox
          ref={(r: ScrollBoxRenderable) => {
            scroll = r
          }}
          maxHeight={maxHeight()}
          stickyScroll={true}
          stickyStart="top"
        >
          <For each={list()}>
            {(skill, i) => (
              <SkillRow
                name={
                  uninstallConfirm() === skillID(skill)
                    ? locale.t("skills.uninstall.confirmAgain", { name: skill.name })
                    : skill.name
                }
                description={skill.description ?? ""}
                location={skill.location}
                isProject={skillIsProject(skill)}
                isInstalled={true}
                isBuiltin={skill.location.startsWith("<builtin>")}
                danger={uninstallConfirm() === skillID(skill)}
                active={i() === props.selectedIndex()}
                onMouseUp={() => {
                  select(i())
                }}
                onMouseOver={() => {
                  if (i() !== props.selectedIndex()) select(i())
                }}
              />
            )}
          </For>
        </scrollbox>
      </Show>
    </box>
  )
}

// Marketplace tab: lists skills from a remote Git repository.
function RemoteTab(props: {
  selectedIndex: Accessor<number>
  setSelectedIndex: (index: number) => void
  installedNames: Accessor<Set<string>>
  repoUrl: Accessor<string>
  setRepoUrl: (url: string) => void
  skills: Accessor<RemoteMarketSkill[]>
  setSkills: (skills: RemoteMarketSkill[]) => void
  onRefresh: () => void
}) {
  const { theme } = useTheme()
  const locale = useLocale()
  const sdk = useSDK()
  const project = useProject()
  const toast = useToast()
  const dimensions = useTerminalDimensions()
  const dialog = useDialog()

  let inputRef: InputRenderable

  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal("")
  const [installing, setInstalling] = createSignal(false)
  const [listedSource, setListedSource] = createSignal<RemoteInstallSource | undefined>()

  const browse = async () => {
    const url = props.repoUrl().trim()
    if (!url) return

    setLoading(true)
    setError("")
    setListedSource(undefined)
    try {
      const res = await sdk.client.skillInstall.list({ source: url })
      const data = res.data
      if (!data?.skills?.length) {
        setError(locale.t("skills.remoteMarket.emptyResult"))
        props.setSkills([])
        return
      }
      props.setSkills(data.skills as RemoteMarketSkill[])
      setListedSource(data.source as RemoteInstallSource)
      props.setSelectedIndex(0)
    } catch (e) {
      setError(e instanceof Error ? e.message : locale.t("skills.remoteMarket.error"))
      props.setSkills([])
    } finally {
      setLoading(false)
    }
  }

  const doInstall = async (skill: RemoteMarketSkill, target: InstallTarget) => {
    if (installing()) return
    const source = listedSource()
    if (!source) return
    setInstalling(true)
    try {
      await sdk.client.skillInstall.install({
        body_directory: project.directory(),
        source,
        skills: [skill],
        target,
      })
      toast.show({ variant: "success", message: locale.t("skills.remoteMarket.success", { name: skill.name }) })
      props.setSkills(props.skills().filter((s) => s.name !== skill.name))
      props.onRefresh()
    } catch (e) {
      toast.show({ variant: "error", message: e instanceof Error ? e.message : locale.t("skills.remoteMarket.failed") })
    } finally {
      setInstalling(false)
    }
  }

  const showInstallDialog = async (skill: RemoteMarketSkill) => {
    const target = await InstallTargetDialog.show(dialog, skill.name)
    if (target) {
      await doInstall(skill, target)
    }
  }

  useDialogKeyboard((evt) => {
    const list = props.skills()

    // With a skill list, Enter installs the selected skill.
    if (list.length > 0) {
      if (evt.name === "up" || evt.name === "k") {
        if (props.selectedIndex() > 0) {
          props.setSelectedIndex(props.selectedIndex() - 1)
        }
        evt.preventDefault()
        return
      }
      if (evt.name === "down" || evt.name === "j") {
        if (props.selectedIndex() < list.length - 1) {
          props.setSelectedIndex(props.selectedIndex() + 1)
        }
        evt.preventDefault()
        return
      }
      if (evt.name === "return") {
        const skill = list[props.selectedIndex()]
        if (skill && !props.installedNames().has(skill.name) && !installing()) {
          void showInstallDialog(skill)
        }
        evt.preventDefault()
        return
      }
    }

    // Without a list, Enter submits the repository URL.
    if (evt.name === "return" && list.length === 0) {
      void browse()
      evt.preventDefault()
    }
  })

  const maxHeight = () => Math.floor(dimensions().height / 2) - 16
  const fg = selectedForeground(theme)
  let scroll: ScrollBoxRenderable

  const scrollToSelected = () => {
    if (!scroll) return
    const children = scroll.getChildren()
    const idx = props.selectedIndex()
    if (idx < 0 || idx >= children.length) return
    const target = children[idx]
    const y = target.y - scroll.y
    if (y >= scroll.height) {
      scroll.scrollBy(y - scroll.height + 1)
    } else if (y < 0) {
      scroll.scrollBy(y)
    }
  }

  createEffect(() => {
    props.selectedIndex() // tracked dependency
    scrollToSelected()
  })

  return (
    <box flexDirection="column" flexGrow={1}>
      {/* Repository URL input */}
      <box flexDirection="row" alignItems="center" gap={1} paddingLeft={2} paddingRight={2} paddingTop={1}>
        <text fg={theme.textMuted}>🔗</text>
        <box flexGrow={1}>
          <input
            ref={(r: InputRenderable) => {
              inputRef = r
              setTimeout(() => {
                if (!inputRef || inputRef.isDestroyed) return
                inputRef.focus()
              }, 1)
            }}
            onInput={(e) => {
              props.setRepoUrl(e)
              setError("")
            }}
            onSubmit={() => browse()}
            focusedBackgroundColor={theme.backgroundPanel}
            cursorColor={theme.primary}
            focusedTextColor={theme.text}
            placeholderColor={theme.textMuted}
            placeholder={locale.t("skills.remoteMarket.inputPlaceholder")}
          />
        </box>
        <Show when={props.repoUrl()}>
          <text
            fg={theme.textMuted}
            onMouseUp={() => {
              props.setRepoUrl("")
              props.setSkills([])
              setError("")
            }}
          >
            ✕
          </text>
        </Show>
      </box>

      {/* Error */}
      <Show when={error()}>
        <box paddingLeft={2} paddingRight={2} paddingTop={0}>
          <text fg={theme.error}>✕ {error()}</text>
        </box>
      </Show>

      {/* Loading */}
      <Show when={loading()}>
        <box paddingLeft={2} paddingRight={2} paddingTop={1}>
          <text fg={theme.textMuted}>{locale.t("skills.remoteMarket.loading")}</text>
        </box>
      </Show>

      {/* Empty: no URL entered */}
      <Show when={!loading() && !error() && props.skills().length === 0 && !props.repoUrl().trim()}>
        <EmptyState icon="🔗" title={locale.t("skills.remoteMarket.empty")} />
      </Show>

      {/* Empty: no results */}
      <Show when={!loading() && !error() && props.skills().length === 0 && props.repoUrl().trim()}>
        <EmptyState icon="🔍" title={locale.t("skills.remoteMarket.emptyResult")} />
      </Show>

      {/* Skill list */}
      <Show when={!loading() && props.skills().length > 0}>
        <scrollbox
          ref={(r: ScrollBoxRenderable) => {
            scroll = r
          }}
          maxHeight={maxHeight()}
          stickyScroll={true}
          stickyStart="top"
        >
          <For each={props.skills()}>
            {(skill, i) => {
              const isInstalled = () => props.installedNames().has(skill.name)
              const isActive = () => i() === props.selectedIndex()
              const background = () => (isActive() ? theme.primary : theme.backgroundPanel)
              const truncatedDesc = () =>
                truncateSkillDesc(skill.description ?? "", skillDescMaxWidth(dimensions().width, 55))
              return (
                <box
                  flexDirection="column"
                  gap={0}
                  paddingLeft={2}
                  paddingRight={2}
                  paddingTop={0}
                  paddingBottom={0}
                  backgroundColor={background()}
                  onMouseUp={() => {
                    props.setSelectedIndex(i())
                  }}
                >
                  <box flexDirection="row" gap={1} alignItems="center">
                    <text
                      fg={isActive() ? fg : isInstalled() ? theme.success : theme.text}
                      attributes={TextAttributes.BOLD}
                      wrapMode="none"
                      overflow="hidden"
                    >
                      {skill.name}
                    </text>
                    <Show when={isInstalled()}>
                      <text fg={isActive() ? fg : theme.success} attributes={TextAttributes.BOLD}>
                        ✓
                      </text>
                    </Show>
                  </box>
                  <Show when={truncatedDesc()}>
                    <text
                      content={truncatedDesc()}
                      fg={isActive() ? fg : theme.textMuted}
                      bg={background()}
                      paddingLeft={2}
                      wrapMode="none"
                    />
                  </Show>
                </box>
              )
            }}
          </For>
        </scrollbox>
      </Show>
    </box>
  )
}

export function DialogSkills() {
  const dialog = useDialog()
  const { theme } = useTheme()
  const locale = useLocale()
  const sdk = useSDK()

  dialog.setSize("large")

  const [store, setStore] = createStore({
    activeTab: skillDialogDefaultTab,
    selectedIndex: 0,
    refreshTrigger: 0,
    remoteRepoUrl: "",
    remoteSkills: [] as RemoteMarketSkill[],
  })

  const switchTab = (tab: TabType) => {
    setStore("activeTab", tab)
    setStore("selectedIndex", 0)
  }

  // Installed skills, used for the count and the installed markers.
  const [installedSkills] = createResource(
    () => store.refreshTrigger,
    async () => {
      const res = await sdk.client.app.skills({})
      return (res.data ?? []) as InstalledSkill[]
    },
  )

  const installedCount = () => (installedSkills() ?? []).filter((s) => !s.location.startsWith("<builtin>")).length

  const selectedIndexAccessor = () => store.selectedIndex

  useDialogKeyboard((evt) => {
    if (evt.name === "tab") {
      const tabs = skillDialogTabs
      const currentIdx = tabs.indexOf(store.activeTab)
      const nextIdx = (currentIdx + 1) % tabs.length
      switchTab(tabs[nextIdx])
      evt.preventDefault()
      return
    }

    // List navigation is handled by each tab component.
  })

  return (
    <box gap={1} paddingLeft={2} paddingRight={2} paddingBottom={1}>
      {/* Title */}
      <box flexDirection="row" justifyContent="space-between" alignItems="center">
        <text attributes={TextAttributes.BOLD} fg={theme.primary}>
          {locale.t("skills.title")}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc {locale.t("common.cancel")}
        </text>
      </box>

      {/* Tabs */}
      <TabHeader activeTab={store.activeTab} onSwitch={switchTab} installedCount={installedCount()} />

      {/* Content */}
      <box flexDirection="column" flexGrow={1}>
        <Show when={store.activeTab === "installed"}>
          <InstalledTab
            selectedIndex={selectedIndexAccessor}
            setSelectedIndex={(i) => setStore("selectedIndex", i)}
            installedCount={installedCount}
            refreshTrigger={store.refreshTrigger}
            onUninstallSuccess={() => setStore("refreshTrigger", store.refreshTrigger + 1)}
          />
        </Show>

        <Show when={store.activeTab === "remote"}>
          <RemoteTab
            selectedIndex={selectedIndexAccessor}
            setSelectedIndex={(i) => setStore("selectedIndex", i)}
            installedNames={() =>
              new Set((installedSkills() ?? []).filter((s) => !s.location.startsWith("<builtin>")).map((s) => s.name))
            }
            repoUrl={() => store.remoteRepoUrl}
            setRepoUrl={(url) => setStore("remoteRepoUrl", url)}
            skills={() => store.remoteSkills}
            setSkills={(skills) => setStore("remoteSkills", skills)}
            onRefresh={() => setStore("refreshTrigger", store.refreshTrigger + 1)}
          />
        </Show>
      </box>

      {/* Key hints */}
      <box height={1} backgroundColor={theme.border} />
      <box flexDirection="row" gap={3} flexShrink={0}>
        <text fg={theme.textMuted}>
          <span style={{ fg: theme.primary }}>tab</span> {locale.t("skills.keys.tab")}
        </text>
        <Show when={store.activeTab === "installed" || store.activeTab === "remote"}>
          <text fg={theme.textMuted}>
            <span style={{ fg: theme.primary }}>↑↓</span> {locale.t("skills.keys.select")}
          </text>
        </Show>
        <Show when={store.activeTab === "remote"}>
          <text fg={theme.textMuted}>
            <span style={{ fg: theme.primary }}>enter</span> {locale.t("skills.keys.install")}
          </text>
        </Show>
        <Show when={store.activeTab === "installed"}>
          <text fg={theme.textMuted}>
            <span style={{ fg: theme.primary }}>ctrl+p</span> {locale.t("skills.keys.uninstall")}
          </text>
        </Show>
        <text fg={theme.textMuted}>
          <span style={{ fg: theme.primary }}>esc</span> {locale.t("skills.keys.close")}
        </text>
      </box>
    </box>
  )
}
