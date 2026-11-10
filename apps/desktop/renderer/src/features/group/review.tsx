import type { BoardCard, EngineEvent, GroupMember, WorkspacePublished } from "@merakcode/sdk"
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { z } from "zod"
import { t } from "../../i18n"
import { client } from "../../state/client"
import { localHuman } from "../../state/groups"
import { toast } from "../../ui/toast"
import { Report } from "./report"
import { ReviewFiles } from "../review/review"
import { ReviewTree } from "../review/tree"
import { clearComments, commentMessage, commentsOf, review, useReview } from "../review/state"
import { sameDir } from "../../lib/route"
import { CommentSummary } from "../review/comments"
import { CommentDrafts } from "../review/compose"
import { Markdown } from "../../ui/markdown"
import { conflictFiles } from "./conflicts"
import { ClaimProcess } from "./process"

function artifactPath(path: string) {
  const parts: string[] = []
  for (const part of path.replaceAll("\\", "/").split("/")) {
    if (part === "..") parts.pop()
    else if (part && part !== ".") parts.push(part)
  }
  return parts.join("/")
}

function TaskDiff(props: { directory: string; base: string; session?: string }) {
  const [focus, setFocus] = createSignal<string>()
  createEffect(() => {
    const target = review.reveal
    if (target && target.sessionID === props.session && sameDir(target.directory, props.directory))
      setFocus(review.focus)
  })
  const data = useReview(
    () => props.session,
    () => props.directory,
    () => true,
    () => props.base,
  )
  return (
    <div class="task-review-diff">
      <ReviewTree files={data.data()?.files ?? []} onOpen={(file) => setFocus(file.file)} />
      <ReviewFiles directory={props.directory} data={data} style="unified" sessionID={props.session} focus={focus} />
      <CommentDrafts
        directory={props.directory}
        sessionID={props.session}
        files={data.data()?.files.map((file) => file.file)}
      />
    </div>
  )
}

export function TaskReview(props: {
  card: BoardCard
  cards?: BoardCard[]
  events: EngineEvent[]
  members: GroupMember[]
  directory?: string
  onBack: () => void
}) {
  const [busy, setBusy] = createSignal(false)
  const [feedback, setFeedback] = createSignal("")
  const [downloading, setDownloading] = createSignal("")
  const cards = createMemo(() => {
    const ids = new Set([props.card.id])
    const available = props.cards ?? [props.card]
    for (let previous = 0; previous !== ids.size;) {
      previous = ids.size
      for (const card of available) if (card.parent && ids.has(card.parent)) ids.add(card.id)
    }
    return [props.card, ...available.filter((card) => card.id !== props.card.id && ids.has(card.id))]
  })
  const claimIDs = () => cards().flatMap((card) => (card.claims ?? []).map((claim) => claim.id))
  const claimCard = (id: string) => cards().find((card) => card.claims?.some((claim) => claim.id === id))!
  const claimOf = (id: string) => claimCard(id).claims!.find((claim) => claim.id === id)!
  const published = (claim: string, path: string) =>
    claimCard(claim).artifacts?.find(
      (artifact) =>
        artifact.claim === claim &&
        artifact.path === `${artifact.id}/${artifactPath(path)}` &&
        claimOf(claim).published?.includes(artifact.id),
    )
  const unpublished = () =>
    cards().some(
      (card) =>
        card.workspace === "folder" &&
        card.claims?.some((claim) => claim.report?.artifacts?.some((artifact) => !published(claim.id, artifact.path))),
    )
  const download = async (artifact: WorkspacePublished) => {
    if (downloading()) return
    setDownloading(artifact.id)
    try {
      const bytes = await (await client()).blob.get(`mrk://blob/${artifact.id}`)
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" }))
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = artifact.path.split(/[\\/]/).at(-1) || "artifact"
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (error) {
      toast({ kind: "error", title: t("error.request", { message: "MRK-6001" }), error })
    } finally {
      setDownloading("")
    }
  }
  createEffect(
    on(
      () => props.card.id,
      () => setFeedback(""),
    ),
  )
  const comments = () => [
    ...claimIDs().flatMap((id) => commentsOf(claimOf(id).session, workspace(id)?.directory)),
    ...commentsOf(`task:${props.card.id}`, props.directory),
  ]
  const consolidated = () => !props.card.parent && props.card.phase === "review" && props.card.base && props.directory
  const planning = () => !props.card.parent && props.card.phase === "planning" && props.card.planPending
  const canReplan = () => !props.card.parent && (planning() || props.card.phase === "review")
  const decide = async (decision: "approve" | "rework" | "replan") => {
    if (busy()) return
    const task = props.card.id
    const submitted = comments()
    const text = [feedback().trim(), submitted.length ? commentMessage(submitted) : ""].filter(Boolean).join("\n\n")
    const parsed = z
      .object({ feedback: decision === "approve" ? z.string() : z.string().min(1) })
      .safeParse({ feedback: text })
    if (!parsed.success || submitted.some((comment) => comment.stale)) return
    const original = feedback()
    setBusy(true)
    try {
      await (await client()).task.review({ task, human: localHuman, decision, feedback: parsed.data.feedback })
      for (const session of new Set(submitted.map((comment) => comment.sessionID))) clearComments(session, submitted)
      if (props.card.id === task && feedback() === original) setFeedback("")
    } catch (error) {
      toast({ kind: "error", title: t("error.request", { message: "MRK-6001" }), error })
    } finally {
      setBusy(false)
    }
  }
  const workspace = (id: string) =>
    props.events
      .flatMap((event) =>
        (event.type === "workspace.created" || event.type === "workspace.released") && event.payload.claim === id
          ? [event.payload]
          : [],
      )
      .at(-1)
  const returned = () =>
    props.events
      .filter(
        (event) =>
          event.type === "task.reviewed" &&
          event.scope.task === props.card.id &&
          event.payload.lastReview?.decision === "rework",
      )
      .at(-1)
  const received = () => {
    const returnedEvent = returned()
    if (!returnedEvent) return []
    return [
      ...new Set(
        props.events.flatMap((event) =>
          event.type === "task.started" &&
          cards().some((card) => card.id === event.scope.task) &&
          (event.seq ?? 0) > (returnedEvent.seq ?? 0)
            ? (event.payload.claims ?? []).filter((claim) => claim.status === "active").map((claim) => claim.member)
            : [],
        ),
      ),
    ]
  }
  return (
    <section class="task-review scroll" aria-label={t("task.review.title")}>
      <button class="button ghost" onClick={props.onBack}>
        {t("task.board")}
      </button>
      <h2>{props.card.title}</h2>
      <Show when={conflictFiles(props.card, props.cards ?? [props.card]).length}>
        <section aria-label={t("task.review.conflicts")}>
          <h3>{t("task.review.conflicts")}</h3>
          <ul>
            <For each={conflictFiles(props.card, props.cards ?? [props.card])}>
              {(file) => (
                <li>
                  <code>{file}</code>
                </li>
              )}
            </For>
          </ul>
        </section>
      </Show>
      <Markdown text={props.card.description} />
      <Show when={props.card.acceptance?.length}>
        <ul>
          <For each={props.card.acceptance}>{(item) => <li>{item}</li>}</For>
        </ul>
      </Show>
      <For each={claimIDs()}>
        {(id) => {
          const claim = () => claimOf(id)
          return (
            <section>
              <Show when={claimCard(id).id !== props.card.id}>
                <h3>{claimCard(id).title}</h3>
              </Show>
              <h3>{props.members.find((member) => member.id === claim().member)?.name ?? claim().member}</h3>
              <Show when={claim().report}>{(report) => <Report report={report()} />}</Show>
              <For each={claim().report?.artifacts}>
                {(artifact) => (
                  <div class="review-artifact">
                    <span>
                      {artifact.title} <code>{artifact.path}</code>
                    </span>
                    <Show
                      when={published(id, artifact.path)}
                      fallback={<span class="subtle">{t("task.review.unpublished")}</span>}
                    >
                      {(file) => (
                        <button
                          class="button secondary sm"
                          aria-label={t("task.review.download", { title: artifact.title || artifact.path })}
                          disabled={!!downloading()}
                          onClick={() => void download(file())}
                        >
                          {t("common.download")}
                        </button>
                      )}
                    </Show>
                  </div>
                )}
              </For>
              <Show when={claim().session && (workspace(id)?.directory || props.directory)}>
                <ClaimProcess session={claim().session!} directory={workspace(id)?.directory ?? props.directory!} />
              </Show>
            </section>
          )
        }}
      </For>
      <Show
        when={consolidated()}
        fallback={
          <For each={claimIDs()}>
            {(id) => (
              <Show
                when={workspace(id)?.released}
                fallback={
                  <Show when={claimCard(id).base && workspace(id)}>
                    <TaskDiff
                      directory={workspace(id)!.directory}
                      base={claimCard(id).base!}
                      session={claimOf(id).session}
                    />
                  </Show>
                }
              >
                <p class="subtle">{t("task.review.released")}</p>
              </Show>
            )}
          </For>
        }
      >
        <TaskDiff directory={props.directory!} base={props.card.base!} session={`task:${props.card.id}`} />
      </Show>
      <For each={received()}>
        {(member) => (
          <p role="status">
            {t("task.review.received", { name: props.members.find((item) => item.id === member)?.name ?? member })}
          </p>
        )}
      </For>
      <Show when={returned()}>
        {(event) => (
          <Show when={event().type === "task.reviewed" && props.card.lastReview?.feedback}>
            <Markdown text={props.card.lastReview!.feedback!} />
          </Show>
        )}
      </Show>
      <Show when={props.card.lastReview?.decision === "approve"}>
        <p role="status">{t("task.review.approved")}</p>
      </Show>
      <Show when={props.card.lastReview?.decision === "replan"}>
        <p role="status">{t("task.review.replanned")}</p>
        <Markdown text={props.card.lastReview?.feedback ?? ""} />
      </Show>
      <Show when={planning() || (props.card.status === "review" && props.card.lastReview?.decision !== "approve")}>
        <For each={comments()}>{(comment) => <CommentSummary comment={comment} />}</For>
        <label>
          {t("task.review.feedback")}
          <textarea
            class="input"
            aria-label={t("task.review.feedback")}
            value={feedback()}
            onInput={(event) => setFeedback(event.currentTarget.value)}
          />
        </label>
        <button
          class="button primary"
          disabled={busy() || unpublished() || comments().some((comment) => comment.stale)}
          onClick={() => void decide("approve")}
        >
          {t("task.review.approve")}
        </button>
        <button
          class="button secondary"
          disabled={busy() || (!feedback().trim() && !comments().length) || comments().some((comment) => comment.stale)}
          onClick={() => void decide("rework")}
        >
          {t("task.review.rework")}
        </button>
        <Show when={canReplan()}>
          <button
            class="button secondary"
            disabled={
              busy() || (!feedback().trim() && !comments().length) || comments().some((comment) => comment.stale)
            }
            onClick={() => void decide("replan")}
          >
            {t("task.review.replan")}
          </button>
        </Show>
      </Show>
    </section>
  )
}
