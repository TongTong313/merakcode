import ArrowUpFromLine from "lucide-solid/icons/arrow-up-from-line"
import GitCommitHorizontal from "lucide-solid/icons/git-commit-horizontal"
import Sparkles from "lucide-solid/icons/sparkles"
import { createSignal, onCleanup, Show, For, type JSX } from "solid-js"
import { t } from "../../i18n"
import { client } from "../../state/client"
import { checkoutOf, switching } from "../../state/git"
import { changesOf } from "./changes"
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
  const alternatives = () => {
    const value = owner?.view(props.instanceID ?? "").commitAlternatives
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && !!item.trim()) : []
  }
  let disposed = false
  let localRevision = 0
  onCleanup(() => {
    disposed = true
    // Persist the live draft before this instance is torn down by a tab switch or data refresh.
    if (props.instanceID) {
      const next = Math.max(Number(revision()), localRevision)
      void owner?.patchView(props.instanceID, { commit: message(), commitRevision: next })
    }
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
  const info = () => changesOf(props.directory)
  const branch = () => checkoutOf(props.directory)?.split(":")[0] ?? ""

  const hasChanges = () => props.pending ?? (info()?.staged.length ?? 0) > 0

  const commitReason = () => {
    if (!message().trim()) return t("review.commitNeedMessage")
    if (!hasChanges()) return t("review.commitNothing")
  }

  const pushReason = () => {
    const current = info()
    const name = branch()
    if (!current) return t("review.pushUnavailable")
    if (!name || name === "HEAD") return t("review.pushNoBranch")
    if (!current.remote) return t("review.pushNoRemote")
    if (current.upstream && current.ahead === 0) return t("review.pushNothing")
    if (!current.upstream) return t("review.pushUpstream", { remote: current.remote })
  }

  const canPush = () => {
    const current = info()
    const name = branch()
    if (!current?.remote || !name || name === "HEAD") return false
    return !current.upstream || current.ahead !== 0
  }

  const pushLabel = () => (info()?.ahead ? t("review.pushCount", { count: info()?.ahead ?? 0 }) : t("review.push"))

  const generate = async () => {
    if (busy() || !hasChanges()) return
    const version = revision()
    setBusy(true)
    const result = await client()
      .then((connection) => connection.repo.commitMessage({ directory: props.directory }))
      .catch((error: Error) => ({ message: "", error: error.message }))
    setBusy(false)
    if (disposed || revision() !== version) return
    if (result.message) setMessage(result.message)
    if ("error" in result) fail(result.error)
  }

  const commit = async () => {
    if (busy() || !message().trim() || !hasChanges()) return
    const version = revision()
    setBusy(true)
    const result = await client()
      .then((connection) => connection.repo.commit({ directory: props.directory, message: message(), staged: true }))
      .catch((error: Error) => ({ error: error.message }))
    if ("error" in result) {
      setBusy(false)
      return fail(result.error)
    }
    if (revision() === version) setMessage("")
    await props.onDone()
    setBusy(false)
    toast({ kind: "success", title: t("review.committed", { hash: result.commit.slice(0, 7) }) })
  }

  const push = async () => {
    if (busy() || !canPush()) return
    setBusy(true)
    const remote = info()?.remote ?? ""
    const result = await client()
      .then((connection) => connection.repo.push({ directory: props.directory }))
      .then(() => ({}))
      .catch((error: Error) => ({ error: error.message }))
    setBusy(false)
    if ("error" in result) return fail(t("review.pushFailed", { message: result.error }))
    toast({ kind: "success", title: t("review.pushed", { remote, branch: branch() }) })
    await props.onDone()
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
        {t("review.stagedCount", { count: info()?.staged.length ?? 0 })}
        {" · "}
        {t("review.unstagedCount", {
          count: info()?.unstaged.filter((file) => file.status !== "untracked").length ?? 0,
        })}
        {" · "}
        {t("review.untrackedCount", {
          count: info()?.unstaged.filter((file) => file.status === "untracked").length ?? 0,
        })}
      </p>
      <Show when={alternatives().length}>
        <select
          class="input"
          aria-label={t("panel.recoveredCommits")}
          value=""
          onChange={(event) => {
            const selected = alternatives()[Number(event.currentTarget.value)]
            if (selected === undefined || !props.instanceID) return
            const remaining = [...new Set([...alternatives().filter((value) => value !== selected), message()])].filter(
              (value) => value.trim(),
            )
            void owner?.patchView(props.instanceID, { commitAlternatives: remaining })
            setMessage(selected)
            event.currentTarget.value = ""
          }}
        >
          <option value="" disabled>
            {t("panel.recoveredCommits")}
          </option>
          <For each={alternatives()}>{(value, index) => <option value={index()}>{value}</option>}</For>
        </select>
      </Show>
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
