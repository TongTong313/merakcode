import ArrowUpFromLine from "lucide-solid/icons/arrow-up-from-line"
import GitCommitHorizontal from "lucide-solid/icons/git-commit-horizontal"
import Sparkles from "lucide-solid/icons/sparkles"
import Terminal from "lucide-solid/icons/terminal"
import { createSignal, Show, type JSX } from "solid-js"
import { t } from "../../i18n"
import { call, client } from "../../state/client"
import { refreshVcs, state } from "../../state/store"
import { Confirm } from "../../ui/dialog"
import { toast } from "../../ui/toast"
import { dangerousGit, splitGitArgs } from "./git-command"

const fail = (message: string) => toast({ kind: "error", title: message })

function Guard(props: { reason?: string; children: JSX.Element }) {
  return (
    <span class="commit-guard" title={props.reason}>
      {props.children}
    </span>
  )
}

/**
 * Commit and push for the review bar. Commit in the unstaged scope includes every working tree change. Push stays
 * visible: it is enabled when a remote exists and the branch is ahead, or when it has never been published.
 */
export function Commit(props: { directory: string; all: boolean; pending?: boolean; onDone: () => void }) {
  const [message, setMessage] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [commandOpen, setCommandOpen] = createSignal(false)
  const [command, setCommand] = createSignal("")
  const [output, setOutput] = createSignal<string>()
  const [ask, setAsk] = createSignal(false)
  const [pendingArgs, setPendingArgs] = createSignal<string[]>([])
  const info = () => state.remote[props.directory]
  const branch = () => state.branch[props.directory] || ""

  const hasChanges = () => {
    if (props.pending) return true
    const current = info()
    if (!current || current.staged === undefined) return true
    const total = props.all ? current.staged + (current.unstaged ?? 0) + (current.untracked ?? 0) : current.staged
    return total > 0
  }

  const commitReason = () => {
    if (!message().trim()) return t("review.commitNeedMessage")
    if (!hasChanges()) return t("review.commitNothing")
    if (props.all) return t("review.commitAllHint")
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
    setBusy(true)
    const result = await call(client(props.directory).assist.commit.message()).catch((error: Error) => ({
      message: "",
      error: error.message,
    }))
    setBusy(false)
    if (result.message) setMessage(result.message)
    if (result.error) fail(result.error)
  }

  const commit = async () => {
    if (!message().trim() || !hasChanges()) return
    setBusy(true)
    const result = await call(client(props.directory).vcs.commit({ message: message(), all: props.all })).catch(
      (error: Error) => ({ ok: false as const, error: error.message }),
    )
    setBusy(false)
    if (!result.ok) return fail(result.error)
    setMessage("")
    toast({ kind: "success", title: t("review.committed", { hash: result.hash }) })
    await refreshVcs(props.directory)
    props.onDone()
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

  const execute = async (args: string[]) => {
    setBusy(true)
    const result = await call(client(props.directory).vcs.run({ args })).catch((error: Error) => {
      fail(t("review.quickFailed", { message: error.message }))
      return undefined
    })
    setBusy(false)
    if (!result) return
    setOutput(result.output || t("review.quickEmpty"))
    if (result.exitCode === 0) await refreshVcs(props.directory)
  }

  const submitCommand = () => {
    const args = splitGitArgs(command())
    if (!args.length || busy()) return
    if (dangerousGit(args)) {
      setPendingArgs(args)
      setAsk(true)
      return
    }
    void execute(args)
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
          disabled={busy()}
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
        <button class="button ghost sm" disabled={busy()} onClick={() => setCommandOpen((value) => !value)}>
          <Terminal class="icon icon-xs" />
          {t("review.quickCommand")}
        </button>
      </div>
      <Show when={commandOpen()}>
        <div class="git-command">
          <span class="git-prefix">git</span>
          <input
            class="input"
            aria-label={t("review.quickCommand")}
            placeholder={t("review.quickPlaceholder")}
            value={command()}
            onInput={(event) => setCommand(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submitCommand()
            }}
          />
          <button class="button secondary sm" disabled={busy() || !command().trim()} onClick={submitCommand}>
            {t("review.quickRun")}
          </button>
        </div>
      </Show>
      <Show when={output() !== undefined}>
        <pre class="git-output">{output()}</pre>
      </Show>
      <Confirm
        open={ask()}
        danger
        title={t("review.quickConfirm")}
        description={t("review.quickConfirmDetail", { command: pendingArgs().join(" ") })}
        confirm={t("review.quickRun")}
        cancel={t("common.cancel")}
        onResult={(ok) => {
          const args = pendingArgs()
          setAsk(false)
          if (ok) void execute(args)
        }}
      />
    </div>
  )
}
