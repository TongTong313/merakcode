import ArrowLeft from "lucide-solid/icons/arrow-left"
import Ellipsis from "lucide-solid/icons/ellipsis"
import GitBranch from "lucide-solid/icons/git-branch"
import GitMerge from "lucide-solid/icons/git-merge"
import Undo2 from "lucide-solid/icons/undo-2"
import { createEffect, createMemo, createSignal, on, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { t } from "../../i18n"
import { sameDir, sessionPath } from "../../lib/route"
import { call, client } from "../../state/client"
import { busy, ensureSession, folderOf, messages, pending, session, state } from "../../state/store"
import { choose } from "../../state/models"
import { ui } from "../../state/ui"
import { Confirm, Dialog } from "../../ui/dialog"
import { Menu } from "../../ui/menu"
import { Switch } from "../../ui/switch"
import { toast } from "../../ui/toast"
import { ReviewFull } from "../review/full"
import { openReview } from "../review/state"
import { Frame } from "../shell/frame"
import { Rename } from "../shell/rename"
import { Composer } from "./composer"
import { Approval, Question } from "./dock"
import { Messages } from "./messages"
import { restore, send, stop } from "./send"

/**
 * Discards a worktree conversation: deletes the conversation first (while its worktree directory still exists), then
 * the worktree directory and branch, and returns to a new conversation in the project. A worktree conversation lives
 * and dies with its worktree, so a conversation is never left pointing at a removed directory.
 */
async function discard(sessionID: string, worktree: string, directory: string, navigate: (path: string) => void) {
  navigate(sessionPath(directory))
  await call(client(worktree).session.delete({ sessionID }))
  await call(client(directory).worktree.remove({ worktreeRemoveInput: { directory: worktree } }))
}

/**
 * Merges a worktree conversation into the current branch of the main checkout; by default the worktree and the
 * conversation are cleaned up afterwards
 */
function Merge(props: {
  open: boolean
  onClose: () => void
  sessionID: string
  worktree: string
  directory: string
  branch: string
}) {
  const navigate = useNavigate()
  const [squash, setSquash] = createSignal(false)
  const [cleanup, setCleanup] = createSignal(true)
  const [message, setMessage] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const merge = async () => {
    setBusy(true)
    const result = await call(
      client(props.directory).worktree.merge({
        worktreeMergeInput: {
          directory: props.worktree,
          squash: squash(),
          ...(message().trim() ? { message: message().trim() } : {}),
        },
      }),
    ).catch((error: Error) => ({ ok: false as const, reason: "failed" as const, message: error.message }))
    setBusy(false)
    props.onClose()
    if (result.ok) {
      toast({ kind: "success", title: t("merge.done", { branch: props.branch }) })
      if (cleanup())
        await discard(props.sessionID, props.worktree, props.directory, navigate).catch((error: Error) =>
          toast({ kind: "error", title: t("error.request", { message: error.message }), error: error }),
        )
      return
    }
    toast({
      kind: "error",
      title:
        result.reason === "conflict"
          ? t("merge.conflict", { files: result.files.join(", ") })
          : t("merge.failed", { message: result.message }),
    })
  }
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => !open && props.onClose()}
      title={t("merge.title", { branch: props.branch })}
      description={t("merge.detail", { branch: props.branch })}
      footer={
        <>
          <button class="button secondary" onClick={props.onClose}>
            {t("common.cancel")}
          </button>
          <button class="button primary" disabled={busy()} onClick={() => void merge()}>
            {t("merge.confirm")}
          </button>
        </>
      }
    >
      <div class="dialog-body form">
        <div class="field">
          <label for="merge-message">{t("merge.message")}</label>
          <input
            id="merge-message"
            class="input"
            value={message()}
            onInput={(event) => setMessage(event.currentTarget.value)}
          />
        </div>
        <Switch label={t("merge.squash")} checked={squash()} onChange={setSquash} />
        <Switch label={t("merge.cleanup")} checked={cleanup()} onChange={setCleanup} />
      </div>
    </Dialog>
  )
}

/** A conversation: messages, permissions and questions, composer, side panel and bottom terminal */
export function Conversation(props: { id: string; directory: string }) {
  const navigate = useNavigate()
  const [merging, setMerging] = createSignal(false)
  const [renaming, setRenaming] = createSignal(false)
  const [discarding, setDiscarding] = createSignal(false)
  const info = () => session(props.id)
  const folder = () => folderOf(props.directory)
  const dir = () => info()?.directory ?? props.directory
  /** Worktree directory, when the conversation runs in a worktree */
  const worktree = () => {
    const value = info()
    return value && folder()?.project?.vcs === "git" && !sameDir(value.directory, props.directory)
      ? value.directory
      : undefined
  }
  const requests = createMemo(() => pending(props.id))
  const running = () => busy(props.id)

  createEffect(
    on(
      () => props.id,
      (id) => {
        void ensureSession(id, props.directory)
          .then(() => messages(id))
          .catch((error: Error) => toast({ kind: "error", title: t("conversation.notFound"), detail: error.message }))
      },
    ),
  )

  const reviewTurn = (messageID: string) => openReview({ scope: "turn", messageID })
  const reviewFile = (file: string) => openReview({ scope: "session", file })

  return (
    <Show
      when={!ui.maximized}
      fallback={<ReviewFull sessionID={props.id} directory={dir()} folder={props.directory} />}
    >
      <Frame
        sessionID={props.id}
        directory={dir()}
        folder={props.directory}
        title={
          <>
            <Show when={info()?.parentID}>
              {(parent) => (
                <button
                  class="button ghost sm no-drag"
                  onClick={() => navigate(sessionPath(props.directory, parent()))}
                >
                  <ArrowLeft class="icon icon-xs" />
                  {t("conversation.backToParent")}
                </button>
              )}
            </Show>
            <span class="title ellipsis">{info()?.title ?? ""}</span>
            <Show when={worktree()}>
              <span class="chip outlined no-drag">
                <GitBranch class="icon icon-sm" />
                {state.branch[worktree()!] ?? ""}
                <span class="subtle">← {state.branch[props.directory] ?? ""}</span>
              </span>
              <button class="button secondary sm no-drag" onClick={() => setMerging(true)}>
                <GitMerge class="icon icon-xs" />
                {t("topbar.merge", { branch: state.branch[props.directory] ?? "" })}
              </button>
            </Show>
            <Show when={requests().permissions.length}>
              <span class="badge warning">{t("status.approval")}</span>
            </Show>
          </>
        }
        actions={
          <Menu
            label={t("topbar.menu")}
            trigger={<Ellipsis class="icon" />}
            items={[
              { label: t("sidebar.new"), onSelect: () => navigate(sessionPath(props.directory)) },
              { label: t("sidebar.rename"), onSelect: () => setRenaming(true) },
              { label: t("palette.cmd.review"), onSelect: () => openReview({ scope: "session" }) },
              ...(worktree()
                ? [
                    "separator" as const,
                    { label: t("worktree.discard"), danger: true, onSelect: () => setDiscarding(true) },
                  ]
                : []),
            ]}
          />
        }
      >
        <Messages sessionID={props.id} directory={dir()} onReviewTurn={reviewTurn} onReviewFile={reviewFile} />
        <div class="dock">
          <div class="dock-inner">
            <Show when={!running() && (info()?.undoRedo?.stack.length ?? 0) > 0}>
              <div class="revert-bar" role="status">
                <Undo2 class="icon icon-sm" />
                <span class="ellipsis">{t("conversation.reverted")}</span>
                <span class="spacer" />
                <button
                  class="button secondary sm"
                  onClick={() =>
                    void restore(props.id, props.directory).catch((error: Error) =>
                      toast({ kind: "error", title: t("error.request", { message: error.message }), error: error }),
                    )
                  }
                >
                  {t("conversation.restore")}
                </button>
              </div>
            </Show>
            <Show when={requests().permissions[0]}>
              {(request) => <Approval request={request()} more={requests().permissions.length - 1} directory={dir()} />}
            </Show>
            <Show when={!requests().permissions.length && requests().questions[0]}>
              {(request) => <Question request={request()} directory={dir()} />}
            </Show>
            <Composer
              sessionID={props.id}
              directory={props.directory}
              busy={running()}
              compact
              autofocus
              onSubmit={(submission) => send(props.id, props.directory, submission)}
              onStop={() => void stop(props.id, props.directory)}
              onMode={(mode) => {
                choose(props.id, props.directory, { mode })
                void call(client(dir()).session.setPermissionMode({ sessionID: props.id, permissionMode: mode })).catch(
                  (error: Error) =>
                    toast({ kind: "error", title: t("error.request", { message: error.message }), error: error }),
                )
              }}
            />
          </div>
        </div>
        <Show when={info()}>
          {(value) => <Rename session={value()} open={renaming()} onClose={() => setRenaming(false)} />}
        </Show>
        <Show when={worktree()}>
          <Merge
            open={merging()}
            onClose={() => setMerging(false)}
            sessionID={props.id}
            worktree={worktree()!}
            directory={props.directory}
            branch={state.branch[props.directory] ?? ""}
          />
          <Confirm
            open={discarding()}
            title={t("worktree.discardTitle")}
            description={t("worktree.discardDetail", { branch: state.branch[worktree()!] ?? "" })}
            confirm={t("sidebar.delete")}
            cancel={t("common.cancel")}
            danger
            onResult={(ok) => {
              setDiscarding(false)
              if (ok)
                void discard(props.id, worktree()!, props.directory, navigate).catch((error: Error) =>
                  toast({ kind: "error", title: t("error.request", { message: error.message }), error: error }),
                )
            }}
          />
        </Show>
      </Frame>
    </Show>
  )
}
