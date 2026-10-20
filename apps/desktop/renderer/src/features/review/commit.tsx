import ArrowUpFromLine from "lucide-solid/icons/arrow-up-from-line"
import GitCommitHorizontal from "lucide-solid/icons/git-commit-horizontal"
import Sparkles from "lucide-solid/icons/sparkles"
import { createSignal, Show } from "solid-js"
import { t } from "../../i18n"
import { call, client } from "../../state/client"
import { refreshVcs, state } from "../../state/store"
import { toast } from "../../ui/toast"

const fail = (message: string) => toast({ kind: "error", title: message })

/**
 * Commit and push. In the staged scope "Commit" commits only staged changes; in the unstaged scope "Commit all" also
 * includes unstaged ones. With a remote, changes can be pushed (the button shows how many commits are unpushed).
 */
export function Commit(props: { directory: string; all: boolean; onDone: () => void }) {
  const [message, setMessage] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const remote = () => state.remote[props.directory]

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
      <div class="commit-input">
        <textarea
          class="input"
          rows={1}
          aria-label={t("review.commitMessage")}
          placeholder={t("review.commitPlaceholder")}
          value={message()}
          onInput={(event) => setMessage(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && message().trim()) void commit()
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
        <button class="button primary sm" disabled={busy() || !message().trim()} onClick={() => void commit()}>
          <GitCommitHorizontal class="icon icon-xs" />
          {props.all ? t("review.commitAll") : t("review.commit")}
        </button>
        <Show when={remote()?.name}>
          <button class="button secondary sm" disabled={busy()} onClick={() => void push()}>
            <ArrowUpFromLine class="icon icon-xs" />
            {remote()?.ahead ? t("review.pushCount", { count: remote()!.ahead! }) : t("review.push")}
          </button>
        </Show>
      </div>
    </div>
  )
}
