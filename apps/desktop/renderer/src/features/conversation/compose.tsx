import Folder from "lucide-solid/icons/folder"
import Plus from "lucide-solid/icons/plus"
import X from "lucide-solid/icons/x"
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { t } from "../../i18n"
import { mac } from "../../lib/bridge"
import { baseName, sessionPath } from "../../lib/route"
import { agents, chatTargets, loadAgents } from "../../state/agents"
import { client } from "../../state/client"
import { rememberDriver } from "../../state/external"
import { choice, choose } from "../../state/models"
import { ensureSession } from "../../state/store"
import { gitState, identityOf, refreshBranches, switching } from "../../state/git"
import { Select } from "../../ui/select"
import { toast } from "../../ui/toast"
import { BranchPicker } from "../git/branch-picker"
import { promotePanels } from "../panel/workspace"
import { Frame } from "../shell/frame"
import { Composer, type ComposerDraft, type Submission } from "./composer"
import { createWorktree, send, type WorktreeAttempt } from "./send"

/** The choice of the target selector that stands for MerakCode itself */
const OWN = "merak"

/** What a new conversation has prepared so far: where it runs, the starting branch and the unsent draft. */
function preparation() {
  const [worktree, setWorktree] = createSignal(false)
  const [creating, setCreating] = createSignal(false)
  const [base, setBase] = createSignal<string>()
  const [draft, setDraft] = createSignal<ComposerDraft>()
  /** The agent of an external product the conversation is held with; none means MerakCode */
  const [agent, setAgent] = createSignal<string>()
  return {
    agent,
    setAgent,
    worktree,
    setWorktree,
    creating,
    setCreating,
    base,
    setBase,
    draft,
    setDraft,
    attempt: undefined as WorktreeAttempt | undefined,
    /** The session of each target directory; the key lets a retry after a lost answer find the same one */
    sessions: new Map<string, { key: string; id?: string }>(),
  }
}
const preparations = new Map<string, ReturnType<typeof preparation>>()
function preparationFor(directory: string) {
  const known = preparations.get(directory)
  if (known) return known
  const created = preparation()
  preparations.set(directory, created)
  return created
}

/** An external conversation exists once its product has started: waits until the window can read it. */
async function started(id: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const known = await ensureSession(id).then(
      () => true,
      () => false,
    )
    if (known) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/**
 * New conversation: choose where it runs (the current directory or a new worktree); the session is created only when
 * the first message is sent.
 */
export function Compose(props: { directory: string }) {
  const navigate = useNavigate()
  let disposed = false
  onCleanup(() => {
    disposed = true
  })
  const prepared = () => preparationFor(props.directory)
  const agent = () => prepared().agent()
  // The list is read again when the selector is reached; the options only change when what they show changes, so an
  // open list is not rebuilt under the pointer
  const choices = createMemo(
    () => [
      { value: OWN, label: "MerakCode" },
      ...chatTargets(agents()).map((target) => ({ value: target.id, label: target.name })),
    ],
    undefined,
    {
      equals: (a, b) =>
        a.length === b.length && a.every((item, i) => item.value === b[i]!.value && item.label === b[i]!.label),
    },
  )
  // Once a first message was sent the conversation belongs to its target
  const targetLocked = () => [...prepared().sessions.values()].some((pending) => pending.id)
  onMount(() => void loadAgents().catch(() => undefined))
  const worktree = () => prepared().worktree()
  const creating = () => prepared().creating()
  const git = () => !!identityOf(props.directory)
  const branch = () => identityOf(props.directory)?.branch ?? undefined
  const unborn = () => gitState(props.directory)?.options?.blocked?.reason === "unborn"
  createEffect(() => {
    void refreshBranches(props.directory)
  })
  const prepareWorktree = () => {
    if (creating() || switching(props.directory) || unborn()) return
    const current = prepared()
    current.setBase(branch() ?? identityOf(props.directory)?.head ?? undefined)
    current.setWorktree(true)
    current.attempt ??= { key: `task-${crypto.randomUUID().slice(0, 8)}` }
  }

  const submit = async (submission: Submission) => {
    const directory = props.directory
    const current = prepared()
    if (current.creating() || switching(directory)) throw new Error(t("git.blocked.busy"))
    current.setCreating(true)
    try {
      const selected = choice(undefined, directory)
      const external = agent()
      if (!external && !selected.model) throw new Error("MRK-3001")
      const target = current.worktree()
        ? (await createWorktree(directory, current.base(), current.attempt)).path
        : directory
      const pending = current.sessions.get(target) ?? { key: crypto.randomUUID() }
      current.sessions.set(target, pending)
      // The same key returns the same session, so a retry after a lost answer does not start a second one
      const created = await (
        await client()
      ).session.create({
        key: pending.key,
        ...(external
          ? { agent: external }
          : { provider: selected.model!.providerID, model: selected.model!.modelID, thinking: selected.variant }),
        mode: selected.mode,
        workdir: target,
      })
      pending.id = created.session
      if (external) {
        rememberDriver(created.session, external)
      } else {
        await ensureSession(created.session)
        choose(created.session, directory, selected)
      }
      await send(created.session, directory, submission)
      if (external) await started(created.session)
      await promotePanels(directory, { directory: target, sessionID: created.session }).catch(() =>
        toast({ kind: "error", title: t("panel.persistError") }),
      )
      current.setDraft(undefined)
      preparations.delete(directory)
      if (!disposed && props.directory === directory) navigate(sessionPath(directory, created.session))
    } finally {
      current.setCreating(false)
    }
  }

  return (
    <Frame
      directory={props.directory}
      folder={props.directory}
      title={<span class="title ellipsis">{t("sidebar.new")}</span>}
    >
      <div class="compose-page">
        <h1 class="compose-heading">{t("compose.heading", { name: baseName(props.directory) })}</h1>
        <div class="compose-wrap">
          <div class="context-row">
            <Select
              label={t("conversation.target")}
              value={agent() ?? OWN}
              options={choices()}
              disabled={creating() || targetLocked()}
              onChange={(id) => !creating() && !targetLocked() && prepared().setAgent(id === OWN ? undefined : id)}
            />
            <span class="chip outlined">
              <Folder class="icon icon-sm" />
              <span class="ellipsis" title={props.directory}>
                {baseName(props.directory)}
              </span>
            </span>
            <Show when={git()}>
              <BranchPicker
                directory={props.directory}
                purpose="switch"
                disabled={creating()}
                onWorktree={prepareWorktree}
              />
              <Show
                when={worktree()}
                fallback={
                  <button
                    class="button ghost sm"
                    onClick={prepareWorktree}
                    disabled={creating() || switching(props.directory) || unborn()}
                    title={unborn() ? t("git.blocked.unborn") : undefined}
                  >
                    <Plus class="icon icon-xs" />
                    {t("compose.newWorktree")}
                  </button>
                }
              >
                <span class="worktree-preparation">
                  <span class="subtle">{t("compose.newWorktree")}</span>
                  <BranchPicker
                    directory={props.directory}
                    purpose="start"
                    value={prepared().base()}
                    onSelect={(base) => prepared().setBase(base)}
                    disabled={creating() || !!prepared().attempt?.info}
                  />
                  <button
                    class="icon-button sm"
                    aria-label={t("compose.cancelWorktree")}
                    disabled={creating() || !!prepared().attempt?.info}
                    onClick={() => {
                      prepared().setWorktree(false)
                      prepared().attempt = undefined
                    }}
                  >
                    <X class="icon icon-xs" />
                  </button>
                </span>
              </Show>
            </Show>
            <Show when={creating() && worktree()}>
              <span class="subtle">{t("compose.creatingWorktree")}</span>
            </Show>
          </div>
          <Show when={worktree()}>
            <p class="branch-notice">{t("compose.worktreeHint", { branch: branch() ?? "HEAD" })}</p>
          </Show>
          <Composer
            directory={props.directory}
            busy={false}
            external={!!agent()}
            disabled={creating() || switching(props.directory)}
            autofocus
            draft={prepared().draft()}
            onDraftChange={(draft) => prepared().setDraft(draft)}
            onSubmit={submit}
          />
          <div class="hints">
            <span>
              <kbd>{mac ? "⌘" : "Ctrl"} K</kbd>
              {t("compose.hint.palette")}
            </span>
            <span>
              <kbd>{mac ? "⌘" : "Ctrl"} J</kbd>
              {t("compose.hint.terminal")}
            </span>
          </div>
        </div>
      </div>
    </Frame>
  )
}
