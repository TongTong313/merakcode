import type { Event } from "@merakcode/sdk/client"
import Folder from "lucide-solid/icons/folder"
import GitBranch from "lucide-solid/icons/git-branch"
import { createSignal, Show } from "solid-js"
import { produce } from "solid-js/store"
import { applyEvent } from "@merakcode/sdk/store"
import { useNavigate } from "@solidjs/router"
import { t } from "../../i18n"
import { mac } from "../../lib/bridge"
import { baseName, sessionPath } from "../../lib/route"
import { choice, choose } from "../../state/models"
import { call, client } from "../../state/client"
import { folderOf, setState, state } from "../../state/store"
import { Switch } from "../../ui/switch"
import { Frame } from "../shell/frame"
import { toast } from "../../ui/toast"
import { Composer, type Submission } from "./composer"
import { createWorktree, send } from "./send"

const mod = mac ? "⌘" : "Ctrl"

/**
 * New conversation: choose where it runs (the current directory or a new worktree); the session is created only when
 * the first message is sent
 */
export function Compose(props: { directory: string }) {
  const navigate = useNavigate()
  const [worktree, setWorktree] = createSignal(false)
  const [creating, setCreating] = createSignal(false)
  const folder = () => folderOf(props.directory)
  const git = () => folder()?.project?.vcs === "git"
  const branch = () => state.branch[props.directory]

  const submit = async (submission: Submission) => {
    setCreating(true)
    try {
      const picked = choice(undefined, props.directory)
      const dir = worktree() ? (await createWorktree(props.directory, branch())).directory : props.directory
      const info = await call(client(dir).session.create({}))
      setState(
        "sessions",
        produce((draft) => applyEvent(draft, { type: "session.created", properties: { info } } as Event)),
      )
      // Carry the model and mode chosen for the new conversation over to the session
      choose(info.id, props.directory, { model: picked.model, variant: picked.variant, mode: picked.mode })
      await send(info.id, props.directory, submission, picked.mode)
      navigate(sessionPath(props.directory, info.id))
    } catch (error) {
      toast({ kind: "error", title: t("error.request", { message: (error as Error).message }) })
      throw error
    } finally {
      setCreating(false)
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
            <Show when={git() && branch()}>
              <span class="chip outlined">
                <GitBranch class="icon icon-sm" />
                {branch()}
              </span>
            </Show>
            <Show when={git()}>
              <Switch
                class="chip"
                label={t("compose.worktree")}
                checked={worktree()}
                onChange={setWorktree}
                disabled={creating()}
              >
                <Show when={branch()}>
                  <span class="subtle">{t("compose.worktreeBase", { branch: branch()! })}</span>
                </Show>
              </Switch>
            </Show>
            <Show when={creating() && worktree()}>
              <span class="subtle">{t("compose.creatingWorktree")}</span>
            </Show>
          </div>
          <Composer
            directory={props.directory}
            busy={false}
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
