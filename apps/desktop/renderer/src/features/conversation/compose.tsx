import type { Event } from "@merakcode/sdk/client"
import Folder from "lucide-solid/icons/folder"
import Plus from "lucide-solid/icons/plus"
import X from "lucide-solid/icons/x"
import { createEffect, createSignal, on, Show } from "solid-js"
import { produce } from "solid-js/store"
import { applyEvent } from "@merakcode/sdk/store"
import { useNavigate } from "@solidjs/router"
import { t } from "../../i18n"
import { mac } from "../../lib/bridge"
import { baseName, sameDir, sessionPath } from "../../lib/route"
import { choice, choose } from "../../state/models"
import { call, client } from "../../state/client"
import { gitState, refreshBranches, switching } from "../../state/git"
import { folderOf, setState, state } from "../../state/store"
import { Frame } from "../shell/frame"
import { BranchPicker } from "../git/branch-picker"
import { Composer, type ComposerDraft, type Submission } from "./composer"
import { createWorktree, send, type WorktreeAttempt } from "./send"

const mod = mac ? "⌘" : "Ctrl"

function preparation() {
  const [worktree, setWorktree] = createSignal(false)
  const [creating, setCreating] = createSignal(false)
  const [base, setBase] = createSignal<string>()
  const [draft, setDraft] = createSignal<ComposerDraft>()
  return {
    id: crypto.randomUUID(),
    worktree,
    setWorktree,
    creating,
    setCreating,
    base,
    setBase,
    draft,
    setDraft,
    attempt: undefined as WorktreeAttempt | undefined,
    sessions: new Map<string, { id?: string; requested: boolean }>(),
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

/**
 * New conversation: choose where it runs (the current directory or a new worktree); the session is created only when
 * the first message is sent
 */
export function Compose(props: { directory: string }) {
  const navigate = useNavigate()
  const prepared = () => preparationFor(props.directory)
  const worktree = () => prepared().worktree()
  const creating = () => prepared().creating()
  const worktreeBase = () => prepared().base()
  const setWorktreeBase = (base: string) => prepared().setBase(base)
  const folder = () => folderOf(props.directory)
  const git = () => folder()?.project?.vcs === "git"
  const branch = () => state.branch[props.directory]
  createEffect(
    on([git, () => props.directory], ([enabled, directory]) => {
      if (enabled) void refreshBranches(directory)
    }),
  )
  const prepareWorktree = () => {
    if (creating() || switching(props.directory)) return
    if (gitState(props.directory)?.options?.blocked?.reason === "unborn") return
    const current = prepared()
    current.setBase(branch() ?? state.head[props.directory] ?? undefined)
    current.setWorktree(true)
    current.attempt ??= { name: `task-${crypto.randomUUID().slice(0, 8)}` }
  }

  const submit = async (submission: Submission) => {
    const directory = props.directory
    const current = prepared()
    if (current.creating() || switching(directory)) throw new Error(t("git.blocked.busy"))
    current.setCreating(true)
    try {
      const picked = choice(undefined, directory)
      const dir = current.worktree()
        ? (await createWorktree(directory, current.base(), current.attempt)).directory
        : directory
      const target = [...current.sessions.keys()].find((key) => sameDir(key, dir)) ?? dir
      const pending = current.sessions.get(target) ?? { requested: false }
      current.sessions.set(target, pending)
      const info = await (async () => {
        if (pending.id) return call(client(dir).session.get({ sessionID: pending.id }))
        if (pending.requested) {
          const sessions = await call(client(dir).session.list({ roots: true, limit: 100 }))
          const found = sessions.find(
            (session) => sameDir(session.directory, dir) && session.metadata?.composeAttemptId === current.id,
          )
          if (!found) throw new Error(t("compose.sessionUncertain"))
          return found
        }
        pending.requested = true
        try {
          return await call(client(dir).session.create({ metadata: { composeAttemptId: current.id } }))
        } catch (error) {
          const status = (error as Error & { status?: number }).status
          if (status && status >= 400 && status < 500 && status !== 408) pending.requested = false
          throw error
        }
      })()
      if (!sameDir(info.directory, dir)) throw new Error(t("compose.sessionUncertain"))
      pending.id = info.id
      setState(
        "sessions",
        produce((draft) => applyEvent(draft, { type: "session.created", properties: { info } } as Event)),
      )
      // Carry the model and mode chosen for the new conversation over to the session
      choose(info.id, directory, { model: picked.model, variant: picked.variant, mode: picked.mode })
      await send(info.id, directory, submission, picked.mode)
      current.setDraft(undefined)
      preparations.delete(directory)
      if (props.directory === directory) navigate(sessionPath(directory, info.id))
    } finally {
      current.setCreating(false)
    }
  }

  return (
    <Frame title={<span class="title">{t("sidebar.new")}</span>} directory={props.directory} folder={props.directory}>
      <div class="compose-page">
        <h1 class="compose-heading">{t("compose.heading", { name: baseName(props.directory) })}</h1>
        <div class="compose-wrap">
          <div class="context-row">
            <span class="chip outlined">
              <Folder class="icon icon-sm" />
              {baseName(props.directory)}
            </span>
            <Show when={git()}>
              <BranchPicker
                directory={props.directory}
                purpose="switch"
                disabled={creating()}
                onWorktree={prepareWorktree}
              />
            </Show>
            <Show when={git()}>
              <Show
                when={worktree()}
                fallback={
                  <button
                    class="button ghost sm"
                    onClick={prepareWorktree}
                    disabled={
                      creating() ||
                      switching(props.directory) ||
                      gitState(props.directory)?.options?.blocked?.reason === "unborn"
                    }
                    title={
                      gitState(props.directory)?.options?.blocked?.reason === "unborn"
                        ? t("git.blocked.unborn")
                        : undefined
                    }
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
                    value={worktreeBase()}
                    onSelect={setWorktreeBase}
                    disabled={creating() || !!prepared().attempt?.info}
                  />
                  <button
                    class="icon-button sm"
                    aria-label={t("compose.cancelWorktree")}
                    disabled={creating() || !!prepared().attempt?.requested}
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
            draft={prepared().draft()}
            onDraftChange={(draft) => prepared().setDraft(draft)}
            busy={false}
            disabled={creating() || switching(props.directory)}
            autofocus
            onSubmit={submit}
            onMode={(mode) => choose(undefined, props.directory, { mode })}
          />
          <div class="hints">
            <span>
              <kbd>{mod} K</kbd>
              {t("compose.hint.palette")}
            </span>
            <span>
              <kbd>{mod} J</kbd>
              {t("compose.hint.terminal")}
            </span>
            <span>
              <kbd>Shift Tab</kbd>
              {t("compose.hint.mode")}
            </span>
          </div>
        </div>
      </div>
    </Frame>
  )
}
