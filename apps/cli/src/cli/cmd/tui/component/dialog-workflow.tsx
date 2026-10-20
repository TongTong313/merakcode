import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { useDialog, useDialogKeyboard } from "../ui/dialog"
import { useRoute } from "../context/route"
import { useSDK } from "../context/sdk"
import { useTheme } from "../context/theme"
import type {
  WorkflowAgentProgress,
  WorkflowAgentToolProgress,
  WorkflowPhaseMeta,
  WorkflowRunRecord,
  WorkflowWorkUnit,
} from "../workflow-types"

const DEFAULT_WORKFLOW_PHASE = "Workflow"

type PhaseAgentView = {
  id: string
  label: string
  agent: string
  phase?: string
  status: WorkflowAgentProgress["status"]
  model?: { providerID: string; modelID: string }
  sessionId?: string
  startedAt?: number
  completedAt?: number
  error?: string
  toolCount?: number
  latestTool?: WorkflowAgentToolProgress
  unit?: WorkflowWorkUnit
}

type PhaseActivity = {
  agents: PhaseAgentView[]
  queued: number
  running: number
  completed: number
  failed: number
  cached: number
}

type PhaseDisplayStatus = "pending" | "running" | "completed" | "failed" | "aborted"

function compactText(value: string | undefined, limit = 110) {
  if (!value) return ""
  const text = value.replace(/\s+/g, " ").trim()
  return clipCells(text, limit)
}

function cellWidth(char: string) {
  const code = char.codePointAt(0) ?? 0
  if (code === 0 || code < 32 || (code >= 0x7f && code < 0xa0)) return 0
  if (
    code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6))
  ) {
    return 2
  }
  return 1
}

function cellLength(value: string) {
  return Array.from(value).reduce((sum, char) => sum + cellWidth(char), 0)
}

function clipCells(value: string, limit: number) {
  if (limit <= 0) return ""
  if (cellLength(value) <= limit) return value
  if (limit <= 3) return ".".repeat(limit)
  const target = limit - 3
  let used = 0
  let output = ""
  for (const char of Array.from(value)) {
    const width = cellWidth(char)
    if (used + width > target) break
    output += char
    used += width
  }
  return output + "..."
}

function elapsed(start: number | undefined, end: number | undefined = Date.now()) {
  if (!start) return ""
  const seconds = Math.max(0, Math.round((end - start) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${minutes}m ${rest}s`
}

function statusLabel(status: WorkflowRunRecord["status"] | WorkflowAgentProgress["status"]) {
  if (status === "completed") return "done"
  if (status === "aborted") return "stopped"
  if (status === "queued") return "queued"
  if (status === "cached") return "cached"
  return status
}

function runStatusLabel(run: WorkflowRunRecord) {
  return statusLabel(run.status)
}

function toolStatusLabel(status: WorkflowAgentToolProgress["status"]) {
  if (status === "completed") return "done"
  if (status === "error") return "failed"
  return status
}

function toolDuration(tool: WorkflowAgentToolProgress) {
  return elapsed(tool.startedAt, tool.completedAt ?? Date.now())
}

function toolGlyph(status: WorkflowAgentToolProgress["status"]) {
  if (status === "running") return ">"
  if (status === "completed") return "*"
  if (status === "error") return "!"
  return "."
}

function agentGlyph(status: WorkflowAgentProgress["status"]) {
  if (status === "running") return ">"
  if (status === "completed") return "*"
  if (status === "cached") return "="
  if (status === "failed") return "!"
  return "."
}

function runColor(theme: ReturnType<typeof useTheme>["theme"], run: WorkflowRunRecord) {
  if (run.status === "failed") return theme.error
  if (run.status === "aborted") return theme.warning
  if (run.status === "completed") return theme.success
  return theme.primary
}

function agentColor(theme: ReturnType<typeof useTheme>["theme"], status: WorkflowAgentProgress["status"]) {
  if (status === "failed") return theme.error
  if (status === "running") return theme.warning
  if (status === "completed" || status === "cached") return theme.success
  return theme.textMuted
}

function toolColor(theme: ReturnType<typeof useTheme>["theme"], status: WorkflowAgentToolProgress["status"]) {
  if (status === "error") return theme.error
  if (status === "running") return theme.warning
  if (status === "completed") return theme.success
  return theme.textMuted
}

function toolAction(tool: WorkflowAgentToolProgress) {
  const title = compactText(tool.title, 80)
  if (title) return title
  const name = tool.tool.replace(/[_-]+/g, " ")
  return name.charAt(0).toUpperCase() + name.slice(1)
}

function agentToolLabel(agent: Pick<PhaseAgentView, "toolCount" | "latestTool">) {
  const count = agent.toolCount ?? 0
  if (count === 1) return "1 tool"
  return `${count} tools`
}

function latestToolLine(tool: WorkflowAgentToolProgress) {
  const action = toolAction(tool)
  const duration = toolDuration(tool)
  return [action, toolStatusLabel(tool.status), duration].filter(Boolean).join(" - ")
}

function phaseActivities(run: WorkflowRunRecord) {
  const fallbackPhase = run.phase ?? run.phases[0]?.title ?? DEFAULT_WORKFLOW_PHASE
  const agents = new Map<string, PhaseAgentView>()
  const workUnitByAgentId = new Map<string, WorkflowWorkUnit>()
  for (const unit of run.workUnits ?? []) {
    if (unit.agentId) workUnitByAgentId.set(unit.agentId, unit)
  }
  for (const unit of run.workUnits ?? []) {
    const id = unit.agentId ?? `planned:${unit.id}`
    agents.set(id, {
      id,
      label: unit.agentLabel ?? unit.title,
      agent: unit.agentType ?? "workflow-subagent",
      phase: unit.phase,
      status: unit.status,
      unit,
    })
  }
  for (const agent of run.agents) {
    const unit = workUnitByAgentId.get(agent.id)
    agents.set(agent.id, {
      id: agent.id,
      label: agent.label,
      agent: agent.agent,
      phase: agent.phase ?? unit?.phase,
      status: agent.status,
      model: agent.model,
      sessionId: agent.sessionId,
      startedAt: agent.startedAt,
      completedAt: agent.completedAt,
      error: agent.error,
      latestTool: agent.latestTool,
      toolCount: agent.toolCount,
      unit,
    })
  }
  const phases = new Map<string, PhaseActivity>()
  for (const agent of agents.values()) {
    const title = agent.phase ?? fallbackPhase
    if (!title) continue
    const activity = phases.get(title) ?? {
      agents: [],
      queued: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cached: 0,
    }
    activity.agents.push(agent)
    if (agent.status === "queued") activity.queued++
    if (agent.status === "running") activity.running++
    if (agent.status === "completed") activity.completed++
    if (agent.status === "cached") activity.cached++
    if (agent.status === "failed") activity.failed++
    phases.set(title, activity)
  }
  return phases
}

function emptyPhaseStatus(run: WorkflowRunRecord, phases: WorkflowPhaseMeta[], index: number): PhaseDisplayStatus {
  const current = phases.findIndex((item) => item.title === run.phase)
  if (current < 0) return "pending"
  if (index < current) return "completed"
  if (index > current) return "pending"
  if (run.status === "completed") return "completed"
  if (run.status === "failed") return "failed"
  if (run.status === "aborted") return "aborted"
  return "running"
}

function phaseDisplayStatus(
  run: WorkflowRunRecord,
  phases: WorkflowPhaseMeta[],
  index: number,
  activity: PhaseActivity | undefined,
): PhaseDisplayStatus {
  if (!activity || activity.agents.length === 0) return emptyPhaseStatus(run, phases, index)
  if (activity.failed) return "failed"
  if (activity.running) return "running"
  if (activity.queued) return "pending"
  return "completed"
}

function phaseGlyph(status: PhaseDisplayStatus) {
  if (status === "running") return ">"
  if (status === "completed") return "*"
  if (status === "failed" || status === "aborted") return "!"
  return "."
}

function phaseStatusLabel(status: PhaseDisplayStatus) {
  if (status === "completed") return "done"
  if (status === "aborted") return "stopped"
  return status
}

function emptyPhaseMessage(status: PhaseDisplayStatus) {
  if (status === "completed") return "This phase completed without child agents."
  if (status === "running") return "This phase is running without child agents."
  if (status === "failed") return "Workflow failed in this phase before launching child agents."
  if (status === "aborted") return "Workflow stopped in this phase before launching child agents."
  return "No agents in this phase yet."
}

function phaseProgress(activity: PhaseActivity | undefined) {
  if (!activity || activity.agents.length === 0) return ""
  const done = activity.completed + activity.cached
  return `${done}/${activity.agents.length}`
}

function runStats(run: WorkflowRunRecord) {
  const total = run.agentCount ?? run.agents.length ?? 0
  const active = run.runningAgentCount ?? run.agents.filter((agent) => agent.status === "running").length
  const queued = run.queuedAgentCount ?? run.agents.filter((agent) => agent.status === "queued").length
  const done =
    (run.completedAgentCount ?? run.agents.filter((agent) => agent.status === "completed").length) +
    (run.cachedAgentCount ?? run.agents.filter((agent) => agent.status === "cached").length)
  const failed = run.failedAgentCount ?? run.agents.filter((agent) => agent.status === "failed").length
  return { total, active, queued, done, failed }
}

function runStatLine(run: WorkflowRunRecord) {
  const stats = runStats(run)
  const parts = [`${stats.total} agents`, elapsed(run.createdAt, run.completedAt ?? Date.now()), runStatusLabel(run)]
  if (stats.active) parts.push(`${stats.active} active`)
  if (stats.queued) parts.push(`${stats.queued} queued`)
  if (stats.failed) parts.push(`${stats.failed} failed`)
  return parts.filter(Boolean).join(" - ")
}

function latestActivity(run: WorkflowRunRecord) {
  const tool = run.agents.findLast((agent) => agent.latestTool)?.latestTool
  if (tool) return compactText(`${tool.tool}: ${toolAction(tool)}`, 72)
  const log = run.logs.findLast((item) => item.message)
  if (log) return compactText(log.message, 72)
  return compactText(run.description, 72)
}

function runTitleLine(run: WorkflowRunRecord, active: boolean, width: number) {
  return clipCells(`${active ? ">" : " "} ${run.workflowName}`, width)
}

function runDetailLine(run: WorkflowRunRecord, width: number) {
  const activity = latestActivity(run)
  const detail = [runStatLine(run), activity].filter(Boolean).join(" - ")
  return clipCells(`  ${detail}`, width)
}

function phaseLine(
  title: string,
  index: number,
  status: PhaseDisplayStatus,
  activity: PhaseActivity | undefined,
  active: boolean,
  width: number,
) {
  const prefix = `${active ? ">" : " "} ${index + 1} `
  const progress = phaseProgress(activity)
  const suffix = progress ? ` ${progress} ${phaseGlyph(status)}` : ` ${phaseGlyph(status)}`
  const room = width - cellLength(prefix) - cellLength(suffix)
  if (room < 6) return clipCells(`${prefix}${title}${suffix}`, width)
  return `${prefix}${clipCells(title, room)}${suffix}`
}

function phaseHeaderLine(title: string, count: number, status: PhaseDisplayStatus, width: number) {
  const suffix = count ? ` - ${count} agents` : ` - ${phaseStatusLabel(status)}`
  const room = width - cellLength(suffix)
  if (room < 10) return clipCells(title, width)
  return `${clipCells(title, room)}${suffix}`
}

function agentRenderLine(agent: PhaseAgentView, width: number) {
  const prefix = `${agentGlyph(agent.status)} `
  const meta = [agentToolLabel(agent), elapsed(agent.startedAt, agent.completedAt ?? Date.now())]
    .filter(Boolean)
    .join(" - ")
  const suffix = meta ? ` - ${meta}` : ""
  const room = width - cellLength(prefix) - cellLength(suffix)
  if (room < 8) return clipCells(`${prefix}${agent.label}${suffix}`, width)
  return `${prefix}${clipCells(agent.label, room)}${suffix}`
}

function toolRenderLine(tool: WorkflowAgentToolProgress, width: number) {
  const prefix = `  ${toolGlyph(tool.status)} `
  return `${prefix}${clipCells(latestToolLine(tool), width - cellLength(prefix))}`
}

export function DialogWorkflow() {
  const dialog = useDialog()
  const route = useRoute()
  const sdk = useSDK()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()

  const sessionID = createMemo(() => (route.data.type === "session" ? route.data.sessionID : undefined))
  const [selectedRun, setSelectedRun] = createSignal<string>()
  const [selectedPhase, setSelectedPhase] = createSignal(0)
  const [tick, setTick] = createSignal(0)

  async function fetchRuns() {
    const id = sessionID()
    if (!id) return []
    const url = new URL("/workflow", sdk.baseUrl)
    url.searchParams.set("sessionID", id)
    const res = await sdk.fetch(url)
    if (!res.ok) return []
    return (await res.json()) as WorkflowRunRecord[]
  }

  const [runs, { refetch }] = createResource(() => `${sessionID() ?? ""}:${tick()}`, fetchRuns, { initialValue: [] })

  onMount(() => {
    dialog.setSize("large")
  })

  const timer = setInterval(() => {
    if (runs().some((item) => item.status === "running")) setTick((x) => x + 1)
  }, 5000)
  onCleanup(() => clearInterval(timer))

  const unsubscribe = sdk.event.on("workflow.updated" as any, (evt: any) => {
    if (evt.properties.sessionID !== sessionID()) return
    void refetch()
  }) as unknown as (() => void) | undefined
  onCleanup(() => unsubscribe?.())

  createEffect(() => {
    const all = runs()
    if (!all.length) {
      setSelectedRun(undefined)
      setSelectedPhase(0)
      return
    }
    const current = selectedRun()
    if (!current || !all.some((run) => run.runId === current)) {
      setSelectedRun(all[0]?.runId)
      setSelectedPhase(0)
    }
  })

  const run = createMemo(() => runs().find((item) => item.runId === selectedRun()) ?? runs()[0])
  const summary = createMemo(() => {
    const all = runs()
    const running = all.filter((item) => item.status === "running").length
    const completed = all.filter((item) => item.status === "completed").length
    const failed = all.filter((item) => item.status === "failed").length
    const stopped = all.filter((item) => item.status === "aborted").length
    return `${running} running - ${completed} completed - ${failed} failed - ${stopped} stopped`
  })
  const phases = createMemo(() => {
    const current = run()
    if (!current) return []
    const fromMeta: WorkflowPhaseMeta[] = current.phases.length
      ? current.phases
      : [{ title: current.phase ?? DEFAULT_WORKFLOW_PHASE }]
    const seen = new Set(fromMeta.map((item) => item.title))
    const extra = [
      current.phase,
      ...current.agents.map((agent) => agent.phase),
      ...(current.workUnits ?? []).map((unit) => unit.phase),
      ...current.logs.map((log) => log.phase),
    ]
      .filter((title): title is string => !!title && !seen.has(title))
      .map((title): WorkflowPhaseMeta => {
        seen.add(title)
        return { title }
      })
    return [...fromMeta, ...extra]
  })
  const phase = createMemo(() => phases()[selectedPhase()])
  const activities = createMemo(() => {
    const current = run()
    return current ? phaseActivities(current) : new Map<string, PhaseActivity>()
  })
  const phaseAgents = createMemo(() => {
    const selected = phase()
    if (!selected) return []
    return activities().get(selected.title)?.agents ?? []
  })
  const maxHeight = createMemo(() => Math.max(12, dimensions().height - Math.floor(dimensions().height / 4) - 8))
  const dialogWidth = createMemo(() => Math.max(20, Math.min(80, dimensions().width - 2)))
  const contentWidth = createMemo(() => Math.max(16, dialogWidth() - 6))
  const phasePaneWidth = createMemo(() => {
    const width = contentWidth()
    const preferred = Math.min(32, Math.max(22, Math.floor(width * 0.34)))
    return Math.max(16, Math.min(preferred, width - 28))
  })
  const rightPaneWidth = createMemo(() => Math.max(12, contentWidth() - phasePaneWidth() - 9))

  createEffect(() => {
    const count = phases().length
    if (count === 0 && selectedPhase() !== 0) {
      setSelectedPhase(0)
      return
    }
    if (count > 0 && selectedPhase() >= count) setSelectedPhase(count - 1)
  })

  function movePhase(direction: number) {
    const count = phases().length
    if (!count) return
    let next = selectedPhase() + direction
    if (next < 0) next = count - 1
    if (next >= count) next = 0
    setSelectedPhase(next)
  }

  function moveRun(direction: number) {
    const all = runs()
    if (!all.length) return
    const current = all.findIndex((item) => item.runId === selectedRun())
    const index = current < 0 ? 0 : current
    let next = index + direction
    if (next < 0) next = all.length - 1
    if (next >= all.length) next = 0
    setSelectedRun(all[next]?.runId)
    setSelectedPhase(0)
  }

  async function cancelRun() {
    const current = run()
    const id = sessionID()
    if (!current || !id || current.status !== "running") return
    const url = new URL(`/workflow/${id}/${current.runId}/cancel`, sdk.baseUrl)
    const res = await sdk.fetch(url, { method: "POST" })
    if (res.ok) void refetch()
  }

  useDialogKeyboard((evt) => {
    if (evt.name === "up") {
      movePhase(-1)
      evt.preventDefault()
      return
    }
    if (evt.name === "down") {
      movePhase(1)
      evt.preventDefault()
      return
    }
    if (evt.name === "left") {
      moveRun(-1)
      evt.preventDefault()
      return
    }
    if (evt.name === "right") {
      moveRun(1)
      evt.preventDefault()
      return
    }
    if (evt.name === "c") {
      void cancelRun()
      evt.preventDefault()
      return
    }
  })

  return (
    <box paddingLeft={3} paddingRight={3} paddingBottom={1} flexDirection="column" gap={1}>
      <box flexDirection="column" gap={0}>
        <text fg={theme.primary} attributes={TextAttributes.BOLD}>
          Workflows
        </text>
        <text fg={theme.textMuted} wrapMode="none" overflow="hidden">
          {clipCells("left/right run - up/down phase - c cancel - esc close", contentWidth())}
        </text>
      </box>
      <text fg={theme.textMuted}>{summary()}</text>
      <Show
        when={run()}
        fallback={
          <box paddingTop={1}>
            <text fg={theme.textMuted}>No workflow runs for this session.</text>
          </box>
        }
      >
        {(current) => (
          <>
            <box flexDirection="column" gap={0}>
              <For each={runs()}>
                {(item) => {
                  const active = createMemo(() => item.runId === current().runId)
                  return (
                    <box
                      flexDirection="column"
                      gap={0}
                      paddingLeft={active() ? 0 : 1}
                      backgroundColor={active() ? theme.backgroundPanel : undefined}
                      onMouseUp={() => {
                        setSelectedRun(item.runId)
                        setSelectedPhase(0)
                      }}
                    >
                      <text
                        fg={runColor(theme, item)}
                        attributes={TextAttributes.BOLD}
                        wrapMode="none"
                        overflow="hidden"
                      >
                        {runTitleLine(item, active(), contentWidth() - (active() ? 0 : 1))}
                      </text>
                      <text fg={theme.textMuted} wrapMode="none" overflow="hidden">
                        {runDetailLine(item, contentWidth() - (active() ? 0 : 1))}
                      </text>
                    </box>
                  )
                }}
              </For>
            </box>

            <box
              flexDirection="row"
              gap={2}
              border={["top", "bottom", "left", "right"]}
              borderColor={theme.primary}
              paddingLeft={1}
              paddingRight={1}
              paddingTop={1}
              paddingBottom={1}
            >
              <box width={phasePaneWidth()} flexDirection="column" gap={0}>
                <text fg={theme.text} attributes={TextAttributes.BOLD}>
                  Phases
                </text>
                <For each={phases()} fallback={<text fg={theme.textMuted}>No phases</text>}>
                  {(item, index) => {
                    const active = createMemo(() => index() === selectedPhase())
                    const activity = createMemo(() => activities().get(item.title))
                    const status = createMemo(() => phaseDisplayStatus(current(), phases(), index(), activity()))
                    const color = createMemo(() => {
                      if (active()) return theme.primary
                      if (status() === "failed" || status() === "aborted") return theme.error
                      if (status() === "running") return theme.warning
                      if (status() === "completed") return theme.success
                      return theme.textMuted
                    })
                    return (
                      <box paddingLeft={active() ? 0 : 1} onMouseUp={() => setSelectedPhase(index())}>
                        <text fg={active() ? theme.text : color()} wrapMode="none" overflow="hidden">
                          {phaseLine(
                            item.title,
                            index(),
                            status(),
                            activity(),
                            active(),
                            phasePaneWidth() - (active() ? 0 : 1),
                          )}
                        </text>
                      </box>
                    )
                  }}
                </For>
              </box>

              <box width={1} backgroundColor={theme.primary} />

              <scrollbox
                maxHeight={maxHeight()}
                flexGrow={1}
                scrollbarOptions={{ visible: false }}
                flexDirection="column"
                gap={1}
              >
                <Show when={phase()} keyed>
                  {(selected) => {
                    const activity = createMemo(() => activities().get(selected.title))
                    const status = createMemo(() =>
                      phaseDisplayStatus(current(), phases(), selectedPhase(), activity()),
                    )
                    return (
                      <box flexDirection="column" gap={1}>
                        <box flexDirection="column" gap={0}>
                          <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none" overflow="hidden">
                            {phaseHeaderLine(
                              selected.title,
                              activity()?.agents.length ?? 0,
                              status(),
                              rightPaneWidth(),
                            )}
                          </text>
                          <Show when={selected.detail}>
                            <text fg={theme.textMuted} wrapMode="word">
                              {selected.detail}
                            </text>
                          </Show>
                          <Show when={current().scriptPath}>
                            <text fg={theme.textMuted} wrapMode="none" overflow="hidden">
                              {clipCells(current().scriptPath ?? "", rightPaneWidth())}
                            </text>
                          </Show>
                        </box>

                        <Show
                          when={phaseAgents().length}
                          fallback={<text fg={theme.textMuted}>{emptyPhaseMessage(status())}</text>}
                        >
                          <For each={phaseAgents()}>
                            {(agent) => (
                              <box flexDirection="column" gap={0} paddingBottom={1}>
                                <text fg={agentColor(theme, agent.status)} wrapMode="none" overflow="hidden">
                                  {agentRenderLine(agent, rightPaneWidth())}
                                </text>
                                <Show when={agent.error}>
                                  <text fg={theme.error} wrapMode="none" overflow="hidden">
                                    {clipCells(agent.error ?? "", rightPaneWidth())}
                                  </text>
                                </Show>
                                <Show when={agent.latestTool}>
                                  {(tool) => (
                                    <text fg={toolColor(theme, tool().status)} wrapMode="none" overflow="hidden">
                                      {toolRenderLine(tool(), rightPaneWidth())}
                                    </text>
                                  )}
                                </Show>
                              </box>
                            )}
                          </For>
                        </Show>
                      </box>
                    )
                  }}
                </Show>
              </scrollbox>
            </box>
          </>
        )}
      </Show>
    </box>
  )
}
