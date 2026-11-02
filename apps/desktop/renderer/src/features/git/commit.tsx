import ArrowUpFromLine from "lucide-solid/icons/arrow-up-from-line"
import GitCommitHorizontal from "lucide-solid/icons/git-commit-horizontal"
import Sparkles from "lucide-solid/icons/sparkles"
import { createSignal, onCleanup, type JSX } from "solid-js"
import { t } from "../../i18n"
import { call, client } from "../../state/client"
import { branchOf, refreshVcs, state } from "../../state/store"
import { switching } from "../../state/git"
import { panels } from "../panel/workspace"
import { toast } from "../../ui/toast"

const fail = (message: string) => toast({ kind: "error", title: message })

function Guard(props: { reason?: string; children: JSX.Element }) {
  return (
    <span class="commit-guard" title={props.reason}>
      {props.children}
    </span>
  )
}

/** Commits only the Git index; each Git tab owns its draft. */
export function Commit(props: {
  directory: string
  instanceID?: string
  pending?: boolean
  working?: boolean
  onWorkingChange?: (working: boolean) => void
  onDone: () => void | Promise<void>
}) {
  const owner = panels()
  const stored = owner?.view(props.instanceID ?? "").commit
  const [message, updateMessage] = createSignal(typeof stored === "string" ? stored : "")
  let disposed = false
  let localRevision = 0
  onCleanup(() => {
    disposed = true
  })
  const revision = () => (props.instanceID ? (owner?.view(props.instanceID).commitRevision ?? 0) : localRevision)
  const setMessage = (value: string) => {
    const next = Number(revision()) + 1
    localRevision = next
    updateMessage(value)
    if (props.instanceID) void owner?.patchView(props.instanceID, { commit: value, commitRevision: next })
  }
  const [working, setWorking] = createSignal(false)
  const setBusy = (value: boolean) => {
    setWorking(value)
    props.onWorkingChange?.(value)
  }
  const busy = () => working() || props.working || switching(props.directory)
  const info = () => state.remote[props.directory]
  const branch = () => branchOf(props.directory) || ""

  const hasChanges = () => props.pending ?? (info()?.staged ?? 0) > 0

  const commitReason = () => {
    if (!message().trim()) return t("review.commitNeedMessage")
    if (!hasChanges()) return t("review.commitNothing")
  }

  const pushReason = () => {
    const current = info()
    const name = branch()
    if (!current) return t("review.pushUnavailable")
    if (!name || name === "HEAD") return t("review.pushNoBranch")
    if (!current.name) return t("review.pushNoRemote")
    if (current.ahead === 0) return t("review.pushNothing")
    if (current.ahead === undefined) return t("review.pushUpstream", { remote: current.name })
  }

  const canPush = () => {
    const current = info()
    const name = branch()
    if (!current?.name || !name || name === "HEAD") return false
    return current.ahead !== 0
  }

  const pushLabel = () => (info()?.ahead ? t("review.pushCount", { count: info()!.ahead! }) : t("review.push"))

  const generate = async () => {
    if (busy() || !hasChanges()) return
    const version = revision()
    setBusy(true)
    const result = await call(client(props.directory).assist.commit.message()).catch((error: Error) => ({
      message: "",
      error: error.message,
    }))
    setBusy(false)
    if (disposed || revision() !== version) return
    if (result.message) setMessage(result.message)
    if (result.error) fail(result.error)
  }

  const commit = async () => {
    if (busy() || !message().trim() || !hasChanges()) return
    const version = revision()
    setBusy(true)
    const result = await call(client(props.directory).vcs.commit({ message: message(), all: false })).catch(
      (error: Error) => ({ ok: false as const, error: error.message }),
    )
    if (!result.ok) {
      setBusy(false)
      return fail(result.error)
    }
    if (revision() === version) setMessage("")
    await refreshVcs(props.directory)
    await props.onDone()
    setBusy(false)
    toast({ kind: "success", title: t("review.committed", { hash: result.hash }) })
  }

  const push = async () => {
    if (busy() || !canPush()) return
    setBusy(true)
    const result = await call(client(props.directory).vcs.push()).catch((error: Error) => ({
      ok: false as const,
      error: error.message,
    }))
    setBusy(false)
    if (!result.ok) return fail(t("review.pushFailed", { message: result.error }))
    toast({ kind: "success", title: t("review.pushed", { remote: result.remote, branch: result.branch }) })
    await refreshVcs(props.directory)
  }

  return (
    <div class="commit">
      <p class="vcs-summary">
        {branch() || "—"}
        {" · "}
        {t("review.ahead", { count: info()?.ahead ?? 0 })}
        {" · "}
        {t("review.behind", { count: info()?.behind ?? 0 })}
        {" · "}
        {t("review.stagedCount", { count: info()?.staged ?? 0 })}
        {" · "}
        {t("review.unstagedCount", { count: info()?.unstaged ?? 0 })}
        {" · "}
        {t("review.untrackedCount", { count: info()?.untracked ?? 0 })}
      </p>
      <div class="commit-input">
        <textarea
          class="input"
          rows={1}
          aria-label={t("review.commitMessage")}
          placeholder={t("review.commitPlaceholder")}
          value={message()}
          onInput={(event) => setMessage(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && message().trim() && hasChanges())
              void commit()
          }}
        />
        <button
          class="icon-button"
          aria-label={t("review.generate")}
          title={t("review.generate")}
          disabled={busy() || !hasChanges()}
          onClick={() => void generate()}
        >
          <Sparkles class="icon icon-sm" />
        </button>
      </div>
      <div class="row">
        <Guard reason={commitReason()}>
          <button
            class="button primary sm"
            disabled={busy() || !message().trim() || !hasChanges()}
            onClick={() => void commit()}
          >
            <GitCommitHorizontal class="icon icon-xs" />
            {t("review.commit")}
          </button>
        </Guard>
        <Guard reason={pushReason()}>
          <button class="button secondary sm" disabled={busy() || !canPush()} onClick={() => void push()}>
            <ArrowUpFromLine class="icon icon-xs" />
            {pushLabel()}
          </button>
        </Guard>
      </div>
    </div>
  )
}
