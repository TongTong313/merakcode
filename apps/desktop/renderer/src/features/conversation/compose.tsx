import Folder from "lucide-solid/icons/folder"
import { createEffect, createSignal, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { t } from "../../i18n"
import { baseName, sessionPath } from "../../lib/route"
import { client } from "../../state/client"
import { choice, choose } from "../../state/models"
import { ensureSession } from "../../state/store"
import { identityOf, refreshBranches } from "../../state/git"
import { BranchPicker } from "../git/branch-picker"
import { Frame } from "../shell/frame"
import { Composer, type ComposerDraft, type Submission } from "./composer"
import { send } from "./send"

const drafts = new Map<string, { draft?: ComposerDraft; id?: string }>()

export function Compose(props: { directory: string }) {
  const navigate = useNavigate()
  const [creating, setCreating] = createSignal(false)
  createEffect(() => {
    void refreshBranches(props.directory)
  })
  const preparation = () => {
    if (!drafts.has(props.directory)) drafts.set(props.directory, {})
    return drafts.get(props.directory)!
  }
  const submit = async (submission: Submission) => {
    const directory = props.directory
    const prepared = preparation()
    const selected = choice(undefined, directory)
    if (!selected.model) throw new Error("MRK-3001")
    setCreating(true)
    try {
      prepared.id ??= (
        await (
          await client()
        ).session.create({
          provider: selected.model.providerID,
          model: selected.model.modelID,
          thinking: selected.variant,
          mode: selected.mode,
          workdir: directory,
        })
      ).session
      await ensureSession(prepared.id)
      choose(prepared.id, directory, selected)
      await send(prepared.id, directory, submission)
      drafts.delete(directory)
      navigate(sessionPath(directory, prepared.id))
    } finally {
      setCreating(false)
    }
  }
  return (
    <Frame
      directory={props.directory}
      folder={props.directory}
      title={<span class="title ellipsis">{baseName(props.directory)}</span>}
    >
      <div class="compose-page">
        <h1 class="compose-heading">{t("compose.heading", { name: baseName(props.directory) })}</h1>
        <div class="compose-options context-row">
          <span class="chip outlined">
            <Folder class="icon icon-sm" />
            {baseName(props.directory)}
          </span>
          <Show when={identityOf(props.directory)}>
            <BranchPicker directory={props.directory} purpose="switch" />
          </Show>
        </div>
        <Composer
          directory={props.directory}
          busy={false}
          disabled={creating()}
          autofocus
          draft={preparation().draft}
          onDraftChange={(draft) => {
            preparation().draft = draft
          }}
          onSubmit={submit}
        />
      </div>
    </Frame>
  )
}
