import ArrowLeft from "lucide-solid/icons/arrow-left"
import Ellipsis from "lucide-solid/icons/ellipsis"
import GitBranch from "lucide-solid/icons/git-branch"
import GitMerge from "lucide-solid/icons/git-merge"
import Undo2 from "lucide-solid/icons/undo-2"
import Users from "lucide-solid/icons/users"
import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show } from "solid-js"
import { produce } from "solid-js/store"
import { applyEvent } from "@merakcode/sdk/store"
import type { Session } from "@merakcode/sdk/client"
import { useNavigate } from "@solidjs/router"
import { t } from "../../i18n"
import { sameDir, sessionPath } from "../../lib/route"
import { call, client } from "../../state/client"
import {
  busy,
  branchOf,
  connected,
  ensureSession,
  folderOf,
  messages,
  messagesOf,
  partsOf,
  pending,
  listen,
  session,
  setState,
} from "../../state/store"
import { choose } from "../../state/models"
import { saveLayout, setUi, ui } from "../../state/ui"
import { Confirm, Dialog } from "../../ui/dialog"
import { Menu } from "../../ui/menu"
import { Switch } from "../../ui/switch"
import { toast } from "../../ui/toast"
import { openReview } from "../review/state"
import { Frame } from "../shell/frame"
import { Rename } from "../shell/rename"
import { Composer } from "./composer"
import { switching } from "../../state/git"
import { groupState } from "./group-state"
import { working } from "./turns"
import { GroupTodo } from "./group-todo"
import { MemberColumn } from "./member-column"
import { Approval, Question } from "./dock"
import { askedBy } from "./members"
import { Messages } from "./messages"
import { historyLocked, restore, send, stop } from "./send"
import { agentConnections, connectionsLoaded, loadConnections } from "../../state/agent-connections"
import { TakeoverDialog } from "./takeover-dialog"

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
  const [opening, setOpening] = createSignal<{ target: string; at: number }>()
  const [takeoverOpen, setTakeoverOpen] = createSignal(false)
  const info = () => session(props.id)
  const isGroup = () => info()?.metadata?.group === true
  const folder = () => folderOf(props.directory)
  const dir = () => info()?.directory ?? props.directory
  const external = () => info()?.target?.kind === "external"
  const product = () => {
    const target = info()?.target
    return target?.kind === "external" ? agentConnections().find((item) => item.id === target.productID) : undefined
  }
  const productDisabled = () => external() && connectionsLoaded() && (!product() || product()?.enabled === false)
  const inputLocked = () =>
    !!info()?.targetBlock ||
    !!info()?.readOnlyReason ||
    productDisabled() ||
    (!!info()?.takeover && !external() && !connected())
  const updatedSession = (value: Session) => {
    setState(
      "sessions",
      produce((draft) =>
        applyEvent(draft, { type: "session.updated", properties: { sessionID: value.id, info: value } }),
      ),
    )
  }
  onMount(() => void loadConnections().catch(() => undefined))
  createEffect(
    on([() => props.id, () => info()?.targetBlock?.blockID, () => info()?.targetBlock?.decision], () => {
      setTakeoverOpen(!isGroup() && info()?.targetBlock?.decision === "pending")
    }),
  )
  onCleanup(
    listen((_directory, event) => {
      if (event.type !== "config.updated" || isGroup()) return
      const id = props.id
      const directory = dir()
      void call(client(directory).session.get({ sessionID: id }))
        .then((value) => {
          if (id === props.id && directory === dir()) updatedSession(value)
        })
        .catch(() => undefined)
    }),
  )
  const decideTakeover = async (decision: "accept" | "decline") => {
    const current = info()
    const block = current?.targetBlock
    if (!current || !block) return
    const sessionID = current.id
    const blockID = block.blockID
    const expectedTargetRevision = current.targetRevision ?? 0
    const directory = dir()
    const currentDialog = () =>
      props.id === sessionID &&
      dir() === directory &&
      info()?.targetBlock?.blockID === blockID &&
      (info()?.targetRevision ?? 0) === expectedTargetRevision
    try {
      const value = await call(
        client(directory).session.takeover({ sessionID, decision, expectedTargetRevision, blockID }),
      )
      if (!currentDialog()) return
      updatedSession(value)
      setTakeoverOpen(false)
    } catch (error) {
      if (!currentDialog()) return
      if ((error as Error & { status?: number }).status !== 409) throw error
      const value = await call(client(directory).session.get({ sessionID }))
      if (!currentDialog()) return
      updatedSession(value)
      setTakeoverOpen(value.targetBlock?.decision === "pending")
    }
  }
  /** Worktree directory, when the conversation runs in a worktree */
  const worktree = () => {
    const value = info()
    return value && folder()?.project?.vcs === "git" && !sameDir(value.directory, props.directory)
      ? value.directory
      : undefined
  }
  const requests = createMemo(() => pending(props.id))
  const running = () => busy(props.id)
  const group = groupState({ sessionID: () => props.id, directory: dir, enabled: isGroup })
  /** Members working right now; only the latest turn can have running delegations */
  const busySeats = createMemo(() => {
    const list = messagesOf(props.id)
    const start = list.findLastIndex((message) => message.role === "user")
    return working(
      list.slice(start + 1).flatMap((message) => partsOf(message.id)),
      running(),
    )
  })
  /** The member a permission request or question comes from, in a group */
  const from = (request: { tool?: { callID: string } }) => {
    const current = group.group()
    if (!current) return undefined
    const parts = messagesOf(props.id).flatMap((message) => partsOf(message.id))
    return askedBy(request.tool?.callID, parts, current.seats, group.products())
  }
  const collapse = (collapsed: boolean) => {
    setUi("membersCollapsed", collapsed)
    saveLayout()
  }
  const openMember = (request: { target: string; at: number }) => {
    collapse(false)
    setOpening(request)
  }

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
    <Frame
      sessionID={props.id}
      directory={dir()}
      folder={props.directory}
      title={
        <>
          <Show when={info()?.parentID}>
            {(parent) => (
              <button class="button ghost sm no-drag" onClick={() => navigate(sessionPath(props.directory, parent()))}>
                <ArrowLeft class="icon icon-xs" />
                {t("conversation.backToParent")}
              </button>
            )}
          </Show>
          <span class="title ellipsis">{info()?.title ?? ""}</span>
          <Show when={group.group()}>
            {(value) => (
              <button
                class="chip outlined no-drag"
                aria-label={t("group.members", { count: value().seats.length })}
                title={ui.membersCollapsed ? t("group.expand") : t("group.collapse")}
                aria-pressed={!ui.membersCollapsed}
                onClick={() => collapse(!ui.membersCollapsed)}
              >
                <Users class="icon icon-sm" />
                {value().seats.length}
              </button>
            )}
          </Show>
          <Show when={worktree()}>
            <span class="chip outlined no-drag">
              <GitBranch class="icon icon-sm" />
              {branchOf(worktree()!) ?? ""}
              <span class="subtle">← {branchOf(props.directory) ?? ""}</span>
            </span>
            <button class="button secondary sm no-drag" onClick={() => setMerging(true)}>
              <GitMerge class="icon icon-xs" />
              {t("topbar.merge", { branch: branchOf(props.directory) ?? "" })}
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
      <div class="chat-area">
        <div class="chat-main">
          <Show when={isGroup()}>
            <GroupTodo todos={group.todos()} />
          </Show>
          <Messages
            sessionID={props.id}
            directory={dir()}
            onReviewTurn={reviewTurn}
            onReviewFile={reviewFile}
            group={
              group.group()
                ? {
                    seats: group.group()!.seats,
                    events: group.group()!.events,
                    products: group.products(),
                    onOpenSession: (id) => navigate(sessionPath(props.directory, id)),
                    onOpenMember: (id) => openMember({ target: id, at: Date.now() }),
                  }
                : undefined
            }
          />
          <div class="dock">
            <div class="dock-inner">
              <Show when={!historyLocked(props.id) && !running() && (info()?.undoRedo?.stack.length ?? 0) > 0}>
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
                {(request) => (
                  <Approval
                    request={request()}
                    more={requests().permissions.length - 1}
                    directory={dir()}
                    from={from(request())}
                  />
                )}
              </Show>
              <Show when={!requests().permissions.length && requests().questions[0]}>
                {(request) => <Question request={request()} directory={dir()} from={from(request())} />}
              </Show>
              <Show when={!isGroup() && (external() || info()?.takeover)}>
                <div class="conversation-target-status subtle" role="status">
                  <span>{external() ? (product()?.title ?? info()?.targetBlock?.productID) : "MerakCode"}</span>
                  <Show when={external() && product()?.connected && product()?.capabilities.textStreaming === false}>
                    <span>{t("conversation.outputOnCompletion")}</span>
                  </Show>
                  <Show when={info()?.targetBlock}>
                    <span>{t("conversation.takeover.blocked")}</span>
                    <button class="button ghost sm" onClick={() => setTakeoverOpen(true)}>
                      {t("conversation.takeover.accept")}
                    </button>
                  </Show>
                  <Show when={info()?.takeover && !external()}>
                    <span>{t("conversation.takeover.completed")}</span>
                  </Show>
                </div>
              </Show>
              <Show when={info()?.readOnlyReason}>
                <p class="subtle" role="status">
                  {t("conversation.external.readOnly")}
                </p>
              </Show>
              <Composer
                disabled={switching(dir()) || inputLocked()}
                external={external()}
                sessionID={props.id}
                directory={props.directory}
                busy={running()}
                compact
                autofocus
                placeholder={isGroup() ? t("group.placeholder") : undefined}
                seats={group.group()?.seats}
                products={isGroup() ? group.products() : undefined}
                onSubmit={(submission) => send(props.id, props.directory, submission)}
                onStop={() => void stop(props.id, props.directory)}
                onMode={(mode) => {
                  choose(props.id, props.directory, { mode })
                  void call(
                    client(dir()).session.setPermissionMode({ sessionID: props.id, permissionMode: mode }),
                  ).catch((error: Error) =>
                    toast({ kind: "error", title: t("error.request", { message: error.message }), error: error }),
                  )
                }}
              />
            </div>
          </div>
        </div>
        <Show when={group.group()}>
          {(value) => (
            <MemberColumn
              sessionID={props.id}
              directory={dir()}
              group={value()}
              products={group.products()}
              busy={(seatID) => busySeats().has(seatID)}
              collapsed={ui.membersCollapsed}
              onCollapsed={collapse}
              open={opening()}
              onOpen={openMember}
            />
          )}
        </Show>
      </div>
      <Show when={!isGroup() && takeoverOpen() && info()?.targetBlock?.blockID} keyed>
        {(_blockID) => (
          <TakeoverDialog
            open={takeoverOpen()}
            productTitle={product()?.title ?? info()?.targetBlock?.productID ?? ""}
            onDecision={decideTakeover}
          />
        )}
      </Show>
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
          branch={branchOf(props.directory) ?? ""}
        />
        <Confirm
          open={discarding()}
          title={t("worktree.discardTitle")}
          description={t("worktree.discardDetail", { branch: branchOf(worktree()!) ?? "" })}
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
  )
}
